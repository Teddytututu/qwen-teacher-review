#!/usr/bin/env node
'use strict';
// Original recovery regressions, two flag variants and one real-history control.
// Node built-ins only; actual offline CLI, no network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const args = require('./P318-test-support.cjs').paths();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const started = new Date().toISOString();

function firstFile(names) {
  const found = names.map(name => path.join(args.root, name)).find(file => fs.existsSync(file));
  if (!found) throw Error('Missing repository file: ' + names.join(' or '));
  return found;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function matches(value, target, pointer = '') {
  const found = canonical(value) === canonical(target) ? [pointer || '/'] : [];
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
    found.push(...matches(child, target, pointer + '/' + escaped));
  }
  return found;
}
function read(file) {
  const bytes = fs.readFileSync(file);
  return {value: JSON.parse(bytes), file, sha256: sha(bytes), bytes: bytes.length};
}
function digestFiles(files) {
  return files.map(file => ({file, sha256: sha(fs.readFileSync(file))}));
}

function main() {
  // Published layout is tools/ + root core; the working source layout is also accepted.
  const recover = firstFile(['tools/P318-recover.cjs', 'P318-recover.cjs']);
  const core = firstFile(['P318-review-core.js', 'qwen-page/P318-review-core.js']);
  const dataset = firstFile(['data.json']);
  const cases = [
    {id: 'C01-history-versus-pending', kind: 'conflict', file: path.join(__dirname, 'fixtures/P318-cli-history-queue-conflict.json'),
      expected_sha256: 'ac0ffd9034d26779d9aa6519d26b0742b3376fbe98bda53b323640865561d46b'},
    {id: 'C02-legacy-raw', kind: 'raw', file: path.join(__dirname, 'fixtures/P318-cli-legacy-corrupt-export.json'),
      expected_sha256: 'bf56bf33f730e2d8d25602ccfdd2b004e8a010e254b86a891e4ab373ecb6db0a'},
    {id: 'C01L-pending-legacy-true', kind: 'conflict', flagVariant: 'pending',
      file: path.join(__dirname, 'fixtures/P318-cli-history-queue-conflict.json'),
      expected_sha256: 'ac0ffd9034d26779d9aa6519d26b0742b3376fbe98bda53b323640865561d46b'},
    {id: 'C01L-both-legacy-true', kind: 'conflict', flagVariant: 'both',
      file: path.join(__dirname, 'fixtures/P318-cli-history-queue-conflict.json'),
      expected_sha256: 'ac0ffd9034d26779d9aa6519d26b0742b3376fbe98bda53b323640865561d46b'},
    {id: 'C03-real-seven-legacy-control', kind: 'control',
      file: path.join(__dirname, 'fixtures/P318-cli-real-seven-legacy-test.json'),
      expected_sha256: '58b7beb1f0fd27f06673be5a74326415e7ae1093f2eab7139e1639f9d5d517d6'},
  ];
  const tracked = [...new Set([recover, core, dataset, __filename, path.join(__dirname, 'P318-test-support.cjs'), ...cases.map(c => c.file)])];
  const before = digestFiles(tracked), results = [];
  for (const item of cases) {
    const fixture = read(item.file), inputValue = JSON.parse(JSON.stringify(fixture.value));
    if (fixture.sha256 !== item.expected_sha256) throw Error('Fixture bytes changed: ' + item.file);
    if (inputValue.is_test !== true) throw Error('Fixture must remain test-marked: ' + item.file);
    let input = fixture;
    const changedFields = [];
    if (item.flagVariant) {
      inputValue.server_sync.queue.pending[0].legacy = true;
      changedFields.push('/server_sync/queue/pending/0/legacy');
      if (item.flagVariant === 'both') {
        inputValue.history[0].legacy = true;
        changedFields.push('/history/0/legacy');
      }
      const restored = JSON.parse(JSON.stringify(inputValue));
      restored.server_sync.queue.pending[0].legacy = false;
      restored.history[0].legacy = false;
      if (canonical(restored) !== canonical(fixture.value)) throw Error('Flag variant changed other input fields');
      const filename = args.result('P318-' + item.id + '-input.json');
      fs.writeFileSync(filename, JSON.stringify(inputValue, null, 2) + '\n');
      input = read(filename);
    }
    const output = path.join(args.output, 'P318-cli-recovery-' + item.id);
    const command = [process.execPath, recover, '--dataset', dataset, '--out', output,
      '--now', '2026-11-26T07:00:00.000Z', '--test-data', input.file];
    const child = spawnSync(command[0], command.slice(1), {encoding: 'utf8'});
    const record = {id: item.id, input: {file: input.file, sha256: input.sha256, bytes: input.bytes},
      source_fixture: {file: fixture.file, sha256: fixture.sha256, bytes: fixture.bytes},
      changed_fields: changedFields,
      command, exit_code: child.status, signal: child.signal,
      stdout: child.stdout || '', stderr: child.stderr || '', checks: [], outputs: {}};
    const check = (name, passed, detail = null) => record.checks.push({name, passed: Boolean(passed), detail});
    if (item.kind === 'control') check('actual CLI accepts the matching legacy history and pending', child.status === 0);
    else check('actual CLI exits 3 for this retained diagnostic input', child.status === 3);
    try {
      const outputNames = ['P318-merged-annotations.json', 'P318-merge-report.json', 'P318-conflicts-and-quarantine.json'];
      const values = {};
      for (const name of outputNames) {
        const file = read(path.join(output, name));
        values[name] = file.value;
        record.outputs[name] = {file: file.file, sha256: file.sha256, bytes: file.bytes};
      }
      const merged = values['P318-merged-annotations.json'], report = values['P318-merge-report.json'];
      record.result = report.result;
      if (item.kind === 'conflict') {
        const old = inputValue.history[0], incoming = inputValue.server_sync.queue.pending[0];
        check('fixture is the original same-ID old/new disagreement',
          old.event_id === incoming.event_id && old.choice === 'old' && incoming.choice === 'new');
        check('queue conflict is reported', report.queue_errors?.some(error => error.reason === 'recovered-history-conflict'));
        const paths = matches(merged.quarantine || [], incoming, '/quarantine');
        check('incoming pending object survives in merged quarantine', paths.length > 0, paths);
        const history = merged.history.filter(event => event.event_id === old.event_id);
        check('original history remains old', history.length === 1 && history[0].choice === 'old');
        check('conflicting incoming event is not pending for upload',
          !(merged.server_sync?.queue?.pending || []).some(event => event.event_id === incoming.event_id));
      } else if (item.kind === 'raw') {
        const raw = inputValue.server_sync.legacy_queue.raw;
        check('fixture contains the original bad queue bytes', typeof raw === 'string' &&
          sha(Buffer.from(raw, 'utf8')) === 'cda976a24d06aa8022ffd7c7d00499b35b9eea8c5145cd4dea934b87d614a16b');
        const retained = (merged.server_sync?.queue?.recovered_evidence || []).filter(evidence => evidence.raw === raw);
        check('bad queue raw survives once in merged recovered evidence', retained.length === 1,
          matches(merged, raw));
        const draft = inputValue.quarantine[0].raw;
        check('pre-existing bad draft quarantine also survives', matches(merged.quarantine || [], draft).length > 0);
        check('queue preservation did not manufacture choices', merged.history.length === 0 && merged.items.length === 0);
      } else {
        const provenance = inputValue.P318_test_derivation;
        const restoredHistory = inputValue.history.map(event => ({...event, is_test: false}));
        check('control derives from the seven real migrated records with test markers only',
          provenance.source_file_sha256 === '63b373768aa95e6d38d17dab5cdc15ac498a4533aac42d273a99d77bcb05a9e5' &&
          provenance.source_history_canonical_sha256 === '2f29183e8e68c7981f18a1c8cefc4e3fe0ad36a9fabcab1750b281ad6278f616' &&
          sha(canonical(restoredHistory)) === provenance.source_history_canonical_sha256 &&
          inputValue.history.length === 7 && inputValue.history.every(event => event.schema_version === 2 && event.legacy === true && event.is_test === true), provenance);
        const ordered = events => [...events].sort((a, b) => a.event_id.localeCompare(b.event_id));
        check('all seven historical bindings survive without demanding seven current images',
          merged.history.length === 7 && canonical(ordered(merged.history)) === canonical(ordered(inputValue.history)));
        const pending = merged.server_sync?.queue?.pending || [], originalPending = inputValue.server_sync.queue.pending;
        check('the one synthetic pending record remains identical to its matching history',
          pending.length === 1 && originalPending.length === 1 &&
          canonical(pending[0]) === canonical(originalPending[0]) &&
          canonical(pending[0]) === canonical(inputValue.history[0]) && merged.server_sync?.queue?.is_test === true);
        check('matching legacy control has no queue errors or isolated records',
          (report.queue_errors || []).length === 0 && (report.batch_errors || []).length === 0 &&
          (report.batch_conflicts || []).length === 0 && merged.quarantine.length === 0 &&
          merged.conflicts.length === 0 && report.result.incomplete === 0);
      }
      check('output remains test-marked with no remote confirmation', merged.is_test === true && report.result.remote_confirmations === 0);
    } catch (error) { check('all three CLI outputs can be independently parsed', false, error.message); }
    record.passed = record.checks.every(check => check.passed);
    results.push(record);
  }
  const after = digestFiles(tracked), unchanged = canonical(before) === canonical(after);
  const result = {started_at_utc: started, finished_at_utc: new Date().toISOString(), runtime: process.version,
    method: 'Two unchanged original fixtures, two legacy-flag-only conflict variants and one real-seven-history test derivative through the actual offline CLI; independent JSON readback.',
    root: args.root, actual_network_requests: 0, test_data: true, input_files_before: before,
    input_files_after: after, input_files_unchanged: unchanged, cases: results,
    case_count: results.length, named_assertion_count: results.reduce((count, item) => count + item.checks.length, 0),
    passed: unchanged && results.length === 5 && results.every(item => item.passed)};
  const filename = args.result('P318-cli-recovery-regression.json');
  fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({passed: result.passed, cases: results.length, named_assertions: result.named_assertion_count,
    input_files_unchanged: unchanged, output: filename}));
  if (!result.passed) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error.stack); process.exitCode = 2; }
