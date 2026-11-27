'use strict';
(() => {
  const Core = window.QwenReviewCore;
  const API = window.QWEN_REVIEW_CONFIG?.apiBase || 'https://api.github.com/repos/OWNER/REPOSITORY';
  let dataset, KEY, state, busy = false, error = '', errorKind = '', corruptRaw = null, runtimeIsTest = false;
  let legacyInfo = {present: false}, scheduled = false, queueDirty = false, sourceValidator = null, validationFailure = null;
  const sources = new Map();
  const tokenKey = () => 'qwen-review-gh-token' + (runtimeIsTest ? ':test' : '');
  const token = () => { try { return sessionStorage.getItem(tokenKey()) || ''; } catch { return ''; } };
  const fingerprint = x => x.legacy_fingerprint || (x.schema_version === 2 ? 'event:' + x.event_id :
    [x.source_uid, x.updated_at, x.choice, ...x.versions.map(v => v.native_sha256)].join('|'));
  const fresh = () => ({schema_version: 2, client_id: crypto.randomUUID(), pending: [], seen: [], confirmed: 0, receipts: [], recovered_batches: [], recovered_evidence: [], is_test: false});
  function requireCondition(ok, message) { if (!ok) throw Error(message); }
  function validEntry(e) {
    requireCondition(sourceValidator, 'review-validation:not-ready');
    sourceValidator.validateHistoryEntry(e);
    return Core.validateQueueEntry(e, dataset);
  }
  function validBatch(b) {
    const valid=Core.validateBatch(b, dataset);
    valid.entries.forEach(validEntry);
    return valid;
  }
  function validateState(s) {
    const valid=Core.validateQueue(s, dataset);
    valid.pending.forEach(validEntry);
    const retainedBatches=[...(valid.batch?[valid.batch]:[]),...valid.recovered_batches,...valid.receipts.filter(r=>r?.batch).map(r=>r.batch)];
    retainedBatches.forEach(validBatch);
    // Legacy queues may legitimately have pending/receipts but no seen index.
    // Rebuild only the derived index, after validation; preserve immutable bytes.
    const seen=new Set(valid.seen);
    for(const entry of [...valid.pending,...retainedBatches.flatMap(batch=>batch.entries)])seen.add(fingerprint(entry));
    return {...valid,seen:[...seen]};
  }
  function load() {
    if (!KEY) return state;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === null) return state || fresh();
      const parsed = validateState(JSON.parse(raw));
      corruptRaw = null;
      return parsed;
    } catch (e) {
      try { corruptRaw = localStorage.getItem(KEY); } catch { corruptRaw = null; }
      errorKind = 'storage'; error = '同步队列读取失败；本机选择可导出，恢复包保留队列原文';
      throw e;
    }
  }
  function unqueued() {
    if (!state) return sources.size;
    const seen = new Set(state.seen);
    return [...sources.keys()].filter(f => !seen.has(f)).length;
  }
  function display() {
    const el = document.getElementById('sync-status'); if (!el) return;
    const b = document.getElementById('connect-github'); if (b) b.disabled = !dataset;
    if (!dataset) { el.textContent = '图片清单尚未完成加载，原队列已保留'; el.dataset.state='retry'; return; }
    const pending = state?.pending.length || 0, waiting = unqueued();
    el.textContent = busy ? '正在写入并读回核对 GitHub…' : error || (queueDirty ? '同步队列尚未写入本机；选择记录已保留，可重试或导出' :
      (waiting ? `${waiting} 条本机记录尚未进入同步队列` : !token() ?
        `待同步队列 ${pending} 条 · GitHub 尚未授权` :
        `GitHub 已读回确认 ${state.confirmed} 条 · 待同步 ${pending} 条`));
    if (state?.recovered_evidence.length) el.textContent += ` · 另有 ${state.recovered_evidence.length} 份同步原文可导出检查`;
    el.dataset.state = error ? 'retry' : busy ? 'saving' : pending || waiting ? 'pending' : 'confirmed';
    if (b) b.textContent = token() ? 'GitHub 已授权' : 'GitHub 保存设置';
  }
  function persist() {
    state.is_test = runtimeIsTest || Boolean(state.is_test);
    localStorage.setItem(KEY, JSON.stringify(state));
    queueDirty = false;
    if (errorKind === 'storage') { error = ''; errorKind = ''; }
    display();
  }
  async function lock(kind, callback, optional = false) {
    if (!navigator.locks?.request) {
      errorKind = 'locks'; error = '此浏览器缺少同步锁；本机选择可继续保存和导出'; display();
      throw Error('Web Locks unavailable');
    }
    return navigator.locks.request(KEY + ':' + kind, optional ? {ifAvailable: true} : {}, l => l ? callback() : undefined);
  }
  function addPending(e, seen = new Set(state.seen)) {
    const f = fingerprint(e);
    if (seen.has(f)) return false;
    const collision = state.pending.find(x => x.event_id === e.event_id);
    requireCondition(!collision || Core.stable(collision) === Core.stable(e), 'queue event_id collision');
    state.seen.push(f); seen.add(f); state.pending.push(e); return true;
  }
  function reconcile() { let changed = false; const seen = new Set(state.seen); for (const e of sources.values()) changed = addPending(e, seen) || changed; return changed; }
  function scheduleFlush() {
    if (busy || scheduled || ['conflict', 'permission', 'storage', 'locks'].includes(errorKind)) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; flush().catch(() => {}); }, 0);
  }
  async function enqueue(e) {
    try { validEntry(e); requireCondition(runtimeIsTest || !e.is_test, 'test entry cannot enter the production queue'); }
    catch(problem){validationFailure={where:'enqueue',reason:problem.message,raw:Core.sanitizeBackup(e)};errorKind='validation';error='标注关系校验失败，原记录已保留且未发送';display();return {queued:false,validation_failed:true};}
    sources.set(fingerprint(e), e); queueDirty = true;
    try {
      await lock('state', () => { state = load(); reconcile(); persist(); });
      if (state.pending.length >= 5) scheduleFlush();
      return {queued: true};
    } catch (e) {
      if (!error || errorKind !== 'locks') { errorKind = 'storage'; error = '本机选择已保留，待同步队列未写入；可重试或导出 JSON'; }
      display(); return {queued: false};
    }
  }
  function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);
  }
  function batchPath(batch) {
    return `${batch.is_test ? 'verification-batches' : 'batches'}/${batch.client_id}/${batch.created_at.slice(0, 10)}/${batch.batch_id}.json`;
  }
  async function request(path, options = {}) {
    if (API.includes('/OWNER/REPOSITORY')) throw Error('repository-not-configured');
    return (window.QWEN_REVIEW_CONFIG?.fetch || fetch)(API + path, {...options, headers: {
      Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token(), 'X-GitHub-Api-Version': '2026-03-10', ...options.headers
    }, signal: AbortSignal.timeout(20000)});
  }
  function checkedContent(content, encoded, expectedSha) {
    requireCondition(content && typeof content.content === 'string' && content.content.replace(/\s/g, '') === encoded, 'identity');
    requireCondition(typeof content.sha === 'string' && content.sha.length > 0 && (!expectedSha || content.sha === expectedSha), 'receipt');
    return {sha: content.sha, url: content.html_url || null};
  }
  async function flush(force = false) {
    if (!dataset) {display();return {confirmed:false,reason:"manifest-not-ready"};}
    try {
      // Repair a failed queue write even before authorization. The journal is
      // authoritative; a failed setItem must never turn a retry into a no-op.
      if (sources.size && (queueDirty || unqueued())) await seed([...sources.values()]);
      return await lock('upload', () => flushLocked(force), true);
    }
    catch (e) { display(); return {confirmed: false, reason: e.message}; }
  }
  async function flushLocked(force) {
    try { state = load(); } catch { display(); return; }
    if (busy || !token()) { display(); return; }
    let batch;
    try {
      await lock('state', () => {
        state = load(); const changed = reconcile();
        if (!state.batch && (state.recovered_batches.length || state.pending.length >= 5 || force && state.pending.length)) {
          state.batch = state.recovered_batches.shift() || {schema_version: 2, dataset_id: dataset.dataset_id,
            source_manifest_sha256: dataset.source_manifest_sha256, client_id: state.client_id,
            batch_id: crypto.randomUUID(), created_at: new Date().toISOString(), is_test: runtimeIsTest || Boolean(state.is_test), entries: state.pending.slice(0, 5)};
          // The batch identity is durable before the first network operation.
          persist();
        } else if (changed) persist();
        batch = state.batch;
      });
      if (!batch) { display(); return; }
      busy = true; display();
      const path = batchPath(batch), encoded = encode(batch);
      let receipt;
      const previous = await request('/contents/' + path + '?ref=annotations');
      if (previous.ok) receipt = checkedContent(await previous.json(), encoded);
      else if (previous.status === 404) {
        const saved = await request('/contents/' + path, {method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: `Save ${batch.entries.length} annotation events`, branch: 'annotations', content: encoded})});
        if ([401, 403].includes(saved.status)) throw Error('permission');
        if (saved.status === 409 || saved.status === 422) {
          const competing = await request('/contents/' + path + '?ref=annotations');
          if (!competing.ok) throw Error('retry');
          receipt = checkedContent(await competing.json(), encoded);
        } else {
          if (!saved.ok) throw Error('retry');
          const result = await saved.json();
          const checked = await request('/contents/' + path + '?ref=annotations');
          if (!checked.ok) throw Error('retry');
          receipt = checkedContent(await checked.json(), encoded, result.content?.sha);
        }
      } else if ([401, 403].includes(previous.status)) throw Error('permission');
      else throw Error('retry');
      await lock('state', () => {
        state = load();
        requireCondition(state.batch?.batch_id === batch.batch_id && Core.stable(state.batch) === Core.stable(batch), 'local-batch');
        const ids = new Set(batch.entries.map(e => e.event_id));
        const count = state.pending.filter(e => ids.has(e.event_id)).length;
        state.pending = state.pending.filter(e => !ids.has(e.event_id)); state.confirmed += count;
        const record = {batch_id: batch.batch_id, path, events: batch.entries.length, verified_at: new Date().toISOString(), ...receipt, batch};
        if (!state.receipts.some(r => r.batch_id === batch.batch_id)) state.receipts.push(record);
        delete state.batch; persist(); error = ''; errorKind = '';
      });
      return {confirmed: true, batch_id: batch.batch_id};
    } catch (e) {
      errorKind = ['identity', 'receipt', 'local-batch'].includes(e.message) ? 'conflict' : e.message === 'permission' ? 'permission' : 'retry';
      error = errorKind === 'conflict' ? '批次内容或回执不一致；本机记录与原批次已保留，请检查后重试' :
        errorKind === 'permission' ? 'GitHub 尚未确认保存；请检查专用令牌权限，待同步记录保留' :
        'GitHub 尚未读回确认；本机记录与批次保留，网络恢复后重试';
      try { state = load(); } catch {}
      return {confirmed: false, reason: e.message};
    } finally {
      busy = false; display();
      if (!error && state && (state.pending.length >= 5 || state.recovered_batches.length)) scheduleFlush();
    }
  }
  async function configure(data, {isTest = false} = {}) {
    requireCondition(!busy, 'cannot change datasets during upload');
    dataset = data; runtimeIsTest = isTest; sourceValidator=Core.createSourceValidator(data); validationFailure=null;
    KEY = 'qwen-github-sync:v2:' + (isTest ? 'test:' : '') + data.dataset_id; state = fresh();
    sources.clear(); error = ''; errorKind = ''; corruptRaw = null;
    queueDirty = false; legacyInfo = {present: false};
    // Read legacy state without modifying its key. A demo must never consume a
    // production queue, and old open tabs must not overwrite the v2 queue.
    let legacyRaw = null;
    try {
      legacyRaw = localStorage.getItem('qwen-github-sync:' + data.dataset_id);
      if (legacyRaw) {
        const previous = validateState(JSON.parse(legacyRaw));
        legacyInfo = {present: true, is_test: Boolean(previous.is_test), raw: legacyRaw};
        if (Boolean(previous.is_test) === runtimeIsTest) state = previous;
      }
    } catch (e) { legacyInfo = {present: legacyRaw === null ? null : true, error: e.message, raw: legacyRaw}; }
    try { state = load(); state.is_test = runtimeIsTest || Boolean(state.is_test); } catch {}
    display();
  }
  async function seed(events) {
    try { for (const e of events) {validEntry(e);requireCondition(runtimeIsTest || !e.is_test, 'test entry cannot enter the production queue');} }
    catch(problem){validationFailure={where:'seed',reason:problem.message};errorKind='validation';error='历史原记录已保留；来源身份不符的记录未进入同步队列';display();return {queued:false,validation_failed:true};}
    for (const e of events) {
      if (!sources.has(fingerprint(e))) queueDirty = true;
      sources.set(fingerprint(e), e);
    }
    if (!events.length) { display(); return; }
    try { await lock('state', () => { state = load(); const changed = reconcile(); if (changed || queueDirty || localStorage.getItem(KEY) === null) persist(); }); }
    catch { if (!error) { errorKind = 'storage'; error = '本机选择已保留，待同步队列未写入；可重试或导出 JSON'; } }
    display();
  }
  async function restore(backup, history = null) {
    if (!backup || backup.schema_version !== 2 || backup.dataset_id !== dataset.dataset_id || !backup.queue) return {restored: 0};
    let recovered;
    try { recovered = validateState(backup.queue); } catch { error = '选择已导入；恢复包的同步队列结构异常，原文保留在导入文件'; display(); return {restored: 0}; }
    const batches = [...(recovered.batch ? [recovered.batch] : []), ...recovered.recovered_batches,
      ...recovered.receipts.filter(r => r?.batch).map(r => r.batch)];
    const evidence = [...recovered.recovered_evidence];
    if (typeof backup.legacy_queue?.raw === 'string' && backup.legacy_queue.raw !== legacyInfo.raw)
      evidence.push({origin: 'imported legacy sync queue', raw: backup.legacy_queue.raw});
    if (typeof backup.corrupt_queue_raw === 'string' && backup.corrupt_queue_raw !== corruptRaw)
      evidence.push({origin: 'imported unreadable sync queue', raw: backup.corrupt_queue_raw});
    if (!runtimeIsTest && (recovered.is_test === true || recovered.pending.some(e => e?.is_test === true) ||
      batches.some(b => b.is_test === true || b.entries?.some(e => e?.is_test === true)))) {
      error = '测试同步记录已隔离，正式队列保持原状'; display(); return {restored: 0, test_data: true};
    }
    try {
      return await lock('state', () => {
        state = load(); let restored = 0;
        if (history !== null) {
          Core.validateHistoryBinding([...batches.flatMap(b => b.entries), ...recovered.pending], history, dataset);
        }
        const retained = [...(state.batch ? [state.batch] : []), ...state.recovered_batches,
          ...state.receipts.filter(r => r?.batch).map(r => r.batch)];
        const known = new Map(retained.map(b => [b.batch_id, b]));
        const incoming = new Map(known), entries = new Map([...retained.flatMap(b => b.entries), ...state.pending].map(e => [e.event_id, e]));
        // Inspect the complete recovery input before mutating the durable queue.
        // A reused ID with different bytes is evidence to inspect, not a duplicate.
        for (const b of batches) {
          validBatch(b);
          requireCondition(!incoming.has(b.batch_id) || Core.stable(incoming.get(b.batch_id)) === Core.stable(b), 'recovered-batch-conflict');
          incoming.set(b.batch_id, b);
        }
        for (const e of [...batches.flatMap(b => b.entries), ...recovered.pending]) {
          requireCondition(!entries.has(e.event_id) || Core.stable(entries.get(e.event_id)) === Core.stable(e), 'recovered-batch-conflict');
          entries.set(e.event_id, e);
        }
        const seen = new Set(state.seen);
        for (const b of batches) {
          if (known.has(b.batch_id)) continue;
          b.entries.forEach(e => { addPending(e, seen); });
          state.recovered_batches.push(b); known.set(b.batch_id, b); restored++;
        }
        recovered.pending.forEach(e => { addPending(e, seen); });
        // These opaque bytes are recovery evidence only, never upload entries.
        const knownRaw = new Set(state.recovered_evidence.map(e => e.raw));
        for (const e of evidence) if (!knownRaw.has(e.raw)) {
          state.recovered_evidence.push({origin: e.origin, raw: e.raw}); knownRaw.add(e.raw);
        }
        persist(); return {restored, receipts_require_readback: true};
      });
    } catch (e) {
      if (['recovered-batch-conflict', 'recovered-history-conflict'].includes(e.message)) {
        errorKind = 'conflict'; error = e.message === 'recovered-history-conflict' ?
          '恢复包的同步记录与选择历史不一致，存在冲突；已保存的选择保留，请检查原恢复包' :
          '恢复批次的相同编号对应不同内容，存在冲突；原队列保留，请检查两个恢复包';
      } else error = '选择已导入；同步队列尚未恢复，请保留恢复包并重试';
      display(); return {restored: 0, conflict: ['recovered-batch-conflict', 'recovered-history-conflict'].includes(e.message)};
    }
  }
  function summary() { return {provider: 'github', confirmed_events: state?.confirmed || 0, pending_events: state?.pending.length || 0,
    unqueued_events: unqueued(), recovered_evidence_records: state?.recovered_evidence.length || 0,
    error: error || null, receipts: state?.receipts.map(({batch, ...r}) => r) || []}; }
  function diagnostics(){
    let raw=null;try{raw=KEY?localStorage.getItem(KEY):null}catch{}
    let original=null,legacy=null;try{original=JSON.parse(raw)}catch{}
    try{legacy=JSON.parse(legacyInfo.raw)}catch{}
    return Core.sanitizeBackup({validation_ready:Boolean(sourceValidator),failure:validationFailure,
      pending:original?.pending||legacy?.pending||state?.pending||[],queue_raw:corruptRaw,legacy_queue:legacyInfo});
  }
  window.reviewSync = {configure, enqueue, seed, restore, diagnostics, flush: () => flush(true), summary, display,
    legacyPending: () => state ? Core.legacyQueueEntries(state) : [],
    legacyInfo: () => ({...legacyInfo}), storageKeys: () => ({queue: KEY, token: tokenKey(), is_test: runtimeIsTest}),
    backup: () => ({schema_version: 2, dataset_id: dataset?.dataset_id, summary: summary(), queue: state ? JSON.parse(JSON.stringify(state)) : null,
      corrupt_queue_raw: corruptRaw, legacy_queue: legacyInfo})};
  document.addEventListener('DOMContentLoaded', () => {
    display(); document.getElementById('sync-now').onclick = () => flush(true);
    const dialog = document.getElementById('auth-dialog');
    document.getElementById('connect-github').onclick = () => dialog.showModal();
    document.getElementById('auth-save').onclick = async () => {
      const input = document.getElementById('auth-token'), value = input.value.trim(), notice = document.getElementById('auth-notice');
      if (API.includes('/OWNER/REPOSITORY')) { notice.textContent = '请先在 config.js 配置审核仓库，然后重新打开页面'; return; }
      if (!value.startsWith('github_pat_')) { notice.textContent = '请使用只授权标注仓库的专用令牌'; return; }
      try {
        sessionStorage.setItem(tokenKey(), value); input.value = '';
        const response = await request(''); if (!response.ok) throw Error('permission');
        state = load(); const path = `${state.is_test ? 'verification-connections' : 'connections'}/${state.client_id}.json`;
        const body = {client_id: state.client_id, dataset_id: dataset.dataset_id, connected_at: new Date().toISOString(), is_test: Boolean(state.is_test)};
        const content = encode(body), previous = await request('/contents/' + path + '?ref=annotations');
        let sha; if (previous.ok) sha = (await previous.json()).sha; else if (previous.status !== 404) throw Error('permission');
        const checked = await request('/contents/' + path, {method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: 'Verify annotation storage authorization', branch: 'annotations', content, ...(sha ? {sha} : {})})});
        if (!checked.ok) throw Error('permission');
        const readback = await request('/contents/' + path + '?ref=annotations'); if (!readback.ok) throw Error('permission');
        checkedContent(await readback.json(), content); persist(); notice.textContent = 'GitHub读写授权已读回核对';
        error = ''; errorKind = ''; dialog.close(); display(); await flush(true);
      } catch {
        try { sessionStorage.removeItem(tokenKey()); } catch {}
        notice.textContent = '授权写入尚未完成读回核对，请检查令牌与仓库权限'; display();
      }
    };
    document.getElementById('auth-disconnect').onclick = () => {
      try { sessionStorage.removeItem(tokenKey()); } catch {}
      if (['permission', 'retry'].includes(errorKind)) { error = ''; errorKind = ''; }
      display(); dialog.close();
    };
  });
  window.addEventListener('online', () => flush(true));
  window.addEventListener('storage', e => { if (KEY && e.key === KEY) { try { state = load(); if (!state.pending.length) { error = ''; errorKind = ''; } } catch {} display(); } });
  setInterval(() => { if (!dataset) return; if (!['conflict', 'permission', 'storage', 'locks'].includes(errorKind)) flush(Boolean(error)); display(); }, 30000);
})();
