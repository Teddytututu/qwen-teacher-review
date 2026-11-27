#!/usr/bin/env node
'use strict';
// Actual complete app/core/sync startup with two corrupt legacy strings.
// DOM and WebStorage are deterministic doubles; no rendered-image claim.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const args = {root: path.resolve(__dirname, '..'), expect: 'closed'};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--help') { console.log('node P318-legacy-corrupt-backup-check.cjs --root REPO [--manifest DATA] --output DIRECTORY [--expect closed|vulnerable]'); process.exit(0); }
  if (!['--root', '--manifest', '--output', '--expect'].includes(name) || !process.argv[i + 1]) throw Error('Unknown option or missing value: ' + name);
  args[name.slice(2)] = process.argv[++i];
}
args.manifest ||= path.join(args.root, 'data.json');
if (!args.output || !['closed', 'vulnerable'].includes(args.expect)) throw Error('Provide --output and a valid --expect');
const root = path.resolve(args.root), output = path.resolve(args.output);
const relativeOutput = path.relative(root, output);
if (relativeOutput === '' || (!relativeOutput.startsWith('..' + path.sep) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) throw Error('--output must be outside --root');
fs.mkdirSync(output, {recursive: true});
const DATA = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
const source = Object.fromEntries(['review-validation.js', 'P318-review-core.js', 'sync.js', 'app.js'].map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
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
function fakeDOM() {
  const nodes = new Map(), all = [], listeners = new Map();
  class Element {
    constructor(tag = 'DIV', id) {
      this.tagName = tag.toUpperCase(); this.id = id; this.dataset = {}; this.value = ''; this.checked = false;
      this.textContent = ''; this.hidden = false; this.disabled = false; this.children = []; this.open = false;
      this.options = [{textContent: ''}, {textContent: ''}]; this.classList = {toggle() {}}; all.push(this);
    }
    querySelectorAll(selector) { const all=[]; const visit=node=>{for(const child of node.children||[]){if(selector==='img'&&child.tagName==='IMG')all.push(child);visit(child)}};visit(this);return all; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = [...values]; }
    addEventListener() {}
    setAttribute(name, value) { this[name] = String(value); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { return this.onclick?.({target: this}); }
    focus() {}
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element('DIV', id)); return nodes.get(id); },
    createElement(tag) { return new Element(tag); },
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-choice]') return all.filter(element => element.dataset.choice);
      if (selector === '.figure[data-variant]') return all.filter(element => element.dataset.variant);
      return [];
    },
  };
  document.getElementById('scope').value = 'all';
  document.getElementById('filter').value = 'all';
  for (const choice of ['old', 'new', 'redo']) { const button = new Element('BUTTON'); button.dataset.choice = choice; }
  return {document, listeners};
}
function stringPaths(value, target, pointer = '') {
  if (typeof value === 'string') return value === target ? [pointer || '/'] : [];
  if (Array.isArray(value)) return value.flatMap((child, index) => stringPaths(child, target, pointer + '/' + index));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => stringPaths(child, target, pointer + '/' + key));
  return [];
}
let bootSerial = 0;
async function boot(storage) {
  const session = new Storage(), dom = fakeDOM(), requests = [], bootId = ++bootSerial;
  let ids = 0;
  class FixedDate extends Date { constructor(...values) { super(...(values.length ? values : ['2026-11-26T06:30:00.000Z'])); } static now() { return Date.parse('2026-11-26T06:30:00.000Z'); } }
  const scope = {console, document: dom.document, localStorage: storage, sessionStorage: session,
    Date: FixedDate, URL, URLSearchParams, Blob, TextEncoder,
    location: {href: 'http://127.0.0.1/P318-unit/index.html', search: '?scope=all', reload() {}},
    crypto: {randomUUID: () => 'P318-corrupt-probe-' + bootId + '-' + (++ids), subtle: crypto.webcrypto.subtle},
    navigator: {locks: {request: async (name, options, callback) => (typeof options === 'function' ? options : callback)({name})}},
    btoa: value => Buffer.from(value, 'binary').toString('base64'), AbortSignal: {timeout: () => ({})},
    setTimeout: () => 1, setInterval: () => 1, addEventListener() {},
    QWEN_REVIEW_CONFIG: {isTest: true, apiBase: 'https://example.invalid/P318-offline',
      fetch: async (...request) => { requests.push(request); throw Error('Unexpected request'); }},
    fetch: async url => { assert.ok(String(url).startsWith('data.json')); return {ok: true, json: async () => clone(DATA)}; }};
  scope.window = scope;
  const context = vm.createContext(scope);
  for (const name of ['review-validation.js', 'P318-review-core.js', 'sync.js', 'app.js']) vm.runInContext(source[name], context, {filename: name});
  for (const listener of dom.listeners.get('DOMContentLoaded') || []) listener();
  for (let i = 0; i < 100 && !scope.reviewApp; i++) await Promise.resolve();
  assert.ok(scope.reviewApp, 'App did not initialize: ' + dom.document.getElementById('save').textContent);
  return {scope, dom, requests, session};
}
async function main() {
  const storage = new Storage();
  const draftKey = 'qwen-human-review:' + DATA.dataset_id;
  const queueKey = 'qwen-github-sync:' + DATA.dataset_id;
  const draftRaw = '{"P318-broken-draft": ["原始草稿字符仍未闭合';
  const queueRaw = '{"client_id":"P318-broken-queue","pending":["原始队列字符仍未闭合';
  storage.setItem(draftKey, draftRaw); storage.setItem(queueKey, queueRaw);
  const {scope, dom, requests, session} = await boot(storage);
  const exported = clone(scope.reviewApp.exportData());
  const reimports = [], quarantineCounts = [exported.quarantine.length], evidenceCounts = [exported.server_sync.queue?.recovered_evidence?.length || 0];
  for (let count = 0; count < 2; count++) {
    reimports.push(await scope.reviewApp.importData(clone(exported)));
    const after = scope.reviewApp.exportData();
    quarantineCounts.push(after.quarantine.length);
    evidenceCounts.push(after.server_sync.queue?.recovered_evidence?.length || 0);
  }
  // A genuinely empty recovery store has neither original legacy key.
  const recoveryStorage = new Storage(), recovering = await boot(recoveryStorage);
  assert.equal(recoveryStorage.getItem(draftKey), null); assert.equal(recoveryStorage.getItem(queueKey), null);
  const recoveredQuarantineCounts = [], recoveredEvidenceCounts = [], freshImports = [];
  let afterFreshImport;
  for (let count = 0; count < 2; count++) {
    freshImports.push(await recovering.scope.reviewApp.importData(clone(exported)));
    afterFreshImport = clone(recovering.scope.reviewApp.exportData());
    recoveredQuarantineCounts.push(afterFreshImport.quarantine.length);
    recoveredEvidenceCounts.push(afterFreshImport.server_sync.queue?.recovered_evidence?.length || 0);
  }
  // Re-create every JS realm and module, keeping only the newly written bytes.
  const reloaded = await boot(recoveryStorage);
  const afterReload = clone(reloaded.scope.reviewApp.exportData());
  const freshRoundtrip = {
    original_keys_absent: recoveryStorage.getItem(draftKey) === null && recoveryStorage.getItem(queueKey) === null,
    imports: freshImports, quarantine_counts_after_imports: recoveredQuarantineCounts,
    recovered_evidence_counts_after_imports: recoveredEvidenceCounts,
    after_import: {draft_raw_paths: stringPaths(afterFreshImport, draftRaw), queue_raw_paths: stringPaths(afterFreshImport, queueRaw)},
    after_reload: {draft_raw_paths: stringPaths(afterReload, draftRaw), queue_raw_paths: stringPaths(afterReload, queueRaw),
      quarantine_count: afterReload.quarantine.length, recovered_evidence_count: afterReload.server_sync.queue?.recovered_evidence?.length || 0,
      pending_events: afterReload.server_sync.queue?.pending.length || 0, active_batch: Boolean(afterReload.server_sync.queue?.batch), recovered_batches: afterReload.server_sync.queue?.recovered_batches.length || 0},
    requests: recovering.requests.length + reloaded.requests.length,
    session_keys: recovering.session.length + reloaded.session.length,
    persisted_keys: [...recoveryStorage.values.keys()],
  };
  const observed = {
    repeated_import_scope: 'same initialized context; same independent export imported twice',
    repeated_import_results: reimports, quarantine_counts_before_and_after: quarantineCounts,
    recovered_evidence_counts_in_original_context: evidenceCounts, fresh_roundtrip: freshRoundtrip,
    draft_key_unchanged: storage.getItem(draftKey) === draftRaw,
    queue_key_unchanged: storage.getItem(queueKey) === queueRaw,
    draft_raw_export_paths: stringPaths(exported, draftRaw), queue_raw_export_paths: stringPaths(exported, queueRaw),
    legacy_info: clone(scope.reviewSync.legacyInfo()), quarantine: exported.quarantine,
    recovery_notice: dom.document.getElementById('recovery-status').textContent,
    requests: requests.length, session_keys: session.length,
  };
  const quarantineStable = quarantineCounts.every(count => count === quarantineCounts[0]);
  const freshPreserved = freshRoundtrip.after_reload.draft_raw_paths.length > 0 && freshRoundtrip.after_reload.queue_raw_paths.length > 0;
  const evidenceStable = evidenceCounts.every(count => count === evidenceCounts[0]) && recoveredEvidenceCounts[0] === recoveredEvidenceCounts[1];
  const freshQuarantineStable = recoveredQuarantineCounts[0] === recoveredQuarantineCounts[1] && afterReload.quarantine.length === recoveredQuarantineCounts[1];
  const initialExportHasBoth = observed.draft_raw_export_paths.length > 0 && observed.queue_raw_export_paths.length > 0;
  const closed = initialExportHasBoth && freshPreserved && quarantineStable && evidenceStable && freshQuarantineStable;
  const missingBoth = observed.draft_raw_export_paths.length === 0 && observed.queue_raw_export_paths.length === 0;
  const report = {is_test: true, synthetic_display: true, generated_at_utc: new Date().toISOString(), expected: args.expect,
    method: 'Complete actual app/core/sync initialization plus actual exportData; fresh DOM/Storage/Web Lock doubles, one corrupt draft and one corrupt old queue, no browser pixels/token/network.',
    source_sha256: Object.fromEntries(Object.entries(source).map(([name, text]) => [name, sha(text)])),
    input: {dataset_id: DATA.dataset_id, local_storage: {[draftKey]: draftRaw, [queueKey]: queueRaw},
      raw_utf8_sha256: {draft: sha(draftRaw), queue: sha(queueRaw)}}, observed,
    raw_strings_in_initial_export: initialExportHasBoth, both_missing_from_initial_export: missingBoth,
    fresh_roundtrip_preserves_both: freshPreserved, evidence_deduplicated: evidenceStable,
    matched_expectation: args.expect === 'closed' ? closed : !closed};
  fs.writeFileSync(path.join(output, 'P318-legacy-corrupt-actual-export.json'), JSON.stringify(exported, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'P318-legacy-corrupt-after-fresh-import.json'), JSON.stringify(afterFreshImport, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'P318-legacy-corrupt-after-reload.json'), JSON.stringify(afterReload, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'P318-legacy-corrupt-backup-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({output, expected: args.expect, draft_raw_export_paths: observed.draft_raw_export_paths,
    queue_raw_export_paths: observed.queue_raw_export_paths, original_keys_unchanged: observed.draft_key_unchanged && observed.queue_key_unchanged,
    requests: requests.length + freshRoundtrip.requests, quarantine_counts: quarantineCounts, after_fresh_reload: freshRoundtrip.after_reload, matched_expectation: report.matched_expectation}));
  assert.ok(observed.draft_key_unchanged && observed.queue_key_unchanged);
  assert.equal(requests.length + freshRoundtrip.requests, 0); assert.equal(session.length + freshRoundtrip.session_keys, 0); assert.equal(quarantineStable, true);
  assert.equal(freshRoundtrip.original_keys_absent, true);
  assert.equal(freshRoundtrip.after_reload.pending_events, 0); assert.equal(freshRoundtrip.after_reload.active_batch, false); assert.equal(freshRoundtrip.after_reload.recovered_batches, 0);
  if (initialExportHasBoth) assert.ok(freshRoundtrip.after_reload.draft_raw_paths.length, 'Control failed: quarantine draft did not survive the fresh restore');
  assert.equal(report.matched_expectation, true);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
