#!/usr/bin/env node
'use strict';
// A migration-cost demonstration, not a new parser or a real browser test.
// Reuse the existing isolated-realm adapter; execute the original app unchanged.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const args = require('./P318-test-support.cjs').paths();
const adapterPath = path.join(__dirname, 'P318-baseline-replay.cjs');
const inputPath = path.join(__dirname, 'fixtures/P318-schema2-merge-export.json');
const inputBytes = fs.readFileSync(inputPath);
const input = JSON.parse(inputBytes);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const adapter = fs.readFileSync(adapterPath, 'utf8');
const boundary = adapter.indexOf('const cases=[];');
assert.ok(boundary > 0, 'Known adapter boundary must exist');
const sandbox = {require: createRequire(adapterPath), process, console, Buffer, Blob, URL, URLSearchParams, TextEncoder};
vm.createContext(sandbox);
vm.runInContext(adapter.slice(0, boundary) + '\nglobalThis.P318Original = {page, DATA};', sandbox);

async function main() {
  const {page, DATA} = sandbox.P318Original;
  const first = await page({data: DATA});
  first.choose('new'); await first.settle();
  const v1 = first.export(), v1Reader = await page({data: DATA});
  await v1Reader.import(v1); await v1Reader.settle();
  const control = v1Reader.export();
  const oldReader = await page({data: DATA});
  await oldReader.import(input); await oldReader.settle();
  const returned = oldReader.export();
  const checks = {
    original_v1_round_trip_selects_one: control.items.length === 1 && control.items[0].choice === 'new',
    input_is_new_reader_contract: input.schema_version === 2 && input.required_reader === 'qwen-review-event-journal-v2',
    actual_conflict_input_is_four_events: input.history.length === 4 && input.conflicts.length === 1,
    original_reader_does_not_reject_schema2: returned.history.length > 0 && !oldReader.text('save').startsWith('导入提示'),
    original_reader_folds_one_conflicting_event: returned.history.length === 3,
    original_reader_misses_current_pairs_after_order_change: returned.items.length === 0,
    original_reader_drops_conflict_projection: returned.conflicts === undefined,
    actual_input_bytes_unchanged: sha(fs.readFileSync(inputPath)) === sha(inputBytes)
  };
  const report = {
    generated_at_utc: new Date().toISOString(),
    method: 'Original app.js in the existing explicit DOM/Storage/Locks adapter; no real network or browser engine. One v1 control and one actual schema2 merged export.',
    original_app_sha256: sha(fs.readFileSync(path.join(args.root, 'tests/baseline/app.js'))),
    input: {path: inputPath, sha256: sha(inputBytes), bytes: inputBytes.length, schema_version: input.schema_version,
      history: input.history.length, items: input.items.length, conflicts: input.conflicts.length},
    control: {history: control.history.length, items: control.items.length, choice: control.items[0]?.choice},
    old_reader_output: returned,
    old_reader_message: oldReader.text('save'),
    input_candidate_order: input.history[0].versions.map(v => v.key),
    current_manifest_candidate_order: DATA.items.find(x => x.source_uid === input.history[0].source_uid).versions.map(v => v.key),
    checks, passed: Object.values(checks).every(Boolean),
    decision: 'Schema2 backups must use the new page or recovery tool. Update downstream readers before adoption; do not label v2 as backward-readable by the original page.'
  };
  fs.writeFileSync(args.result('P318-old-reader-compatibility.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: report.passed, checks, history: returned.history.length, current: returned.items.length}));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => {console.error(error.stack); process.exitCode = 1;});
