#!/usr/bin/env node
'use strict';
// One recovery counterexample and its missing-history/legacy-flag variants. Actual core/sync and the exact
// app.importData function run in a fresh VM. Only DOM presentation is stubbed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const args = {root: path.resolve(__dirname, '..'), expect: 'closed'};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') { console.log('node tests/P318-history-queue-conflict-check.cjs [--root REPO] [--manifest DATA] --output DIRECTORY [--expect closed|vulnerable] [--scenario mismatch|missing|pending-legacy|both-legacy|both|all]'); process.exit(0); }
  if (!['--root', '--manifest', '--output', '--expect', '--scenario'].includes(key) || !process.argv[i + 1]) throw Error('Use --root REPO --manifest DATA --output DIRECTORY [--expect vulnerable|closed]');
  args[key.slice(2)] = process.argv[++i];
}
args.manifest ||= path.join(args.root, 'data.json');
if (!args.output) throw Error('Missing --output');
if (!['vulnerable', 'closed'].includes(args.expect)) throw Error('Invalid --expect');
args.scenario ||= 'all';
if (!['mismatch', 'missing', 'pending-legacy', 'both-legacy', 'both', 'all'].includes(args.scenario)) throw Error('Invalid --scenario');
const root = path.resolve(args.root), output = path.resolve(args.output);
const relativeOutput = path.relative(root, output);
if (relativeOutput === '' || (!relativeOutput.startsWith('..' + path.sep) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) throw Error('--output must be outside --root');
fs.mkdirSync(output, {recursive: true});
const Core = require(path.join(root, 'P318-review-core.js'));
const dataBytes = fs.readFileSync(args.manifest);
const DATA = JSON.parse(dataBytes);
const originalInputBytes = fs.readFileSync(path.join(__dirname, 'fixtures/P318-cli-history-queue-conflict.json'));
const ORIGINAL_INPUT = JSON.parse(originalInputBytes);
const APP = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const SYNC = fs.readFileSync(path.join(root, 'sync.js'), 'utf8');
const start = APP.indexOf('async function importData(data){');
const end = APP.indexOf("$('file').onchange", start);
assert.ok(start >= 0 && end > start, 'Cannot locate exact app.importData function');
const importFunction = APP.slice(start, end);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
class Storage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
async function runCase(scenario) {
  const storage = new Storage(), session = new Storage(), nodes = new Map(), requests = [], timers = [], calls = [];
  assert.equal(sha(originalInputBytes), 'ac0ffd9034d26779d9aa6519d26b0742b3376fbe98bda53b323640865561d46b');
  const envelope = clone(ORIGINAL_INPUT), changedPointers = [];
  if (scenario === 'pending-legacy' || scenario === 'both-legacy') {
    envelope.server_sync.queue.pending[0].legacy = true; changedPointers.push('/server_sync/queue/pending/0/legacy');
  }
  if (scenario === 'both-legacy') { envelope.history[0].legacy = true; changedPointers.push('/history/0/legacy'); }
  const historical = Core.normalizeEvent(envelope.history[0], DATA);
  const queued = Core.normalizeEvent(envelope.server_sync.queue.pending[0], DATA);
  const row = DATA.items.find(item => item.source_uid === historical.source_uid);
  assert.ok(row);
  assert.equal(historical.event_id, queued.event_id);
  assert.notEqual(Core.stable(historical), Core.stable(queued));
  if (scenario === 'missing') { envelope.history = []; changedPointers.push('/history'); }
  let serial = 0;
  const journal = Core.createStore({dataset: DATA, storage, isTest: true,
    now: () => '2026-11-26T06:00:00.000Z', id: () => 'P318-conflict-probe-' + (++serial), digest: async value => sha(value)});
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent: '', dataset: {}, disabled: false, close() {}, showModal() {}});
    return nodes.get(id);
  };
  const scope = {console, QwenReviewCore: Core, QWEN_REVIEW_CONFIG: {isTest: true,
      apiBase: 'https://example.invalid/P318-offline', fetch: async (...request) => { requests.push(request); throw Error('Unexpected request'); }},
    document: {getElementById, addEventListener() {}}, localStorage: storage, sessionStorage: session,
    navigator: {locks: {request: async (name, options, callback) => (typeof options === 'function' ? options : callback)({name})}},
    crypto: {randomUUID: () => 'P318-sync-probe-' + (++serial)}, Date, TextEncoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'), AbortSignal: {timeout: () => ({})},
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, setInterval: () => 1, addEventListener() {},
    journal, view: journal.snapshot(), recoveryNotice: '', current: () => row};
  scope.window = scope;
  const context = vm.createContext(scope);
  vm.runInContext(SYNC, context, {filename: 'actual-sync.js'});
  await scope.reviewSync.configure(DATA, {isTest: true});
  const restore = scope.reviewSync.restore;
  scope.reviewSync.restore = async (...values) => {
    const result = await restore(...values);
    calls.push({operation: 'sync.restore', argument_count: values.length, result: clone(result)});
    return result;
  };
  vm.runInContext("function refreshView(){view=journal.snapshot()} function showSave(){refreshView()} function rebuild(){}\n" + importFunction, context, {filename: 'actual-app-importData.js'});
  const before = {history: journal.snapshot().history.length, pending: scope.reviewSync.summary().pending_events, keys: storage.length};
  scope.__input = envelope;
  const imported = await vm.runInContext('importData(__input)', context);
  const exported = journal.exportData(scope.reviewSync.backup());
  const pending = exported.server_sync.queue.pending;
  const observed = {imported, current_choice: exported.items[0]?.choice ?? null,
    history_choice: exported.history.find(event => event.event_id === historical.event_id)?.choice ?? null,
    pending_choice: pending.find(event => event.event_id === historical.event_id)?.choice ?? null,
    normalized_history_after_import: exported.history, final_pending: pending,
    event_id: historical.event_id, pending_events: pending.length, sync_error: scope.reviewSync.summary().error,
    requests: requests.length, session_keys: session.length, calls, local_storage: Object.fromEntries(storage.values)};
  const divergence = observed.current_choice === (scenario === 'missing' ? null : 'old') && observed.pending_choice === 'new';
  const contractClosed = observed.current_choice === (scenario === 'missing' ? null : 'old') && observed.pending_choice !== 'new' && (scenario !== 'missing' || pending.length === 0) && /冲突|不一致/.test(observed.sync_error || '');
  const report = {is_test: true, synthetic_display: true, generated_at_utc: new Date().toISOString(),
    method: 'Actual core and sync modules, exact app.importData function; fresh in-memory Storage and Web Locks/DOM doubles; no browser pixels, token, or network.',
    scenario, expected: args.expect, source_sha256: {app: sha(APP), sync: sha(SYNC), core: sha(fs.readFileSync(path.join(root, 'P318-review-core.js'))), manifest: sha(dataBytes)},
    app_import_function: importFunction, independent_normalization_succeeded: true, before,
    original_input_sha256: sha(originalInputBytes), changed_pointers: changedPointers,
    normalized_input: {history: historical, pending: queued},
    input: envelope, observed, divergence_reproduced: divergence, contract_closed: contractClosed,
    matched_expectation: args.expect === 'vulnerable' ? divergence : contractClosed};
  const stem = scenario === 'mismatch' ? 'P318-history-queue-conflict' : 'P318-history-queue-' + scenario;
  fs.writeFileSync(path.join(output, stem + '-input.json'), JSON.stringify(envelope, null, 2) + '\n');
  fs.writeFileSync(path.join(output, stem + '-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({output, scenario, current_choice: observed.current_choice, pending_choice: observed.pending_choice,
    sync_error: observed.sync_error, requests: observed.requests, expected: args.expect, matched_expectation: report.matched_expectation}));
  assert.equal(observed.requests, 0);
  assert.equal(observed.session_keys, 0);
  assert.equal(report.matched_expectation, true);
  return report;
}
async function main() {
  const scenarios = args.scenario === 'all' ? ['mismatch', 'missing', 'pending-legacy', 'both-legacy'] :
    args.scenario === 'both' ? ['mismatch', 'missing'] : [args.scenario];
  const results = [];
  for (const scenario of scenarios) results.push(await runCase(scenario));
  fs.writeFileSync(path.join(output, 'P318-history-queue-check-summary.json'), JSON.stringify({is_test:true,synthetic_display:true,expected:args.expect,scenarios:results.map(r=>({scenario:r.scenario,matched_expectation:r.matched_expectation})),passed:results.every(r=>r.matched_expectation)},null,2)+'\n');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
