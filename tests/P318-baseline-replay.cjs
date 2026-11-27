#!/usr/bin/env node
'use strict';
// Executes the attached, UNMODIFIED app.js and sync.js in isolated JS realms.
// DOM/Storage/Web Locks/fetch are explicit deterministic test doubles.
// This file is not a browser-engine test; browser validation is separate.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const args = require('./P318-test-support.cjs').paths();
const ROOT = args.root;
const PAGE = path.join(ROOT, 'tests', 'baseline');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const APP = fs.readFileSync(path.join(PAGE, 'app.js'), 'utf8');
const SYNC = fs.readFileSync(path.join(PAGE, 'sync.js'), 'utf8');
const DRAFT_KEY = 'qwen-human-review:' + DATA.dataset_id;
const SYNC_KEY = 'qwen-github-sync:' + DATA.dataset_id;
const TOKEN_KEY = 'qwen-review-gh-token';
const T0 = '2026-11-26T00:00:00.000Z';
const T1 = '2026-11-26T00:00:01.000Z';
const clone = x => JSON.parse(JSON.stringify(x));
const fixture = () => ({...clone(DATA), items: [clone(DATA.items[0]), clone(DATA.items.find(x => x.versions.length === 1))]});
const nativeKey = x => x.source_uid + '|' + x.versions.map(v => v.key + ':' + v.native_sha256).join('|');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

class Storage {
  constructor() { this.values = new Map(); this.writes = []; this.failure = null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.failure && this.failure(key, value)) throw new Error('QuotaExceededError: injected storage write failure');
    this.values.set(key, String(value));
    this.writes.push({key, value: String(value)});
  }
  removeItem(key) { this.values.delete(key); }
  json(key) { const v = this.getItem(key); return v ? JSON.parse(v) : null; }
}

class Locks {
  constructor() { this.tails = new Map(); this.errors = []; this.requests = []; }
  request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    this.requests.push(name);
    const tail = this.tails.get(name);
    if (options.ifAvailable && tail) return Promise.resolve(callback(null));
    let result;
    result = (tail || Promise.resolve()).then(() => callback({name}));
    const settled = result.catch(e => { this.errors.push(String(e)); });
    this.tails.set(name, settled);
    settled.finally(() => { if (this.tails.get(name) === settled) this.tails.delete(name); });
    return result;
  }
  hold(name) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.tails.set(name, gate);
    return release;
  }
  async settle() {
    for (let i=0; i<20 && this.tails.size; i++) await Promise.all([...this.tails.values()]);
    await turns();
  }
}

const turns = async () => { for (let i=0; i<12; i++) await Promise.resolve(); };

