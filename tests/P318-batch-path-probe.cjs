#!/usr/bin/env node
'use strict';
// Read-only source audit. All HTTP calls are captured by an in-memory fake.
// Only the explicitly supplied output directory is written.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const cp = require('node:child_process');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--help') {
    console.log('node P318-batch-path-probe.cjs --core FILE --sync FILE --recover FILE --dataset FILE --batch-archive FILE --output DIRECTORY [--expect closed|observe]');
    console.log('closed: reject the original two path counterexamples, reject one bad stored-queue ID before new-batch requests, and restore all five original batches. No network.');
    process.exit(0);
  }
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw Error('Expected --name value arguments');
  const key = process.argv[i].slice(2);
  args[key] = key === 'expect' ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
}
for (const k of ['core', 'sync', 'recover', 'dataset', 'batch-archive', 'output']) {
  if (!args[k]) throw Error('Required: --core --sync --recover --dataset --batch-archive --output');
}
args.expect ??= 'observe';
if (!['observe', 'closed'].includes(args.expect)) throw Error('--expect must be closed or observe');
fs.mkdirSync(args.output, {recursive: true});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => fs.readFileSync(args[name]);
const clone = value => JSON.parse(JSON.stringify(value));
const write = (name, value) => {
  const p = path.join(args.output, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
  return p;
};
const before = Object.fromEntries(['core', 'sync', 'recover', 'dataset', 'batch-archive'].map(k => [k, sha(read(k))]));
const Core = require(args.core);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function containsExact(value, target) {
  if (canonical(value) === canonical(target)) return true;
  return Boolean(value && typeof value === 'object' && Object.values(value).some(child => containsExact(child, target)));
}
const syncSource = read('sync').toString('utf8');
const dataset = JSON.parse(read('dataset'));
const archive = JSON.parse(read('batch-archive'));
const base = clone(archive[0].data);
base.entries = [base.entries[0]];
const fixed = '2026-11-25T20:00:00.000Z';
const apiBase = 'https://api.github.com/repos/Teddytututu/qwen-teacher-review';
const apiContents = new URL(apiBase + '/contents/').pathname;
class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
async function replaySync(backup, {initialQueue = null, flushAll = false} = {}) {
  const localStorage = new MemoryStorage(), sessionStorage = new MemoryStorage();
  sessionStorage.setItem('qwen-review-gh-token:test', 'P318-offline-dummy-token');
  const queueKey = 'qwen-github-sync:v2:test:' + dataset.dataset_id;
  const originalQueueRaw = initialQueue ? JSON.stringify(initialQueue) : null;
  if (initialQueue) localStorage.setItem(queueKey, originalQueueRaw);
  const requests = [], remote = new Map(), elements = new Map();
  let serial = 0;
  const fakeFetch = async (rawURL, options = {}) => {
    const url = new URL(rawURL), method = options.method || 'GET';
    const inside = ['batches/', 'verification-batches/'].some(prefix => url.pathname.startsWith(apiContents + prefix));
    const record = {method, raw_url: rawURL, normalized_url: url.href, normalized_path: url.pathname,
      inside_expected_annotation_folders: inside};
    requests.push(record);
    const respond = (status, data) => ({ok: status >= 200 && status < 300, status, json: async () => data});
    if (method === 'GET') {
      const data = remote.get(url.pathname);
      return data ? respond(200, data) : respond(404, {message: 'P318 fake: file absent'});
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body);
      record.branch = body.branch;
      record.content_sha256 = sha(Buffer.from(body.content, 'base64'));
      const content = {content: body.content, sha: sha(body.content), html_url: 'https://example.invalid/P318-fake-receipt'};
      remote.set(url.pathname, content);
      return respond(201, {content: {sha: content.sha}});
    }
    throw Error('Unexpected fake method: ' + method);
  };
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : [fixed])); }
    static now() { return Date.parse(fixed); }
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, {textContent: '', dataset: {}, disabled: false}); return elements.get(id); },
    addEventListener() {}
  };
  const window = {QwenReviewCore: Core, QWEN_REVIEW_CONFIG: {apiBase, fetch: fakeFetch}, addEventListener() {}};
  const context = vm.createContext({window, document, localStorage, sessionStorage,
    navigator: {locks: {request: async (name, options, callback) => callback({name})}},
    crypto: {randomUUID: () => 'P318-offline-path-' + (++serial)}, Date: FixedDate, TextEncoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'), AbortSignal: {timeout: () => undefined},
    setTimeout: () => 1, setInterval: () => 1, clearTimeout() {}, clearInterval() {},
    fetch: () => { throw Error('Real network is forbidden in this probe'); }});
  vm.runInContext(syncSource, context, {filename: args.sync});
  await window.reviewSync.configure(dataset, {isTest: true});
  const restored = backup ? await window.reviewSync.restore(backup) : null;
  const flushes = [await window.reviewSync.flush()];
  if (flushAll) {
    // Bound the loop by the original five-batch fixture; there is no timer-driven retry.
    for (let i = 1; i < 5; i++) {
      const q = window.reviewSync.backup().queue;
      if (!q.batch && !q.recovered_batches.length) break;
      flushes.push(await window.reviewSync.flush());
    }
  }
  return {restored, flushed: flushes[0] ?? null, flushes, requests, summary: window.reviewSync.summary(),
    preserved_queue: window.reviewSync.backup(), network_requests: 0,
    ...(initialQueue ? {initial_queue_raw: originalQueueRaw, stored_queue_raw_after: localStorage.getItem(queueKey),
      initial_queue_bytes_preserved: localStorage.getItem(queueKey) === originalQueueRaw} : {}),
    explanation: 'requests are fake-function invocations; no socket or real fetch is used'};
}
function envelope(batch, changed) {
  return {schema_version: 2, dataset_id: dataset.dataset_id, source_manifest_sha256: dataset.source_manifest_sha256,
    is_test: true, history: [],
    P318_probe: {synthetic_recovery_input: true, original_archive_sha256: before['batch-archive'],
      original_batch_pointer: '/0/data', retained_entry_pointer: '/0/data/entries/0', changed_fields: changed,
      purpose: 'Offline path validation; not a human annotation or a remote batch'},
    server_sync: {schema_version: 2, dataset_id: dataset.dataset_id,
      queue: {schema_version: 2, client_id: 'P318-offline-recovery', pending: [], seen: [], confirmed: 0,
        receipts: [], recovered_batches: [batch], is_test: true}}};
}
(async () => {
  const originalIDs = archive.map((row, i) => ({pointer: '/' + i + '/data', original_path: row.path,
    client_id: row.data.client_id, batch_id: row.data.batch_id,
    client_characters: [...new Set(row.data.client_id)].sort().join(''), batch_characters: [...new Set(row.data.batch_id)].sort().join(''),
    client_uuid_form: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.data.client_id),
    batch_uuid_form: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.data.batch_id),
    proposed_safe_token_accepts_both: [row.data.client_id, row.data.batch_id].every(v => /^[A-Za-z0-9_-]+$/.test(v)),
    is_test: row.data.is_test}));
  const cases = [];
  const definitions = [
    ['P01-client-parent-segment', {client_id: '..'}],
    ['P02-batch-parent-segments', {batch_id: '../../../P318-path-probe'}]
  ];
  if (args.expect === 'observe') definitions.unshift(['P00-original-id-control', {}]);
  for (const [id, changes] of definitions) {
    const batch = {...clone(base), ...changes};
    let validation;
    try { Core.validateBatch(batch, dataset); validation = {accepted: true}; }
    catch (e) { validation = {accepted: false, error: e.message}; }
    const input = envelope(batch, changes), inputPath = write('P318-' + id + '-input.json', input);
    const output = path.join(args.output, 'P318-' + id + '-cli');
    const command = [args.recover, '--dataset', args.dataset, '--test-data', '--now', fixed, '--out', output, inputPath];
    const cli = cp.spawnSync(process.execPath, command, {encoding: 'utf8'});
    const exportPath = path.join(output, 'P318-merged-annotations.json');
    const exportValue = fs.existsSync(exportPath) ? JSON.parse(fs.readFileSync(exportPath)) : null;
    const reportPath = path.join(output, 'P318-merge-report.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath)) : null;
    const replay = exportValue?.server_sync ? await replaySync(exportValue.server_sync) : {not_run: 'CLI produced no sync backup', requests: [], network_requests: 0};
    const directReplay = await replaySync(input.server_sync);
    cases.push({id, changed_fields: changes, original_entries_retained: 1, core_validation: validation,
      raw_input: path.basename(inputPath), raw_input_sha256: sha(fs.readFileSync(inputPath)),
      cli: {exit_code: cli.status, stdout: cli.stdout, stderr: cli.stderr, command: [process.execPath, ...command],
        merge_result: report?.result ?? null, batch_errors: report?.batch_errors ?? null,
        queue_errors: report?.queue_errors ?? [],
        raw_batch_in_merged_quarantine: containsExact(exportValue?.quarantine || [], batch)},
      sync_replay: replay, direct_input_sync_replay: directReplay,
      escaped_annotation_folder: [...replay.requests, ...directReplay.requests].some(r => !r.inside_expected_annotation_folders),
      fake_put_outside_annotation_folder: [...replay.requests, ...directReplay.requests].some(r => r.method === 'PUT' && !r.inside_expected_annotation_folders)});
  }
  let queueCase = null, originals = null;
  const closureChecks = [];
  if (args.expect === 'closed') {
    const queue = {schema_version: 2, client_id: '..', pending: clone(base.entries), seen: [], confirmed: 0,
      receipts: [], recovered_batches: [], is_test: true};
    const queueInput = {is_test: true, P318_probe: 'Synthetic stored queue; tests new-batch creation, not the authorization-connection branch',
      dataset_id: dataset.dataset_id, queue};
    const queuePath = write('P318-Q01-stored-client-parent-input.json', queueInput);
    queueCase = {id: 'Q01-stored-client-parent', raw_input: path.basename(queuePath),
      raw_input_sha256: sha(fs.readFileSync(queuePath)), branch: 'stored queue -> configure -> forced new-batch flush',
      replay: await replaySync(null, {initialQueue: queue})};
    const output = path.join(args.output, 'P318-original-five-cli');
    const command = [args.recover, '--dataset', args.dataset, '--test-data', '--now', fixed, '--out', output, args['batch-archive']];
    const cli = cp.spawnSync(process.execPath, command, {encoding: 'utf8'});
    const exportPath = path.join(output, 'P318-merged-annotations.json');
    const exportValue = fs.existsSync(exportPath) ? JSON.parse(fs.readFileSync(exportPath)) : null;
    const reportPath = path.join(output, 'P318-merge-report.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath)) : null;
    const batches = exportValue?.server_sync?.queue?.recovered_batches || [];
    const batchRows = archive.map((row, i) => {
      let accepted = false, error = null;
      try { Core.validateBatch(row.data, dataset); accepted = true; } catch (e) { error = e.message; }
      const recovered = batches.find(b => b.batch_id === row.data.batch_id);
      return {pointer: '/' + i + '/data', client_id: row.data.client_id, batch_id: row.data.batch_id,
        core_accepted: accepted, error,
        original_payload_sha256: sha(JSON.stringify(row.data, null, 2) + '\n'),
        recovered_payload_sha256: recovered ? sha(JSON.stringify(recovered, null, 2) + '\n') : null,
        recovered_payload_unchanged: Boolean(recovered) && JSON.stringify(recovered, null, 2) === JSON.stringify(row.data, null, 2)};
    });
    originals = {rows: batchRows, cli: {exit_code: cli.status, stdout: cli.stdout, stderr: cli.stderr,
      command: [process.execPath, ...command], merge_result: report?.result ?? null, batch_errors: report?.batch_errors ?? null},
      sync_replay: exportValue?.server_sync ? await replaySync(exportValue.server_sync, {flushAll: true}) : null};
    for (const c of cases) closureChecks.push({id: c.id, passed: c.core_validation.accepted === false &&
      c.cli.exit_code === 3 && ((c.cli.batch_errors?.length || 0) + (c.cli.queue_errors?.length || 0)) > 0 &&
      c.cli.raw_batch_in_merged_quarantine && c.cli.merge_result?.recovered_batches === 0 &&
      c.direct_input_sync_replay.restored?.restored === 0 && c.direct_input_sync_replay.requests.length === 0 &&
      c.sync_replay.requests.length === 0});
    closureChecks.push({id: queueCase.id, passed: queueCase.replay.requests.length === 0 &&
      queueCase.replay.initial_queue_bytes_preserved === true &&
      queueCase.replay.preserved_queue.corrupt_queue_raw === queueCase.replay.initial_queue_raw});
    closureChecks.push({id: 'original-five-compatibility', passed: archive.length === 5 && cli.status === 0 &&
      batches.length === 5 && batchRows.every(r => r.core_accepted && r.recovered_payload_unchanged) &&
      originals.sync_replay?.restored?.restored === 5 &&
      originals.sync_replay.requests.filter(r => r.method === 'PUT').length === 5 &&
      originals.sync_replay.requests.every(r => r.inside_expected_annotation_folders) &&
      originals.sync_replay.preserved_queue.queue.recovered_batches.length === 0 &&
      !originals.sync_replay.preserved_queue.queue.batch});
  }
  const after = Object.fromEntries(Object.keys(before).map(k => [k, sha(read(k))]));
  const result = {executed_at_utc: new Date().toISOString(), runtime: process.version,
    source_sha256_before: before, source_sha256_after: after, source_unchanged: Core.stable(before) === Core.stable(after),
    actual_network_requests: 0, real_tokens_used: false, original_id_rows: originalIDs, cases,
    expect: args.expect, queue_case: queueCase, original_five_recovery: originals, closure_checks: closureChecks,
    closed: args.expect === 'closed' && closureChecks.every(c => c.passed),
    unsafe_cases: cases.filter(c => c.fake_put_outside_annotation_folder).map(c => c.id),
    note: args.expect === 'closed' ? 'Exit 0 requires the two original counterexamples and one stored-queue branch to be blocked before requests, all five original batches restored, and unchanged source inputs.' :
      'Exit 0 means the observation probe completed. Read unsafe_cases and source hashes; it does not mean a clean validation result.'};
  write('P318-batch-path-probe.json', result);
  console.log(JSON.stringify({output: args.output, source_unchanged: result.source_unchanged,
    original_batches: originalIDs.length, unsafe_cases: result.unsafe_cases, closed: result.closed,
    closure_checks: closureChecks, actual_network_requests: 0}));
  if (args.expect === 'closed' && (!result.closed || !result.source_unchanged)) process.exitCode = 1;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
