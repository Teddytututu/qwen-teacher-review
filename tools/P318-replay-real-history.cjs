#!/usr/bin/env node
'use strict';
// Replays seven preserved browser-export records in memory. No browser,
// credentials, network, visual judgment, or production storage is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const args = Object.fromEntries(Array.from({length: Math.floor((process.argv.length - 2) / 2)}, (_, i) =>
  [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]));
for (const name of ['core', 'page', 'history', 'annotations', 'manifest', 'output']) {
  if (!args[name]) throw Error('Required arguments: --core FILE --page FILE --history FILE --annotations FILE --manifest FILE --output FILE');
}
const bytes = name => fs.readFileSync(path.resolve(args[name]));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const data = JSON.parse(bytes('page'));
const original = JSON.parse(bytes('history'));
const annotations = JSON.parse(bytes('annotations'));
const manifest = JSON.parse(bytes('manifest'));
const C = require(path.resolve(args.core));
const clone = value => JSON.parse(JSON.stringify(value));
class MemoryStorage {
  constructor() { this.entries = new Map(); }
  get length() { return this.entries.size; }
  key(index) { return [...this.entries.keys()][index] ?? null; }
  getItem(key) { return this.entries.get(key) ?? null; }
  setItem(key, value) { this.entries.set(key, String(value)); }
}
let sequence = 0;
function make(dataset = data) {
  return C.createStore({dataset, storage: new MemoryStorage(), digest: async value => sha(value),
    id: () => 'P318-read-only-replay-' + (++sequence), now: () => new Date().toISOString(), isTest: false});
}
const checks = [];
async function check(id, description, fn) {
  try { checks.push({id, description, status: 'pass', evidence: await fn()}); }
  catch (error) { checks.push({id, description, status: 'fail', error: error.stack}); }
}
(async () => {
  await check('H01', 'Reconstruction copies all seven original browser-export objects and binds their source/candidate hashes', async () => {
    assert.equal(original.schema_version, 1);
    assert.equal(original.history.length, 7);
    assert.equal(sha(bytes('annotations')), original.reconstruction.member_sha256);
    assert.equal(manifest.parent_annotations_sha256, original.reconstruction.member_sha256);
    const rows = [];
    for (let i = 0; i < original.history.length; i++) {
      const history = original.history[i], binding = original.reconstruction.row_bindings[i];
      const index = Number(binding.source_json_pointer.split('/')[2]);
      assert.deepEqual(history, annotations.items[index].human_choice);
      const page = data.items.find(row => row.source_uid === history.source_uid);
      assert.equal(page.source_sha256, history.source_sha256);
      assert.deepEqual(page.versions.map(v => ({key: v.key, native_sha256: v.native_sha256})), history.versions);
      rows.push({pointer: binding.source_json_pointer, source_uid: history.source_uid, choice: history.choice});
    }
    return {rows};
  });
  await check('H02', 'Legacy import keeps seven current selections, leaves unrecorded generation metadata unknown, and is idempotent', async () => {
    const store = make();
    const first = await store.importData(original, 'P318 preserved real browser exports');
    assert.equal(first.accepted, 7); assert.equal(first.quarantined, 0); assert.equal(first.unsaved, 0);
    const exported = store.exportData();
    assert.equal(exported.items.length, 7); assert.equal(exported.history.length, 7);
    for (const old of original.history) {
      const row = exported.items.find(x => x.source_uid === old.source_uid);
      assert.equal(row.choice, old.choice);
      assert.equal(row.selected_native_sha256, old.versions.find(v => v.key === old.choice)?.native_sha256 ?? null);
      assert.equal(row.selected_generation_version, null);
      assert.equal(row.source_manifest_sha256, null);
      assert.equal(exported.history.find(x => x.source_uid === old.source_uid).evidence_kind, 'browser-export');
    }
    const second = await store.importData(original, 'repeat exact same source');
    assert.equal(second.accepted, 0); assert.equal(second.duplicates, 7);
    return {first, second, current_selections: exported.items.map(x => ({source_uid: x.source_uid, choice: x.choice,
      selected_native_sha256: x.selected_native_sha256, selected_generation_version: x.selected_generation_version,
      source_manifest_sha256: x.source_manifest_sha256})),
      note: 'The normalized events retain evidence_kind=browser-export. Their schema and event identity are migration fields; verbatim original objects and the source mapping remain in the reconstruction envelope.'};
  });
  await check('H03', 'Actual round_2/000 equal-byte v3/v5 metadata differences do not force a new visual decision', async () => {
    const source = annotations.items.find(x => x.source_uid === 'round_2/000');
    const versions = source.version_history.versions;
    const v3 = versions.find(x => x.generation_version === 'redo-v3-20261010');
    const v5 = versions.find(x => x.generation_version === 'redo-v5-20261010');
    assert.equal(v3.native_sha256, v5.native_sha256);
    assert.notEqual(v3.config_sha256, v5.config_sha256);
    const changed = clone(data), row = changed.items.find(x => x.source_uid === source.source_uid);
    const candidate = row.versions.find(x => x.key === 'new');
    candidate.generation_version = v3.generation_version; candidate.config_sha256 = v3.config_sha256;
    row.versions.reverse();
    assert.equal(C.comparisonKey(data.dataset_id, data.items.find(x => x.source_uid === source.source_uid)), C.comparisonKey(changed.dataset_id, row));
    const store = make(changed); await store.importData(original, 'same image content, original evidence');
    assert.equal(store.exportData().items.length, 7);
    return {source_pointer: '/items/500/version_history/versions', native_sha256: v3.native_sha256,
      generations: [v3.generation_version, v5.generation_version], current_selections: 7,
      note: 'This is an in-memory identity probe based on real version metadata, not an assertion that the page was historically published with reversed ordering.'};
  });
  await check('H04', 'Actual round_2/028 later accepted native does not inherit the old redo; all seven histories remain', async () => {
    const uid = 'round_2/028', final = manifest.items.find(x => x.source_uid === uid);
    const changed = clone(data), row = changed.items.find(x => x.source_uid === uid);
    assert.equal(row.source_sha256, final.source_sha256);
    assert(!row.versions.some(v => v.native_sha256 === final.native_sha256));
    Object.assign(row.versions.find(v => v.key === 'new'), {native_sha256: final.native_sha256,
      generation_version: final.generation_version, config_sha256: final.config_sha256});
    const store = make(changed); const imported = await store.importData(original, 'real historical comparison');
    const exported = store.exportData();
    assert.equal(exported.history.length, 7); assert.equal(exported.items.length, 6);
    assert.equal(store.snapshot().archived.length, 1);
    assert.equal(exported.items.some(x => x.source_uid === uid), false);
    assert.equal(store.snapshot().archived[0].choice, 'redo');
    return {source_uid: uid, imported, history_count: 7, current_selection_count: 6,
      archived_choice: store.snapshot().archived[0].choice, final_native_sha256: final.native_sha256,
      final_generation_version: final.generation_version,
      note: 'The later public acceptance is evidence of a new image; this replay creates no new human decision or visual assessment.'};
  });
  await check('H05', 'Schema2 JSON export/import retains these recovered choices without changing historical timestamps', async () => {
    const first = make(); await first.importData(original, 'preserved history');
    const envelope = first.exportData(); const restored = make(); const stats = await restored.importData(envelope, 'JSON round trip');
    assert.equal(stats.accepted, 7); assert.equal(stats.quarantined, 0);
    const exported = restored.exportData();
    assert.deepEqual(exported.history, envelope.history);
    for (const row of original.history) assert.equal(exported.history.find(x => x.source_uid === row.source_uid).updated_at, row.updated_at);
    return {stats, retained_history: exported.history.length, retained_current_choices: exported.items.length};
  });
  const result = {executed_at_utc: new Date().toISOString(), runtime: process.version,
    operation: 'in-memory replay only; no network, model, production browser storage, or GitHub writes',
    input_sha256: Object.fromEntries(['core', 'page', 'history', 'annotations', 'manifest'].map(name => [name, sha(bytes(name))])),
    checks, passed: checks.filter(x => x.status === 'pass').length, failed: checks.filter(x => x.status === 'fail').length};
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({passed: result.passed, failed: result.failed, output: path.resolve(args.output)}));
  process.exitCode = result.failed ? 1 : 0;
})();