function fakeDOM() {
  const nodes = new Map(), all = [], docListeners = new Map();
  class Element {
    constructor(tag = 'DIV', id) {
      this.tagName=tag.toUpperCase(); this.id=id; this.dataset={}; this.value=''; this.checked=false;
      this.textContent=''; this.hidden=false; this.disabled=false; this.children=[]; this.listeners={}; this.attrs={};
      this.className=''; this.classList={toggle:()=>{}}; this.open=false;
      all.push(this);
    }
    append(...xs) { this.children.push(...xs); }
    replaceChildren(...xs) { this.children=[...xs]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    showModal() { this.open=true; }
    close() { this.open=false; }
    click() { return this.onclick?.({target:this}); }
  }
  const document = {
    getElementById(id) { if(!nodes.has(id)) nodes.set(id,new Element('DIV',id)); return nodes.get(id); },
    createElement(tag) { return new Element(tag); },
    addEventListener(type, fn) { (docListeners.get(type) || (docListeners.set(type,[]),docListeners.get(type))).push(fn); },
    querySelectorAll(selector) {
      if(selector==='[data-choice]') return all.filter(x=>x.dataset.choice);
      if(selector==='.figure[data-variant]') return all.filter(x=>x.dataset.variant);
      return [];
    },
  };
  document.getElementById('scope').value='all';
  document.getElementById('filter').value='all';
  document.getElementById('search').value='';
  document.getElementById('advance').checked=false;
  const redo=new Element('BUTTON'); redo.dataset.choice='redo';
  return {document,nodes,docListeners};
}

let contextSerial=0;
async function page({data=fixture(), storage=new Storage(), locks=new Locks(), withSync=false, remote=null, time=T0, token=false}={}) {
  const dom=fakeDOM(), listeners=new Map(), timers=[], session=new Storage();
  const serial=++contextSerial; let uuid=0, now=time;
  if(token) session.setItem(TOKEN_KEY,'github_pat_FAKE_P318_ONLY');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now(){ return new Date(now).getTime(); } }
  const sandbox={
    console, document:dom.document, localStorage:storage, sessionStorage:session, navigator:{locks},
    crypto:{randomUUID:()=>`p318-context-${serial}-${++uuid}`}, Date:FixedDate, URLSearchParams, TextEncoder,
    btoa:x=>Buffer.from(x,'binary').toString('base64'), Blob, URL:{createObjectURL:()=> 'blob:fake',revokeObjectURL:()=>{}},
    AbortSignal:{timeout:()=>({fake:true})}, location:{search:'?scope=all',reload:()=>{}},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;}, setInterval:()=>1, clearTimeout:()=>{},
    addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
    fetch:async (url, opts={}) => {
      if(url.startsWith('data.json')) return {ok:true,json:async()=>clone(data)};
      if(remote) return remote.fetch(url, opts);
      throw Error('Network disabled in P318 test: '+url);
    },
  };
  sandbox.window=sandbox;
  const ctx=vm.createContext(sandbox);
  if(withSync) vm.runInContext(SYNC,ctx,{filename:'snapshot/sync.js'});
  vm.runInContext(APP,ctx,{filename:'snapshot/app.js'});
  await turns();
  if(withSync) for(const fn of dom.docListeners.get('DOMContentLoaded') || []) fn();
  await locks.settle();
  return {
    ctx,storage,locks,dom,listeners,timers,session,
    eval(code) { return vm.runInContext(code,ctx); },
    setTime(value) { now=value; },
    choose(choice) { sandbox.__choice=choice; return vm.runInContext('choose(__choice)',ctx); },
    export() { return clone(vm.runInContext('exportData()',ctx)); },
    decision() { const x=vm.runInContext('decision(current())',ctx); return x ? clone(x) : null; },
    text(id) { return dom.document.getElementById(id).textContent; },
    async import(value) { await dom.document.getElementById('file').onchange({target:{files:[{text:async()=>JSON.stringify(value)}]}}); },
    emit(type,value) { for(const fn of listeners.get(type) || []) fn(value); },
    async settle() { await locks.settle(); },
  };
}

class Remote {
  constructor(mode='normal') { this.mode=mode; this.files=new Map(); this.requests=[]; this.didLose=false; }
  async fetch(url, options={}) {
    const parsed=new URL(url); const key=parsed.pathname.split('/contents/')[1]; const method=options.method||'GET';
    const request={method,path:key||'',status:null}; this.requests.push(request);
    const response=(status,body)=>{request.status=status;return {ok:status>=200&&status<300,status,json:async()=>clone(body)};};
    if(!key) return response(200,{name:'qwen-teacher-review'});
    if(method==='GET') {
      if(this.mode==='conflict' && !this.files.has(key)) this.files.set(key,{sha:'foreign-sha',content:Buffer.from('different batch\n').toString('base64'),html_url:'https://example.invalid/conflict'});
      const file=this.files.get(key); return file?response(200,file):response(404,{message:'Not Found'});
    }
    if(method==='PUT') {
      if(this.mode==='permission') return response(403,{message:'Forbidden'});
      const payload=JSON.parse(options.body); const file={sha:sha(payload.content),content:payload.content,html_url:'https://example.invalid/'+key};
      this.files.set(key,file);
      if(this.mode==='lost-put-response'&&!this.didLose) { this.didLose=true;request.status='response-lost';throw new Error('Injected response loss after server commit'); }
      return response(201,{content:{sha:file.sha,html_url:file.html_url}});
    }
    throw Error('Unexpected method '+method);
  }
}

