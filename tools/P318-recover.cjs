#!/usr/bin/env node
'use strict';
// Offline recovery/merge utility. Uses the same parser and projection as the UI.
// It has no network client and never changes an input file or browser storage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Core = require('../P318-review-core.js');

function parseArgs(args) {
  const result = {inputs: []};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--dataset', '--out', '--now'].includes(a)) {
      if (!args[i + 1]) throw Error('Missing argument after ' + a);
      result[a.slice(2)] = args[++i];
    } else if (a === '--test-data') result.testData = true;
    else if (a === '--help') result.help = true;
    else if (a.startsWith('--')) throw Error('Unknown option ' + a);
    else result.inputs.push(a);
  }
  return result;
}
function memoryStorage() {
  const data = new Map();
  return {get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v))};
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => { const bytes = fs.readFileSync(file); return {value: JSON.parse(bytes), sha256: sha(bytes), bytes: bytes.length}; };
function envelopes(value, datasetId, origin) {
  if (Array.isArray(value)) return value.flatMap((x, i) => {
    if (!x || !x.data) throw Error('Batch archive must contain {path, data} entries');
    return envelopes(x.data, datasetId, origin + ':' + (x.path || i));
  });
  if (!value || value.dataset_id !== datasetId) throw Error('dataset_id mismatch in ' + origin);
  if (Array.isArray(value.history)) return [{origin, data: value, batches: []}];
  if (Array.isArray(value.entries)) {
    const common = {dataset_id: value.dataset_id, source_manifest_sha256: value.source_manifest_sha256 ?? null,
      is_test: value.is_test === true};
    const modern = value.entries.filter(e => e?.schema_version === 2), legacy = value.entries.filter(e => e?.schema_version !== 2);
    return [
      ...(modern.length ? [{origin, data: {...common, schema_version: 2, history: modern}, batches: [value]}] : []),
      ...(legacy.length ? [{origin, data: {...common, schema_version: 1, history: legacy.map(e => e && ({...e,
        is_test: value.is_test === true ? true : (e.is_test ?? false)}))}, batches: [value]}] : [])
    ];
  }
  throw Error('Expected annotation history or immutable batch entries in ' + origin);
}
function queueBatches(backup) {
  const q = backup?.queue;
  if (!q) return [];
  return [...(q.batch ? [q.batch] : []), ...(Array.isArray(q.recovered_batches) ? q.recovered_batches : []),
    ...(Array.isArray(q.receipts) ? q.receipts.filter(r => r?.batch).map(r => r.batch) : [])];
}
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('node P318-recover.cjs --dataset data.json --out P318-recovered [--now ISO] [--test-data] export-a.json export-b.json [batch.json ...]');
    console.log('Exit 0: closed and conflict-free; 3: inspect conflicts/quarantine/incomplete history; 2: input or command error.');
    return 0;
  }
  if (!args.dataset || !args.out || !args.inputs.length) throw Error('Provide --dataset, --out and at least one input file');
  const datasetRead = read(args.dataset), dataset = Core.validateDataset(datasetRead.value);
  const at = args.now ? new Date(args.now).toISOString() : new Date().toISOString();
  let serial = 0;
  const store = Core.createStore({dataset, storage: memoryStorage(), isTest: args.testData === true, now: () => at,
    id: () => 'P318-offline-' + (++serial), digest: async value => sha(value)});
  const report = {schema_version: 1, generated_at: at, method: 'offline merge using the browser core; no remote writes',
    dataset: {path: args.dataset, sha256: datasetRead.sha256}, inputs: [], batch_conflicts: [], batch_errors: [], queue_errors: []};
  const batches = new Map(), queues = [], recoveryEvidence = new Map();
  function retainRaw(origin, raw) {
    if (typeof raw === 'string' && !recoveryEvidence.has(raw)) recoveryEvidence.set(raw, {origin, raw});
  }
  function collectBatch(batch, origin) {
    try { Core.validateBatch(batch, dataset); }
    catch (e) { report.batch_errors.push({origin, reason: e.message, raw: batch}); return; }
    if (!args.testData && (batch.is_test === true || batch.entries.some(e => e.is_test === true))) {
      report.batch_errors.push({origin, reason: 'test batch is not a production recovery batch', raw: batch}); return;
    }
    if (batches.has(batch.batch_id) && Core.stable(batches.get(batch.batch_id)) !== Core.stable(batch)) {
      report.batch_conflicts.push({batch_id: batch.batch_id, origin, first: batches.get(batch.batch_id), incoming: batch}); return;
    }
    batches.set(batch.batch_id, batch);
  }
  function collectBackup(backup, origin, outerIsTest) {
    if (!backup || typeof backup !== 'object') return;
    retainRaw(origin + ':legacy sync queue', backup.legacy_queue?.raw);
    retainRaw(origin + ':unreadable sync queue', backup.corrupt_queue_raw);
    if (!backup.queue) return; // Original schema-1 exports have summary counts only.
    try {
      if (backup.schema_version !== 2 || backup.dataset_id !== dataset.dataset_id) throw Error('invalid sync backup envelope');
      const q = Core.validateQueue(backup.queue, dataset), bb = queueBatches({queue: q});
      if (!args.testData && (outerIsTest || q.is_test === true || q.pending.some(e => e.is_test === true) ||
        bb.some(b => b.is_test === true || b.entries.some(e => e.is_test === true)))) throw Error('test queue is not a production recovery queue');
      q.recovered_evidence.forEach(e => retainRaw(e.origin, e.raw));
      const incomingBatches = new Map(batches);
      for (const b of bb) {
        if (incomingBatches.has(b.batch_id) && Core.stable(incomingBatches.get(b.batch_id)) !== Core.stable(b))
          throw Error('same batch_id has different recovered payloads');
        incomingBatches.set(b.batch_id, b);
      }
      queues.push({origin, queue: q, is_test: outerIsTest || q.is_test === true});
      bb.forEach(b => collectBatch(b, origin));
    } catch (e) { report.queue_errors.push({origin, reason: e.message, raw: backup.queue}); }
  }
  for (const file of args.inputs) {
    const input = read(file);
    const item = {path: file, sha256: input.sha256, size_bytes: input.bytes, imports: []};
    for (const envelope of envelopes(input.value, dataset.dataset_id, file)) {
      const result = await store.importData(envelope.data, envelope.origin);
      item.imports.push({origin: envelope.origin, ...result});
      envelope.batches.forEach(b => collectBatch(b, envelope.origin));
      collectBackup(envelope.data.server_sync, envelope.origin, envelope.data.is_test === true);
    }
    report.inputs.push(item);
  }
  let state = store.snapshot();
  const pending = new Map();
  function collectPending(e, origin) {
    if (e && typeof e.event_id === 'string') {
      if (pending.has(e.event_id) && Core.stable(pending.get(e.event_id)) !== Core.stable(e)) {
        report.queue_errors.push({origin, reason: 'same event_id has different pending entries', raw: e});
      } else pending.set(e.event_id, e);
    }
  }
  for (const {origin, queue, is_test} of queues) {
    try {
      Core.validateHistoryBinding([...queue.pending, ...queueBatches({queue}).flatMap(b => b.entries)], state.history, dataset);
      // Complete raw-identity checks before deriving any legacy journal event.
      // A diagnosed queue must not already have selected an image.
      const checkedEntries = new Map();
      for (const e of [...batches.values()].flatMap(b => b.entries).concat([...pending.values()], queue.pending)) {
        if (checkedEntries.has(e.event_id) && Core.stable(checkedEntries.get(e.event_id)) !== Core.stable(e))
          throw Error('same event_id has different pending or batch entries');
        checkedEntries.set(e.event_id, e);
      }
      const legacy = Core.legacyQueueEntries({...queue, is_test});
      if (legacy.length) {
        await store.importData({schema_version: 1, dataset_id: dataset.dataset_id, history: legacy}, origin + ':accepted legacy sync queue');
        state = store.snapshot();
      }
      queue.pending.forEach(e => collectPending(e, origin));
    } catch (e) { report.queue_errors.push({origin, reason: e.message, raw: queue}); }
  }
  for (const batch of batches.values()) {
    try {
      Core.validateHistoryBinding(batch.entries, state.history, dataset);
      batch.entries.forEach(e => collectPending(e, batch.batch_id));
    } catch (e) { report.batch_errors.push({origin: batch.batch_id, reason: e.message, raw: batch}); }
  }
  const problems = [
    ...report.batch_errors.map(e => ({origin: e.origin, reason: 'sync batch: ' + e.reason, raw: e.raw})),
    ...report.queue_errors.map(e => ({origin: e.origin, reason: 'sync queue: ' + e.reason, raw: e.raw})),
    ...report.batch_conflicts.map(e => ({origin: e.origin, reason: 'sync batch ID has conflicting payloads', raw: e})),
  ];
  if (problems.length) await store.importData({schema_version: 2, dataset_id: dataset.dataset_id, history: [], quarantine: problems}, 'offline recovery diagnostics');
  const sync = batches.size || pending.size || recoveryEvidence.size ? {schema_version: 2, dataset_id: dataset.dataset_id,
    summary: {provider: 'github', confirmed_events: 0, note: 'Recovered batch identities require remote readback'},
    queue: {schema_version: 2, client_id: 'P318-offline-recovery', pending: [...pending.values()], seen: [], confirmed: 0,
      receipts: [], recovered_batches: report.batch_conflicts.length || report.batch_errors.length || report.queue_errors.length ? [] : [...batches.values()],
      recovered_evidence: [...recoveryEvidence.values()], is_test: args.testData === true}} : null;
  const exported = store.exportData(sync);
  report.result = {history_records: exported.history.length, current_choices: exported.items.length,
    conflicts: exported.conflicts.length, quarantined: exported.quarantine.length, archived: state.archived.length,
    incomplete: state.incomplete_event_ids.length, recovered_batches: sync?.queue.recovered_batches.length || 0,
    recovered_evidence_records: recoveryEvidence.size, queue_errors: report.queue_errors.length, remote_confirmations: 0};
  const output = path.resolve(args.out); fs.mkdirSync(output, {recursive: true});
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(Core.sanitizeBackup(value), null, 2) + '\n');
  write('P318-merged-annotations.json', exported);
  write('P318-merge-report.json', report);
  write('P318-conflicts-and-quarantine.json', {conflicts: exported.conflicts, quarantine: exported.quarantine,
    incomplete_event_ids: state.incomplete_event_ids, batch_conflicts: report.batch_conflicts, batch_errors: report.batch_errors, queue_errors: report.queue_errors});
  const needsAttention = exported.conflicts.length || exported.quarantine.length || state.incomplete_event_ids.length || report.batch_conflicts.length || report.batch_errors.length || report.queue_errors.length;
  console.log(JSON.stringify({output, ...report.result, exit_code: needsAttention ? 3 : 0}));
  return needsAttention ? 3 : 0;
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 2; });
module.exports = {main, envelopes};
