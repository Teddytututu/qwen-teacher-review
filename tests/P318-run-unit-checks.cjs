#!/usr/bin/env node
'use strict';
// Runs the existing independent checks; no browser, service token, or network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const args = require('./P318-test-support.cjs').paths();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inputFiles() {
  const files = [];
  function visit(filename) {
    if (!fs.existsSync(filename)) return;
    const stat = fs.statSync(filename);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(filename).sort()) visit(path.join(filename, child));
    } else if (stat.isFile()) {
      files.push({path: path.relative(args.root, filename), bytes: stat.size, sha256: sha(fs.readFileSync(filename))});
    }
  }
  for (const name of ['app.js', 'sync.js', 'review-validation.js', 'P318-review-core.js', 'data.json', 'index.html', 'style.css',
    'tools/P318-recover.cjs', 'P318-recover.cjs', 'tests']) {
    visit(path.join(args.root, name));
  }
  return files;
}

const before = inputFiles();
const recover = ['tools/P318-recover.cjs', 'P318-recover.cjs'].map(name => path.join(args.root, name))
  .find(filename => fs.existsSync(filename)) || path.join(args.root, 'tools/P318-recover.cjs');
const checks = [
  [process.execPath, 'P318-baseline-replay.cjs'],
  [process.execPath, 'P318-core-review.cjs'],
  [process.execPath, 'P318-sync-review.cjs'],
  [process.execPath, 'P318-history-queue-conflict-check.cjs'],
  [process.execPath, 'P318-legacy-corrupt-backup-check.cjs'],
  [process.execPath, 'P318-test-data-separation.cjs'],
  [process.execPath, 'P318-cli-recovery-check.cjs'],
  [process.execPath, 'P318-batch-path-probe.cjs', [
    '--core', path.join(args.root, 'P318-review-core.js'),
    '--sync', path.join(args.root, 'sync.js'),
    '--recover', recover,
    '--dataset', path.join(args.root, 'data.json'),
    '--batch-archive', path.join(args.root, 'tests/fixtures/P318-qwen-annotation-batches.json'),
    '--output', args.output, '--expect', 'closed',
  ]],
  [args.python, 'P318-inspect-snapshot.py'],
  [args.python, 'P318-make-legacy500.py'],
];
const results = [];
for (const [executable, script, explicitArgs] of checks) {
  const commandArgs = [path.join(__dirname, script), ...(explicitArgs || ['--root', args.root, '--output', args.output])];
  const result = spawnSync(executable, commandArgs, {encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
  const record = {script, exit_code: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || ''};
  if (result.error) record.error = result.error.message;
  results.push(record);
  console.log(JSON.stringify({script, exit_code: result.status, output: record.stdout.trim(), error: record.error || null}));
}
const after = inputFiles();
const unchanged = JSON.stringify(before) === JSON.stringify(after);
let coverageCounts = null, coverageError = null;
try {
  const readResult = name => JSON.parse(fs.readFileSync(args.result(name), 'utf8'));
  const cli = readResult('P318-cli-recovery-regression.json');
  const batch = readResult('P318-batch-path-probe.json');
  coverageCounts = {
    scripts: results.length,
    baseline_cases: readResult('P318-baseline-results.json').cases.length,
    core_cases: readResult('P318-core-review-results.json').results.length,
    sync_cases: readResult('P318-sync-review-results.json').results.length,
    history_queue_branches: readResult('P318-history-queue-check-summary.json').scenarios.length,
    cli_recovery_cases: cli.cases.length,
    cli_named_assertions: cli.cases.reduce((sum, item) => sum + item.checks.length, 0),
    batch_path_closure_assertions: batch.closure_checks.length,
    counting_note: 'Case counts and the two new reports\' explicitly named assertions are separate units; this is not a total count of internal assert calls. Corrupt-legacy recovery, test isolation, snapshot inspection and legacy-fixture generation remain separate scripts.',
  };
} catch (error) { coverageError = error.message; }
const report = {
  generated_at_utc: new Date().toISOString(),
  root: args.root,
  output: args.output,
  method: 'Baseline, core, sync, history/queue cross-check, corrupt legacy backup, test isolation, CLI recovery, batch-path closure, actual snapshot inspection, and legacy fixture generation. No browser engine or real network is invoked.',
  input_files_before: before,
  input_files_after: after,
  input_files_unchanged: unchanged,
  coverage_counts: coverageCounts,
  coverage_error: coverageError,
  results,
  passed: results.every(result => result.exit_code === 0) && unchanged && !coverageError,
};
const outputFile = args.result('P318-portable-suite.json');
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({passed: report.passed, checks: results.length, coverage_counts: coverageCounts,
  input_files_unchanged: unchanged, output: outputFile}));
if (!report.passed) process.exitCode = 1;
