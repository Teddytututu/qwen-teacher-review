/* Qwen review event journal. No DOM, network, timers, or credentials. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./review-validation.js') : root.reviewValidation);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QwenReviewCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function (Validation) {
  'use strict';
  const SCHEMA = 2;
  const HASH = /^[a-f0-9]{64}$/i;
  const choices = new Set(['old', 'new', 'redo']);
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const clone = x => JSON.parse(JSON.stringify(x));
  const text = x => typeof x === 'string' && x.length > 0;
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  // Untrusted imports can place credentials inside quarantine/raw recovery text.
  // Backups never retain credential fields, including nested damaged queues.
  function sanitizeBackup(value) {
    if (Array.isArray(value)) return value.map(sanitizeBackup);
    if (object(value)) return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:token|access_token|refresh_token|authorization|password|secret|github_token|gh_token)$/i.test(key))
      .map(([key, entry]) => [key, sanitizeBackup(entry)]));
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); if (object(parsed) || Array.isArray(parsed)) { const clean = sanitizeBackup(parsed); return stable(clean) === stable(parsed) ? value : JSON.stringify(clean); } } catch {}
      return value.replace(/(Bearer\s+)[A-Za-z0-9_.\-]+/gi, '$1[REDACTED]')
        .replace(/((?:["'])?(?:token|password|secret|authorization)(?:["'])?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1"[REDACTED]"');
    }
    return value;
  }
  function insist(ok, message) { if (!ok) throw new Error(message); }
  function hash(value, field) {
    insist(typeof value === 'string' && HASH.test(value), field + ' must be a SHA256 hex string');
    return value.toLowerCase();
  }
  function pathId(value, field) {
    insist(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), field + ' must be a single safe path component');
    return value;
  }
  function versions(xs, legacy = false) {
    insist(Array.isArray(xs) && xs.length >= 1 && xs.length <= 2, 'versions must contain old and optional new');
    const seen = new Set();
    const result = xs.map(v => {
      insist(object(v) && ['old', 'new'].includes(v.key) && !seen.has(v.key), 'invalid or duplicate version key');
      seen.add(v.key);
      insist(legacy || text(v.generation_version), 'generation_version is required for a new decision');
      insist(v.generation_version == null || text(v.generation_version), 'invalid generation_version');
      return {key: v.key, native_sha256: hash(v.native_sha256, 'native_sha256'),
        generation_version: v.generation_version ?? null,
        ...(v.config_sha256 == null ? {} : {config_sha256: hash(v.config_sha256, 'config_sha256')})};
    });
    insist(seen.has('old'), 'old version is required');
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  // Image content defines a comparison. Generation/config metadata is frozen
  // on the event; a metadata-only rename does not require another visual review.
  function comparisonKey(datasetId, source) {
    return stable([SCHEMA, datasetId, source.source_uid, source.source_sha256.toLowerCase(),
      versions(source.versions, true).map(v => [v.key, v.native_sha256])]);
  }
  function validateDataset(data) {
    insist(object(data) && text(data.dataset_id) && Array.isArray(data.items), 'invalid dataset envelope');
    hash(data.source_manifest_sha256, 'source_manifest_sha256');
    const ids = new Set(), uids = new Set();
    for (const x of data.items) {
      insist(object(x) && text(x.id) && !ids.has(x.id) && text(x.source_uid) && !uids.has(x.source_uid), 'duplicate or missing item identity');
      ids.add(x.id); uids.add(x.source_uid);
      hash(x.source_sha256, 'source_sha256'); versions(x.versions);
    }
    return data;
  }
  function createSourceValidator(data) {
    insist(Validation && typeof Validation.createValidator === 'function', 'shared review validator is unavailable');
    const validator = Validation.createValidator();
    validator.configureSources(validateDataset(data).items);
    return validator;
  }
  function timestamp(value) {
    insist(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'updated_at must be an ISO timestamp');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    insist(month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate(), 'invalid calendar date');
    insist(Number.isFinite(Date.parse(value)), 'invalid updated_at');
    return new Date(value).toISOString();
  }
  function normalizeEvent(raw, data, {legacy = false} = {}) {
    insist(object(raw), 'record must be an object');
    insist(legacy || raw.schema_version === SCHEMA, 'invalid event schema_version');
    insist(raw.is_test == null || typeof raw.is_test === 'boolean', 'is_test must be boolean');
    insist(raw.dataset_id == null ? legacy : raw.dataset_id === data.dataset_id, 'dataset_id mismatch');
    insist(text(raw.source_uid), 'missing source_uid');
    insist(choices.has(raw.choice), 'invalid choice');
    const vv = versions(raw.versions ?? raw.compared_versions, legacy || raw.legacy === true);
    insist(raw.choice === 'redo' || vv.some(v => v.key === raw.choice), 'choice has no compared image');
    const selected = vv.find(v => v.key === raw.choice);
    if (raw.selected_native_sha256 !== undefined) insist(raw.selected_native_sha256 === (selected?.native_sha256 ?? null), 'selected_native_sha256 contradicts choice');
    if (raw.selected_generation_version !== undefined && !legacy) insist(raw.selected_generation_version === (selected?.generation_version ?? null), 'selected_generation_version contradicts compared version');
    const out = {
      schema_version: SCHEMA, event_id: raw.event_id,
      dataset_id: data.dataset_id,
      source_manifest_sha256: raw.source_manifest_sha256 == null && (legacy || raw.legacy === true) ? null : hash(raw.source_manifest_sha256, 'source_manifest_sha256'),
      source_uid: raw.source_uid, source_sha256: hash(raw.source_sha256, 'source_sha256'),
      versions: vv, choice: raw.choice, updated_at: timestamp(raw.updated_at),
      client_id: typeof raw.client_id === 'string' ? raw.client_id : 'legacy-unknown',
      parents: raw.parents == null && legacy ? [] : raw.parents,
      selected_native_sha256: selected?.native_sha256 ?? null,
      selected_generation_version: selected?.generation_version ?? null,
      is_test: raw.is_test === true, legacy: legacy || raw.legacy === true
    };
    insist(text(out.event_id), 'missing event_id');
    insist(Array.isArray(out.parents) && out.parents.every(text) && !out.parents.includes(out.event_id), 'invalid parents');
    out.parents = [...new Set(out.parents)].sort();
    for (const name of ['id', 'source_id', 'split', 'license', 'attribution', 'reviewer_id', 'review_method',
      'legacy_fingerprint', 'legacy_original_event_id', 'legacy_record_kind', 'evidence_kind']) {
      if (typeof raw[name] === 'string') out[name] = raw[name];
    }
    out.comparison_key = comparisonKey(data.dataset_id, out);
    if (raw.comparison_key !== undefined) insist(raw.comparison_key === out.comparison_key, 'comparison_key contradicts fields');
    return out;
  }
  function validateBatch(batch, data) {
    insist(stable(sanitizeBackup(batch)) === stable(batch), 'credential fields cannot enter a sync batch');
    insist(object(batch) && batch.dataset_id === data.dataset_id, 'invalid batch identity');
    pathId(batch.client_id, 'client_id'); pathId(batch.batch_id, 'batch_id');
    timestamp(batch.created_at);
    insist(batch.is_test == null || typeof batch.is_test === 'boolean', 'batch is_test must be boolean');
    if (batch.source_manifest_sha256 != null) hash(batch.source_manifest_sha256, 'batch source_manifest_sha256');
    insist(Array.isArray(batch.entries) && batch.entries.length > 0 && batch.entries.length <= 5, 'batch must have one to five entries');
    const ids = new Set();
    for (const entry of batch.entries) {
      insist(object(entry) && text(entry.event_id) && !ids.has(entry.event_id), 'missing or repeated batch event_id');
      ids.add(entry.event_id);
      if (entry.schema_version === SCHEMA) normalizeEvent(entry, data);
      else normalizeEvent({...entry, dataset_id: entry.dataset_id ?? data.dataset_id, parents: []}, data, {legacy: true});
    }
    return batch; // Validation must not alter bytes used by an immutable batch.
  }
  function validateQueueEntry(e, data) {
    insist(stable(sanitizeBackup(e)) === stable(e), 'credential fields cannot enter a sync queue');
    insist(object(e) && text(e.event_id), 'queue entry has no event_id');
    if (e.schema_version === SCHEMA) normalizeEvent(e, data);
    else normalizeEvent({...e, dataset_id: e.dataset_id ?? data.dataset_id,
      source_manifest_sha256: e.source_manifest_sha256 ?? data.source_manifest_sha256, parents: []}, data, {legacy: true});
    return e;
  }
  function validateQueue(s, data) {
    insist(object(s) && typeof s.client_id === 'string' && Array.isArray(s.pending) && Array.isArray(s.seen) &&
      Array.isArray(s.receipts) && Number.isInteger(s.confirmed) && s.confirmed >= 0, 'invalid sync queue');
    pathId(s.client_id, 'queue client_id');
    insist(s.is_test == null || typeof s.is_test === 'boolean', 'queue is_test must be boolean');
    insist(s.seen.every(f => typeof f === 'string'), 'invalid seen fingerprints');
    s.pending.forEach(e => validateQueueEntry(e, data));
    s.receipts.forEach(r => { insist(object(r), 'invalid receipt'); if (r.batch) validateBatch(r.batch, data); });
    if (s.batch) validateBatch(s.batch, data);
    insist(s.recovered_batches == null || Array.isArray(s.recovered_batches), 'invalid recovered batches');
    if (s.recovered_batches) s.recovered_batches.forEach(b => validateBatch(b, data));
    insist(s.recovered_evidence == null || Array.isArray(s.recovered_evidence) &&
      s.recovered_evidence.every(e => object(e) && typeof e.origin === 'string' && typeof e.raw === 'string'), 'invalid recovered evidence');
    return {...s, recovered_batches: s.recovered_batches || [], recovered_evidence: s.recovered_evidence || []};
  }
  function validateHistoryBinding(entries, history, data) {
    const authoritative = new Map(history.filter(e => e.schema_version === SCHEMA)
      .map(e => [e.event_id, normalizeEvent(e, data)]));
    for (const e of entries) if (e.schema_version === SCHEMA) {
      insist(authoritative.has(e.event_id) &&
        stable(authoritative.get(e.event_id)) === stable(normalizeEvent(e, data)), 'recovered-history-conflict');
    }
    return entries;
  }
  function legacyQueueEntries(queue) {
    // Derive journal evidence from accepted legacy pending without changing the
    // immutable queue/batch bytes. A batch's declared manifest is historical
    // context; the current dataset must never fill it in.
    const batches = [...(queue.batch ? [queue.batch] : []), ...(queue.recovered_batches || []),
      ...(queue.receipts || []).filter(r => r?.batch).map(r => r.batch)];
    const evidence = new Map();
    for (const entry of queue.pending) if (entry.schema_version !== SCHEMA) {
      const matched = batches.filter(b => b.entries.some(e => e.event_id === entry.event_id && stable(e) === stable(entry)));
      const declared = entry.source_manifest_sha256 != null ? [entry.source_manifest_sha256] :
        matched.map(b => b.source_manifest_sha256).filter(value => value != null);
      const contexts = declared.length ? [...new Set(declared)].sort() : [null];
      for (const manifest of contexts) {
        const derived = {...entry, is_test: queue.is_test === true || entry.is_test === true || matched.some(b => b.is_test === true),
          ...(manifest == null ? {} : {source_manifest_sha256: manifest})};
        evidence.set(stable(derived), derived);
      }
    }
    return [...evidence.values()];
  }
  function order(a, b) { return a.updated_at.localeCompare(b.updated_at) || a.event_id.localeCompare(b.event_id); }
  function graphErrors(events) {
    const index = new Map(events.map(e => [e.event_id, e]));
    const bad = new Map(), visiting = new Set(), done = new Set();
    function walk(id, path) {
      if (visiting.has(id)) { for (const cycleId of path.slice(path.indexOf(id))) bad.set(cycleId, 'cycle in parents'); return; }
      if (done.has(id)) return;
      visiting.add(id);
      const e = index.get(id);
      for (const parent of e.parents) {
        const p = index.get(parent);
        if (!p) continue;
        if (p.comparison_key !== e.comparison_key) { bad.set(id, 'parent belongs to another comparison'); continue; }
        walk(parent, [...path, id]);
      }
      visiting.delete(id); done.add(id);
    }
    for (const id of index.keys()) walk(id, []);
    return bad;
  }
  function project(events) {
    const groups = new Map();
    for (const e of events) {
      if (!groups.has(e.comparison_key)) groups.set(e.comparison_key, []);
      groups.get(e.comparison_key).push(e);
    }
    const result = new Map();
    for (const [key, history] of groups) {
      history.sort(order);
      const indexed = new Map(history.map(e => [e.event_id, e])), closed = new Map();
      function isClosed(e, path = new Set()) {
        if (closed.has(e.event_id)) return closed.get(e.event_id);
        if (path.has(e.event_id)) return false;
        const next = new Set(path); next.add(e.event_id);
        const complete = e.parents.every(id => indexed.has(id) && isClosed(indexed.get(id), next));
        closed.set(e.event_id, complete); return complete;
      }
      const eligible = history.filter(e => isClosed(e));
      const parents = new Set(eligible.flatMap(e => e.parents));
      const heads = eligible.filter(e => !parents.has(e.event_id));
      const conflict = new Set(heads.map(e => e.choice)).size > 1;
      result.set(key, {history, heads, conflict, decision: conflict ? null : heads[heads.length - 1] ?? null,
        incomplete_event_ids: history.filter(e => !isClosed(e)).map(e => e.event_id),
        missing_parents: [...new Set(history.flatMap(e => e.parents).filter(id => !indexed.has(id)))]});
    }
    return result;
  }
  function legacyFingerprint(raw) { return [raw.source_uid, raw.updated_at, raw.choice, ...raw.versions.map(v => v.native_sha256)].join('|'); }
  async function legacyEvent(raw, data, digest, envelopeManifest = null) {
    insist(object(raw), 'record must be an object');
    const vv = versions(raw.versions ?? raw.compared_versions, true);
    const selected = vv.find(v => v.key === raw.choice);
    if (selected && text(raw.selected_generation_version)) {
      insist(selected.generation_version == null || selected.generation_version === raw.selected_generation_version, 'legacy generation evidence disagrees');
      selected.generation_version = raw.selected_generation_version;
    }
    // Legacy drafts and queue entries are evidence records, not reconstructed
    // clicks. Different surviving provenance is retained without overwriting it.
    const normalized = normalizeEvent({...raw, source_manifest_sha256: raw.source_manifest_sha256 ?? envelopeManifest,
      event_id: 'legacy-identity-placeholder', parents: [],
      legacy_fingerprint: legacyFingerprint({...raw, versions: raw.versions ?? raw.compared_versions}),
      ...(raw.event_id ? {legacy_original_event_id: raw.event_id} : {}),
      legacy_record_kind: raw.event_id ? 'queue_event' : 'snapshot',
      versions: vv, selected_generation_version: selected?.generation_version ?? null}, data, {legacy: true});
    const identity = {...normalized}; delete identity.event_id;
    normalized.event_id = 'legacy-' + await digest(stable(identity));
    return normalized;
  }
  async function defaultDigest(value) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  }
  function createStore({dataset, storage, now = () => new Date().toISOString(), id = () => globalThis.crypto.randomUUID(), digest = defaultDigest, isTest = false}) {
    validateDataset(dataset);
    const scope = (isTest ? 'test:' : '') + encodeURIComponent(dataset.dataset_id) + ':';
    const prefix = 'qwen-review:event:v2:' + scope;
    const quarantinePrefix = 'qwen-review:quarantine:v2:' + scope;
    const events = new Map(), unsaved = new Set(), quarantine = new Map();
    let storageError = '', clientId = id();
    const memoryErrors = new Map();
    const io = () => typeof storage === 'function' ? storage() : storage;
    function accept(raw) {
      const event = normalizeEvent(raw, dataset);
      insist(isTest || !event.is_test, 'test record is not a production annotation');
      return event;
    }
    function reject(raw, reason, origin, key = id()) {
      const safeRaw = sanitizeBackup(clone(raw));
      const duplicate = [...quarantine.values()].find(q => q.reason === reason && stable(q.raw) === stable(safeRaw));
      if (duplicate) return duplicate;
      const record = {record_id: key, origin, reason, raw: safeRaw, captured_at: now()};
      quarantine.set(key, record);
      try { io().setItem(quarantinePrefix + key, stable(record)); } catch (e) { storageError = e.message; }
      return record;
    }
    function append(event) {
      const e = accept(event), encoded = stable(e), previous = events.get(e.event_id);
      if (previous && stable(previous) !== encoded) { reject(e, 'event_id collision', 'append'); return {persisted: false, collision: true}; }
      const candidateGraph = new Map(events); candidateGraph.set(e.event_id, e);
      const bad = graphErrors([...candidateGraph.values()]);
      if (bad.has(e.event_id)) { reject(e, bad.get(e.event_id), 'append'); return {persisted: false, collision: true}; }
      events.set(e.event_id, e);
      try {
        const disk = io().getItem(prefix + e.event_id);
        if (disk !== null && stable(normalizeEvent(JSON.parse(disk), dataset)) !== encoded) {
          reject(e, 'event_id collision on disk', 'append');
          if (previous) { events.set(e.event_id, previous); unsaved.add(e.event_id); }
          else events.delete(e.event_id);
          return {persisted: false, collision: true};
        }
        io().setItem(prefix + e.event_id, encoded);
        insist(io().getItem(prefix + e.event_id) === encoded, 'local readback failed');
        unsaved.delete(e.event_id); storageError = '';
        return {persisted: true, duplicate: Boolean(previous)};
      } catch (error) {
        unsaved.add(e.event_id); storageError = error.message;
        return {persisted: false, error: error.message};
      }
    }
    function refresh() {
      try {
        const persisted = new Set(), disk = io(), keys = [];
        for (let i = 0; i < disk.length; i++) keys.push(disk.key(i));
        for (const key of keys) {
          if (key?.startsWith(prefix)) {
            const raw = disk.getItem(key);
            try {
              const e = accept(JSON.parse(raw));
              insist(key === prefix + e.event_id, 'event storage key mismatch');
              const existing = events.get(e.event_id);
              insist(!existing || stable(existing) === stable(e), 'event_id collision on refresh');
              events.set(e.event_id, e); persisted.add(e.event_id); unsaved.delete(e.event_id);
            } catch (error) {
              const eventId = key.slice(prefix.length);
              if (events.has(eventId)) unsaved.add(eventId);
              memoryErrors.set(key, {origin: key, reason: error.message, raw});
            }
          } else if (key?.startsWith(quarantinePrefix)) {
            try { const q = JSON.parse(disk.getItem(key)); if (object(q) && text(q.record_id)) quarantine.set(q.record_id, q); }
            catch (error) { memoryErrors.set(key, {origin: key, reason: error.message, raw: disk.getItem(key)}); }
          }
        }
        // Do not erase malformed histories. snapshot() derives quarantine and
        // incomplete chains identically in warm tabs and a fresh browser.
        for (const eventId of events.keys()) if (!persisted.has(eventId)) unsaved.add(eventId);
        storageError = '';
      } catch (error) { storageError = error.message; }
      return snapshot();
    }
    function snapshot() {
      const graph = graphErrors([...events.values()]);
      const history = [...events.values()].filter(e => !graph.has(e.event_id)).sort(order);
      const groups = project(history);
      const currentKeys = new Set(dataset.items.map(x => comparisonKey(dataset.dataset_id, x)));
      return {history, groups, unsaved: [...unsaved].filter(id => !graph.has(id)), storage_error: storageError,
        incomplete_event_ids: [...groups.values()].flatMap(g => g.incomplete_event_ids),
        quarantine: [...quarantine.values(), ...memoryErrors.values(), ...[...graph].map(([eventId, reason]) => ({origin: prefix + eventId, reason, raw: events.get(eventId)}))],
        archived: history.filter(e => !currentKeys.has(e.comparison_key)),
        conflicts: [...groups.entries()].filter(([key, g]) => currentKeys.has(key) && g.conflict).map(([key, g]) => ({comparison_key: key, event_ids: g.heads.map(e => e.event_id)}))};
    }
    function choose(item, choice) {
      const key = comparisonKey(dataset.dataset_id, item);
      const currentGroup = snapshot().groups.get(key);
      const e = normalizeEvent({schema_version: SCHEMA, event_id: id(), dataset_id: dataset.dataset_id,
        source_manifest_sha256: dataset.source_manifest_sha256, ...clone(item), versions: versions(item.versions), choice,
        updated_at: now(), client_id: clientId, parents: currentGroup?.heads.map(e => e.event_id) ?? [], is_test: isTest,
        review_method: isTest ? 'automated offline fixture; synthetic display images' : 'human comparison: old/new/both redo'}, dataset);
      const result = append(e);
      return {event: e, ...result};
    }
    async function importData(data, origin = 'import') {
      insist(object(data) && data.dataset_id === dataset.dataset_id && Array.isArray(data.history), '请选择本数据集的标注文件（须含 history 数组）');
      insist([1, 2].includes(data.schema_version), 'unsupported annotation schema_version');
      const stats = {accepted: 0, duplicates: 0, quarantined: 0, unsaved: 0, archived: 0, conflicts: 0};
      const candidates = new Map();
      for (let i = 0; i < data.history.length; i++) {
        const raw = data.history[i];
        try {
          const marked = data.is_test === true && object(raw) ? {...raw, is_test: true} : raw;
          const normalized = data.schema_version === 1 ? await legacyEvent(marked, dataset, digest, data.source_manifest_sha256 ?? null) : normalizeEvent(marked, dataset);
          const e = accept(normalized);
          const existing = candidates.get(e.event_id) ?? events.get(e.event_id);
          insist(!existing || stable(existing) === stable(e), 'event_id collision');
          if (existing) stats.duplicates++; else candidates.set(e.event_id, e);
        } catch (error) { reject(raw, error.message, origin + ':history[' + i + ']'); stats.quarantined++; }
      }
      const all = new Map([...events, ...candidates]);
      const bad = graphErrors([...all.values()]);
      // Incomplete ancestors do not select an image. A cross-comparison child
      // becomes inspectable quarantine when its parent arrives, in any order.
      for (const [eventId, reason] of bad) if (candidates.has(eventId)) {
        reject(candidates.get(eventId), reason, origin); candidates.delete(eventId); stats.quarantined++;
      }
      for (const e of candidates.values()) {
        const result = append(e);
        if (result.collision) stats.quarantined++;
        else { stats.accepted++; if (!result.persisted) stats.unsaved++; }
      }
      if (Array.isArray(data.quarantine)) for (const q of data.quarantine) {
        if (object(q) && text(q.reason)) { reject(q.raw ?? q, q.reason, 'restored:' + (q.origin ?? origin)); stats.quarantined++; }
      }
      const state = snapshot(); stats.archived = state.archived.length; stats.conflicts = state.conflicts.length;
      return stats;
    }
    function retrySave() {
      const results = [];
      for (const eventId of [...unsaved]) if (events.has(eventId)) results.push({event_id: eventId, ...append(events.get(eventId))});
      return results;
    }
    function exportData(sync) {
      const state = snapshot(), groups = state.groups;
      const items = dataset.items.flatMap(item => {
        const d = groups.get(comparisonKey(dataset.dataset_id, item))?.decision;
        return d ? [{id: item.id, event_id: d.event_id, source_uid: d.source_uid, source_id: d.source_id ?? item.source_id,
          source_sha256: d.source_sha256, source_manifest_sha256: d.source_manifest_sha256, split: d.split ?? item.split, license: d.license ?? item.license, attribution: d.attribution ?? item.attribution,
          choice: d.choice, status: d.choice === 'redo' ? 'redo' : 'pass', selected_native_sha256: d.selected_native_sha256,
          selected_generation_version: d.selected_generation_version, compared_versions: d.versions, updated_at: d.updated_at,
          comparison_key: d.comparison_key, legacy: d.legacy}] : [];
      });
      return sanitizeBackup({schema_version: SCHEMA, required_reader: 'qwen-review-event-journal-v2', dataset_id: dataset.dataset_id, source_manifest_sha256: dataset.source_manifest_sha256,
        exported_at: now(), review_method: isTest ? 'offline synthetic-image fixture' : 'human comparison: old/new/both redo',
        is_test: isTest, items, history: state.history, conflicts: state.conflicts, quarantine: state.quarantine,
        recovery: {unsaved_event_ids: state.unsaved, incomplete_event_ids: state.incomplete_event_ids,
          archived_event_ids: state.archived.map(e => e.event_id)}, server_sync: sync ?? null});
    }
    refresh();
    return {prefix, quarantinePrefix, dataset, isTest, append, refresh, choose, snapshot, importData, retrySave, exportData};
  }
  return {SCHEMA, stable, sanitizeBackup, pathId, versions, comparisonKey, validateDataset, createSourceValidator, normalizeEvent, validateBatch,
    validateQueueEntry, validateQueue, validateHistoryBinding, legacyQueueEntries, graphErrors, project, legacyEvent, createStore};
});
