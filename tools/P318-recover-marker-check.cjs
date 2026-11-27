#!/usr/bin/env node
'use strict';
// Regression for preserving test markers through the recovery batch adapter.
// All stores are disposable in-memory objects; no browser/network is used.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['recover', 'core', 'dataset', 'batch-archive', 'modern-export', 'output']) {
  if (!args[key]) throw Error('Required: --recover FILE --core FILE --dataset FILE --batch-archive FILE --modern-export FILE --output FILE');
}
const bytes = key => fs.readFileSync(path.resolve(args[key]));
const data = key => JSON.parse(bytes(key));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const C = require(path.resolve(args.core)), R = require(path.resolve(args.recover));
const dataset = data('dataset'), originalBatches = data('batch-archive');
const modern = data('modern-export').history[0];
const legacy = {...originalBatches[2].data.entries[0], is_test: true};
function memoryStorage() {
  const map = new Map();
  return {get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
}
(async () => {
  let serial = 0;
  const results = [];
  const cases = [
    ['modern_outer_test_inner_false', {schema_version: 2, dataset_id: dataset.dataset_id,
      source_manifest_sha256: dataset.source_manifest_sha256, batch_id: 'P318-marker-modern',
      is_test: true, entries: [{...modern, is_test: false}]}],
    ['legacy_outer_false_inner_test', {dataset_id: dataset.dataset_id,
      source_manifest_sha256: dataset.source_manifest_sha256, batch_id: 'P318-marker-legacy',
      is_test: false, entries: [legacy]}]
  ];
  for (const [id, batch] of cases) {
    const store = C.createStore({dataset, storage: memoryStorage(), id: () => 'P318-marker-' + (++serial),
      digest: async value => sha(value), isTest: false});
    const envelopes = R.envelopes(batch, dataset.dataset_id, id), imports = [];
    for (const envelope of envelopes) imports.push(await store.importData(envelope.data, 'constructed marker-precedence probe'));
    const output = store.exportData();
    results.push({id, constructed_test_case: true, input_outer_is_test: batch.is_test,
      input_inner_is_test: batch.entries[0].is_test,
      adapted_envelope_is_test: envelopes[0].data.is_test ?? null,
      adapted_entry_is_test: envelopes[0].data.history[0].is_test ?? null,
      expected_current_choices: 0, actual_current_choices: output.items.length,
      actual_history_records: output.history.length, quarantined: output.quarantine.length, imports,
      passed: output.items.length === 0 && output.quarantine.length > 0});
  }
  const report = {executed_at_utc: new Date().toISOString(), runtime: process.version,
    operation: 'Actual exported recovery adapter plus actual core; fresh in-memory production stores; no production files, browser, token or network',
    source_sha256: Object.fromEntries(['recover', 'core', 'dataset', 'batch-archive', 'modern-export'].map(key => [key, sha(bytes(key))])),
    source_pointers: {modern: '/history/0', legacy: '/2/data/entries/0'},
    results, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length};
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: report.passed, failed: report.failed, output: path.resolve(args.output)}));
  process.exitCode = report.failed ? 1 : 0;
})();