function imported(entry, data=fixture()) { return {schema_version:1,dataset_id:data.dataset_id,history:[entry]}; }
function label(x,choice='old',updated_at=T0) { return {source_uid:x.source_uid,source_sha256:x.source_sha256,versions:x.versions.map(v=>({key:v.key,native_sha256:v.native_sha256})),choice,updated_at}; }

const cases=[];
function record(id,risk,input,output,classification) { cases.push({id,risk,input,output,classification}); }

async function run() {
  // Control: current pair survives a completed local write and JSON round trip.
  {
    const p=await page();p.choose('new');await p.settle();const exported=p.export();
    const refreshed=await page({storage:p.storage});const restored=await page();await restored.import(exported);await restored.settle();
    assert.equal(refreshed.decision().choice,'new');assert.equal(restored.decision().choice,'new');
    assert.deepEqual(exported.history,restored.export().history);
    record('B01','completed local write / export-import control',{source_uid:fixture().items[0].source_uid,choice:'new',at:T0},{refresh:refreshed.decision(),restored_history:restored.export().history},'passes under completed-write condition');
  }
  // Control: a new native image invalidates the active label already.
  {
    const p=await page();p.choose('old');await p.settle();const next=fixture();next.items[0].versions[1].native_sha256=sha('P318-new-native-image');
    const refreshed=await page({data:next,storage:p.storage});
    assert.equal(refreshed.decision(),null);assert.equal(refreshed.export().history.length,1);
    record('B02','result native hash changed',{before:fixture().items[0],after:next.items[0]},{active:refreshed.decision(),message:refreshed.text('selection'),history:refreshed.export().history},'already protected');
  }
  // Source changed, same UID and compared result bytes: key collides.
  {
    const p=await page();p.choose('old');await p.settle();const next=fixture();next.items[0].source_sha256=sha('P318-replaced-source');
    const refreshed=await page({data:next,storage:p.storage});const exp=refreshed.export();
    assert.equal(refreshed.decision().choice,'old');assert.notEqual(exp.items[0].source_sha256,exp.history[0].source_sha256);
    record('B03','source SHA omitted from comparison key',{before_source_sha256:fixture().items[0].source_sha256,after_source_sha256:next.items[0].source_sha256,same_result_hashes:true},{active:refreshed.decision(),export_item:exp.items[0],history:exp.history},'confirmed stale assignment / contradictory export fields');
  }
  // Metadata generation version silently rewrites the claimed selected generation.
  {
    const p=await page();p.choose('new');await p.settle();const before=p.export();const next=fixture();next.items[0].versions[1].generation_version='P318-rerun-v-next';
    const refreshed=await page({data:next,storage:p.storage});const after=refreshed.export();
    assert.equal(refreshed.decision().choice,'new');assert.notEqual(before.items[0].selected_generation_version,after.items[0].selected_generation_version);
    record('B04','generation_version absent from saved history',{same_native_sha256:true,before_version:before.items[0].selected_generation_version,after_manifest_version:next.items[0].versions[1].generation_version},{before_item:before.items[0],after_item:after.items[0],saved_history:after.history},'confirmed provenance reassignment; no changed-pixel claim');
  }
  // Array order is not a semantic version change, but original key treats it as one.
  {
    const p=await page();p.choose('new');await p.settle();const next=fixture();next.items[0].versions.reverse();const refreshed=await page({data:next,storage:p.storage});
    assert.equal(refreshed.decision(),null);
    record('B05','manifest version list order changes',{before:fixture().items[0].versions,after:next.items[0].versions},{active:refreshed.decision(),history:refreshed.export().history},'unnecessary re-review; canonical-order design improvement');
  }
  // Hold the same Web Lock in another context; unload before the write callback.
  {
    const storage=new Storage(),locks=new Locks();const p=await page({storage,locks});
    const release=locks.hold('qwen-labels:'+DRAFT_KEY);p.choose('new');
    const durableBeforeRefresh=storage.json(DRAFT_KEY);const memoryBeforeRefresh=p.export().history;
    assert.equal(durableBeforeRefresh,null);assert.equal(memoryBeforeRefresh.length,1);
    // New page uses the same durable bytes but a fresh lock manager, representing navigation
    // that cancelled the old context's waiting request. No old callback is allowed to commit.
    const refreshed=await page({storage,locks:new Locks()});assert.equal(refreshed.decision(),null);
    record('B06','click -> navigation while label lock unavailable',{choice:'new',held_lock:'qwen-labels:'+DRAFT_KEY,at:T0},{durable_before_navigation:durableBeforeRefresh,volatile_before_navigation:memoryBeforeRefresh,after_navigation:refreshed.decision()},'confirmed asynchronous save gap under held lock');
    release();await locks.settle(); // Cleanup only, after observation; not part of evidence.
  }
  // A storage failure cannot be inferred from a nonempty in-memory sync queue.
  {
    const storage=new Storage(),p=await page({storage,withSync:true});storage.failure=()=>true;
    const sequence=['old','new','redo','old','new'];
    for (let i=0; i<sequence.length; i++) { p.setTime(`2026-11-26T00:00:0${i}.000Z`);p.choose(sequence[i]);await p.settle(); }
    p.ctx.reviewSync.display();
    assert.equal(storage.json(DRAFT_KEY),null);assert.equal(storage.json(SYNC_KEY),null);
    assert.match(p.text('sync-status'),/本机已保存 5 次/);
    const refreshed=await page({storage});assert.equal(refreshed.decision(),null);
    record('B07','all Storage writes fail',{choices:sequence,first_at:T0,timestamp_step_seconds:1,failure:'QuotaExceededError from each setItem',display_trigger:'reviewSync.display(), same function called by periodic refresh'},{save_text:p.text('save'),sync_text:p.text('sync-status'),sync_state:p.dom.document.getElementById('sync-status').dataset.state,queue_summary:clone(p.ctx.reviewSync.summary()),durable_draft:storage.json(DRAFT_KEY),durable_queue:storage.json(SYNC_KEY),after_refresh:refreshed.decision(),lock_errors:p.locks.errors},'confirmed nondurable queue falsely described as locally saved');
  }
  // Import reports saved before the pending lock callback persists it.
  {
    const storage=new Storage(),locks=new Locks(),p=await page({storage,locks});const release=locks.hold('qwen-labels:'+DRAFT_KEY);
    const input=imported(label(fixture().items[0],'redo'));await p.import(input);
    assert.match(p.text('save'),/记录已保存/);assert.equal(storage.json(DRAFT_KEY),null);
    record('B08','import completion before write lock',{file:input,held_lock:'qwen-labels:'+DRAFT_KEY},{message:p.text('save'),durable_before_lock_release:storage.json(DRAFT_KEY),volatile_history:p.export().history},'confirmed premature success message');
    release();await locks.settle();
  }
  // Invalid structure: new selected without a compared new version is accepted.
  {
    const data=fixture();const p=await page({data});p.eval('cursor=1;render()');const input=imported(label(data.items[1],'new'));await p.import(input);await p.settle();const exp=p.export();
    assert.equal(p.decision().choice,'new');assert.equal(exp.items[0].selected_native_sha256,null);assert.equal(exp.items[0].status,'pass');
    record('B09','import choice not present in compared versions',{file:input},{active:p.decision(),export_item:exp.items[0],message:p.text('selection')},'confirmed invalid current label with pass/null result');
  }
  // Malformed sibling causes partial in-memory mutation with no clear recovery report.
  {
    const p=await page();const input={schema_version:1,dataset_id:DATA.dataset_id,history:[label(fixture().items[0],'redo'),null]};await p.import(input);await p.settle();
    assert.equal(p.export().history.length,1);assert.equal(p.storage.json(DRAFT_KEY),null);assert.match(p.text('save'),/导入提示/);
    record('B10','one good history entry followed by null',{file:input},{message:p.text('save'),volatile_history:p.export().history,durable_draft:p.storage.json(DRAFT_KEY)},'confirmed partial import without durable save');
  }
  // Import treats arbitrary date text as an ordering authority.
  {
    const p=await page();const bad=label(fixture().items[0],'redo','zz-corrupt-time');await p.import(imported(bad));await p.settle();p.setTime(T1);p.choose('new');await p.settle();
    assert.equal(p.decision().choice,'redo');
    record('B11','non-date timestamp dominates valid future decisions',{imported:bad,subsequent_click:{choice:'new',updated_at:T1}},{active:p.decision(),exported_history:p.export().history},'confirmed invalid timestamp blocks later choice');
  }
  // Same comparison changes: exported history is a projection, not an action log.
  {
    const p=await page({withSync:true});p.choose('old');await p.settle();p.setTime(T1);p.choose('new');await p.settle();const exp=p.export();
    assert.equal(exp.history.length,1);assert.equal(p.storage.json(SYNC_KEY).pending.length,2);
    const restored=await page({withSync:true});await restored.import(exp);await restored.settle();
    assert.equal(restored.storage.json(SYNC_KEY).pending.length,1);
    record('B12','export-import loses earlier actions for same pair',{choices:[{choice:'old',updated_at:T0},{choice:'new',updated_at:T1}]},{before_queue:p.storage.json(SYNC_KEY).pending,exported_history:exp.history,restored_queue:restored.storage.json(SYNC_KEY).pending},'history semantics gap: one label per comparison, not append-only actions');
  }
  // Successful write + lost PUT response: persisted batch is reused by GET.
  {
    const remote=new Remote('lost-put-response'),p=await page({withSync:true,remote,token:true});p.choose('new');await p.settle();await p.ctx.reviewSync.flush();const first=p.storage.json(SYNC_KEY);
    assert.equal(first.pending.length,1);assert.ok(first.batch);const batchId=first.batch.batch_id;
    const refreshed=await page({withSync:true,remote,token:true,storage:p.storage});await refreshed.ctx.reviewSync.flush();const final=p.storage.json(SYNC_KEY);
    assert.equal(final.pending.length,0);assert.equal(final.confirmed,1);assert.equal(final.receipts[0].batch_id,batchId);assert.equal(remote.requests.filter(x=>x.method==='PUT').length,1);
    record('B13','remote PUT committed but its response lost',{choice:'new',fault:'after remote commit, before returning response'},{after_loss:first,after_retry:final,requests:remote.requests,remote_file_count:remote.files.size},'already idempotent under persisted local batch');
  }
  // Existing path with different payload is not overwritten or acknowledged.
  {
    const remote=new Remote('conflict'),p=await page({withSync:true,remote,token:true});p.choose('new');await p.settle();await p.ctx.reviewSync.flush();const a=p.storage.json(SYNC_KEY);await p.ctx.reviewSync.flush();const b=p.storage.json(SYNC_KEY);
    assert.equal(b.pending.length,1);assert.equal(b.confirmed,0);assert.equal(a.batch.batch_id,b.batch.batch_id);assert.equal(remote.requests.filter(x=>x.method==='PUT').length,0);
    record('B14','remote same path contains different payload',{choice:'new',remote:'different batch at planned immutable path'},{after_first:a,after_retry:b,message:p.text('sync-status'),requests:remote.requests},'already preserves queue; conflict message is generic network retry');
  }
  // Two tabs on distinct comparisons merge correctly after both writes complete.
  {
    const storage=new Storage(),locks=new Locks(),a=await page({storage,locks}),b=await page({storage,locks});
    a.choose('new');b.eval('cursor=1;render()');b.choose('old');await locks.settle();
    const fresh=await page({storage});assert.equal(fresh.export().history.length,2);
    record('B15','two tabs on different source pairs',{a:{source_uid:fixture().items[0].source_uid,choice:'new'},b:{source_uid:fixture().items[1].source_uid,choice:'old'},at:T0},{durable_history:fresh.export().history},'already merged by Web Locks');
  }
  // Same comparison + equal timestamps use lock arrival as silent last writer.
  {
    const storage=new Storage(),locks=new Locks(),a=await page({storage,locks,withSync:true}),b=await page({storage,locks,withSync:true});
    a.choose('old');b.choose('new');await locks.settle();const fresh=await page({storage});
    assert.equal(fresh.decision().choice,'new');assert.equal(fresh.export().history.length,1);assert.equal(storage.json(SYNC_KEY).pending.length,2);
    record('B16','two tabs on same pair / equal timestamps',{a:{choice:'old',updated_at:T0},b:{choice:'new',updated_at:T0},save_order:['A','B']},{active:fresh.decision(),exported_history:fresh.export().history,pending_events:storage.json(SYNC_KEY).pending},'confirmed silent tie overwrite in exported history; queue retains both');
  }
  // A corrupted local JSON is silently treated as empty and overwritten.
  {
    const storage=new Storage();storage.setItem(DRAFT_KEY,'{"partially-written":');const before=storage.getItem(DRAFT_KEY);const p=await page({storage});p.choose('new');await p.settle();
    assert.equal(p.export().history.length,1);assert.notEqual(storage.getItem(DRAFT_KEY),before);
    record('B17','corrupt persisted draft JSON',{raw_localStorage:before},{message:p.text('save'),durable_after_click:storage.json(DRAFT_KEY),corrupt_bytes_preserved_elsewhere:false},'confirmed silent reset with overwrite of recoverable raw bytes');
  }
  // Dynamic manifest in app but fixed constants in sync mislabel another dataset.
  {
    const data=fixture();data.dataset_id='P318-another-dataset';data.source_manifest_sha256=sha('P318-manifest');
    const remote=new Remote(),p=await page({data,withSync:true,remote,token:true});p.choose('new');await p.settle();await p.ctx.reviewSync.flush();
    const batch=JSON.parse(Buffer.from([...remote.files.values()][0].content,'base64').toString('utf8'));
    assert.equal(p.export().dataset_id,data.dataset_id);assert.equal(batch.dataset_id,DATA.dataset_id);
    record('B18','another dataset loaded into unchanged sync module',{app_dataset_id:data.dataset_id,app_manifest_sha256:data.source_manifest_sha256},{export_dataset_id:p.export().dataset_id,remote_batch:batch},'migration/fixture boundary: original sync hard-codes original dataset');
  }
  // Stored confirmed state does not make remote batch files importable backups.
  {
    const remote=new Remote(),p=await page({withSync:true,remote,token:true});p.choose('redo');await p.settle();await p.ctx.reviewSync.flush();const batch=JSON.parse(Buffer.from([...remote.files.values()][0].content,'base64').toString('utf8'));
    const restored=await page();await restored.import(batch);await restored.settle();assert.equal(restored.export().history.length,0);
    record('B19','using an actual emitted remote batch as an import file',{file:batch},{message:restored.text('save'),history:restored.export().history},'remote batch restoration requires explicit entries-to-history adapter');
  }
  const report={
    generated_at_utc:new Date().toISOString(),
    source_files:{
      app_js:{relative_path:'tests/baseline/app.js',sha256:sha(APP)},
      sync_js:{relative_path:'tests/baseline/sync.js',sha256:sha(SYNC)},
      data:{dataset_id:DATA.dataset_id,source_manifest_sha256:DATA.source_manifest_sha256},
    },
    method:'Unmodified source in isolated Node vm contexts; explicit DOM, Web Locks, storage, fixed clock, and fetch doubles. No real network writes.',
    cases,
  };
  const output=args.result('P318-baseline-results.json');
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:cases.length,output,ids:cases.map(x=>x.id)}));
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
