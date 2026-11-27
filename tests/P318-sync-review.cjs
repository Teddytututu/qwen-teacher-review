#!/usr/bin/env node
'use strict';
// Independent contract checks for actual patched sync.js, with an injected fake
// fetch service and deterministic storage/locks/clock. No production API calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const args=require('./P318-test-support.cjs').paths();
const ROOT=args.root;
const PAGE=ROOT;
const OUT=args.result('P318-sync-review-results.json');
const C=require(path.join(PAGE,'P318-review-core.js'));
const SCRIPT=fs.readFileSync(path.join(PAGE,'sync.js'),'utf8');
const DATA=JSON.parse(fs.readFileSync(path.join(ROOT,'data.json'),'utf8'));
const ATTACHED_BATCHES=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/fixtures/P318-qwen-annotation-batches.json'),'utf8'));
const KEY='qwen-github-sync:'+DATA.dataset_id;
const clone=x=>JSON.parse(JSON.stringify(x));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
class Storage{
  constructor(){this.values=new Map();this.fail=false;}
  get length(){return this.values.size;}
  key(i){return [...this.values.keys()][i]??null;}
  getItem(k){return this.values.get(k)??null;}
  setItem(k,v){if(this.fail)throw Error('QuotaExceededError: sync review');this.values.set(k,String(v));}
  removeItem(k){this.values.delete(k);}
  json(k){return JSON.parse(this.getItem(k)||'null');}
}
class Locks{
  constructor(){this.tails=new Map();}
  request(name,options,callback){
    if(typeof options==='function'){callback=options;options={};}
    const previous=this.tails.get(name);if(previous&&options.ifAvailable)return Promise.resolve(callback(null));
    const result=(previous||Promise.resolve()).then(()=>callback({name}));const settled=result.catch(()=>{});this.tails.set(name,settled);
    settled.finally(()=>{if(this.tails.get(name)===settled)this.tails.delete(name);});return result;
  }
}
class Remote{
  constructor(mode='normal'){this.mode=mode;this.files=new Map();this.requests=[];this.faulted=false;}
  async fetch(url,options={}){
    const target=new URL(url),file=target.pathname.split('/contents/')[1],method=options.method||'GET';const entry={method,path:file,status:null};this.requests.push(entry);
    const response=(status,body)=>{entry.status=status;return{ok:status>=200&&status<300,status,json:async()=>clone(body)};};
    if(method==='GET'){const found=this.files.get(file);return found?response(200,found):response(404,{message:'Not found'});}
    if(method==='PUT'){
      const body=JSON.parse(options.body),stored={sha:sha(body.content),content:body.content,html_url:'https://example.invalid/'+file};
      this.files.set(file,stored);
      if(!this.faulted&&this.mode==='lost-response'){this.faulted=true;entry.status='response-lost';throw Error('Response lost after remote commit');}
      if(!this.faulted&&this.mode==='409-same'){this.faulted=true;return response(409,{message:'Conflict'});}
      if(!this.faulted&&this.mode==='409-different'){this.faulted=true;stored.content=Buffer.from('other actor payload\n').toString('base64');stored.sha=sha(stored.content);return response(409,{message:'Conflict'});}
      return response(201,{content:{sha:stored.sha,html_url:stored.html_url}});
    }
    throw Error('Unsupported fake request '+method);
  }
}
let serial=0;
async function sync({storage=new Storage(),remote=new Remote(),isTest=true}={}){
  const sequence=++serial;let uuid=0;const dom=new Map(),listeners=new Map(),timers=[];const session=new Storage();session.setItem('qwen-review-gh-token','github_pat_P318_FAKE_ONLY');
  const getElementById=id=>{if(!dom.has(id))dom.set(id,{textContent:'',dataset:{},onclick:null,showModal(){},close(){}});return dom.get(id);};
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:['2026-11-26T02:00:00.000Z']));}static now(){return 1795658400000;}}
  const scope={QwenReviewCore:C,QWEN_REVIEW_CONFIG:{apiBase:'https://api.example.invalid/repos/local/review',fetch:remote.fetch.bind(remote)},
    document:{getElementById,addEventListener:(type,fn)=>listeners.set(type,fn)},localStorage:storage,sessionStorage:session,navigator:{locks:new Locks()},
    crypto:{randomUUID:()=>`sync-${sequence}-${++uuid}`},Date:FixedDate,TextEncoder,btoa:s=>Buffer.from(s,'binary').toString('base64'),AbortSignal:{timeout:()=>({fake:true})},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},setInterval:()=>1,addEventListener:()=>{},console};scope.window=scope;
  const ctx=vm.createContext(scope);vm.runInContext(SCRIPT,ctx,{filename:'implementation/sync.js'});await scope.reviewSync.configure(clone(DATA),{isTest});
  listeners.get('DOMContentLoaded')?.();
  // The test token belongs to the module's selected test/production namespace.
  session.setItem(scope.reviewSync.storageKeys?.().token||'qwen-review-gh-token','github_pat_P318_FAKE_ONLY');
  return{sync:scope.reviewSync,storage,session,remote,dom,timers,durable(){
    const currentKey=scope.reviewSync.storageKeys?.().queue;
    if(currentKey)return storage.json(currentKey);
    const client=scope.reviewSync.backup().queue?.client_id;
    for(const [key,value] of storage.values){if(!key.startsWith('qwen-github-sync:'))continue;try{const q=JSON.parse(value);if(q.client_id===client&&Array.isArray(q.pending))return q;}catch{}}
    return null;
  }};
}
function event(id='sync-event',isTest=true){
  const x=DATA.items[0];return C.normalizeEvent({schema_version:2,event_id:id,dataset_id:DATA.dataset_id,source_manifest_sha256:DATA.source_manifest_sha256,
    source_uid:x.source_uid,source_sha256:x.source_sha256,versions:x.versions,choice:'new',updated_at:'2026-11-26T02:00:00.000Z',client_id:'audit',parents:[],is_test:isTest},DATA);
}
const cases=[];
const add=(id,risk,fn)=>cases.push({id,risk,fn});
add('S01','persisted batch identity survives committed PUT with lost response',async()=>{
  const remote=new Remote('lost-response'),a=await sync({remote});await a.sync.enqueue(event());const first=await a.sync.flush();assert.equal(first.confirmed,false);const pending=a.durable();assert.ok(pending.batch);
  const b=await sync({remote,storage:a.storage});const second=await b.sync.flush();const final=b.durable();assert.equal(second.confirmed,true);assert.equal(final.confirmed,1);assert.equal(final.pending.length,0);assert.equal(final.receipts[0].batch_id,pending.batch.batch_id);
  assert.equal(remote.requests.filter(x=>x.method==='PUT').length,1);return{first,second,requests:remote.requests,final};
});
add('S02','a 409 carrying the identical committed batch is acknowledged after readback',async()=>{
  const remote=new Remote('409-same'),a=await sync({remote});await a.sync.enqueue(event());const result=await a.sync.flush();assert.equal(result.confirmed,true);assert.equal(a.sync.summary().confirmed_events,1);assert.equal(remote.requests.filter(x=>x.method==='GET').length,2);
  return{result,requests:remote.requests,summary:a.sync.summary()};
});
add('S03','a 409 with another payload preserves local history and exposes a conflict',async()=>{
  const remote=new Remote('409-different'),a=await sync({remote});await a.sync.enqueue(event());const result=await a.sync.flush();const first=a.durable();assert.equal(result.confirmed,false);assert.match(a.sync.summary().error,/不一致/);assert.equal(first.pending.length,1);assert.equal(first.confirmed,0);
  const again=await a.sync.flush();assert.equal(again.confirmed,false);assert.equal(a.durable().batch.batch_id,first.batch.batch_id);assert.equal(remote.requests.filter(x=>x.method==='PUT').length,1);
  return{result,again,requests:remote.requests,queue:a.durable(),summary:a.sync.summary()};
});
add('S04','explicit test mode leaves an old production queue intact and uses verification paths',async()=>{
  const storage=new Storage();storage.setItem(KEY,JSON.stringify({client_id:'old-client',pending:[],seen:[],confirmed:0,receipts:[],is_test:false}));
  const oldProductionQueue=storage.getItem(KEY);
  const a=await sync({storage,isTest:true});await a.sync.enqueue(event());const result=await a.sync.flush();const file=[...a.remote.files.values()][0],batch=JSON.parse(Buffer.from(file.content,'base64').toString('utf8'));
  assert.equal(result.confirmed,true);assert.equal(batch.is_test,true,'configure(isTest=true) was discarded by load()');assert.ok(a.remote.requests.every(x=>x.path.startsWith('verification-batches/')));
  assert.equal(storage.getItem(KEY),oldProductionQueue,'test mode changed the legacy production queue');
  return{batch,requests:a.remote.requests,old_production_queue:storage.json(KEY),test_keys:a.sync.storageKeys?.()};
});
add('S05','a restored successful receipt is unconfirmed until remote content is read again',async()=>{
  const remote=new Remote(),a=await sync({remote});await a.sync.enqueue(event());await a.sync.flush();const backup=clone(a.sync.backup());const beforeRequestCount=remote.requests.length;
  const b=await sync({remote});const restored=await b.sync.restore(backup);assert.equal(b.sync.summary().confirmed_events,0);assert.equal(remote.requests.length,beforeRequestCount);assert.equal(restored.restored,1);
  const result=await b.sync.flush();assert.equal(result.confirmed,true);assert.equal(b.sync.summary().confirmed_events,1);assert.equal(remote.requests.length,beforeRequestCount+1);assert.equal(remote.requests.at(-1).method,'GET');
  return{restored,result,requests:remote.requests,backup,final:clone(b.sync.backup())};
});
add('S06','a failed queue write stays visible after disconnect and retries from retained events',async()=>{
  const storage=new Storage(),a=await sync({storage});storage.fail=true;const failed=await a.sync.enqueue(event());assert.equal(failed.queued,false);assert.equal(storage.getItem(a.sync.storageKeys().queue),null);assert.equal(a.remote.requests.length,0);assert.match(a.sync.summary().error,/队列未写入/);
  const beforeDisconnect=clone(a.sync.summary());a.dom.get('auth-disconnect').onclick();
  const disconnected={before:beforeDisconnect,after:clone(a.sync.summary()),status:a.dom.get('sync-status').textContent,durable_queue:a.durable()};
  try{assert.match(a.sync.summary().error||'',/队列未写入/,'disconnect erased the unresolved queue-write error');assert.match(disconnected.status,/队列未写入/);assert.equal(disconnected.durable_queue,null);}
  catch(error){error.observed=disconnected;throw error;}
  storage.fail=false;await a.sync.seed([event()]);const queued=a.durable();assert.equal(queued.pending.length,1);
  a.session.setItem(a.sync.storageKeys().token,'github_pat_P318_FAKE_ONLY');await a.sync.flush();assert.equal(a.sync.summary().confirmed_events,1);
  return{failed,disconnected,queued,final:a.sync.summary(),requests:a.remote.requests};
});
add('S07','a same-origin demo cannot acknowledge or remove a production pending event',async()=>{
  const storage=new Storage(),remote=new Remote(),production=await sync({storage,remote,isTest:false});
  await production.sync.enqueue(event('real-review-event',false));const before=production.durable();assert.equal(before.pending.length,1);
  const demo=await sync({storage,remote,isTest:true});await demo.sync.enqueue(event('demo-review-event',true));await demo.sync.flush();
  const productionReload=await sync({storage,remote,isTest:false});const after=productionReload.durable();
  const observed={before,after,demo:clone(demo.sync.backup()),requests:remote.requests};
  try{assert.equal(after.pending.length,1,'demo fake receipt removed the production event');assert.equal(after.pending[0].event_id,'real-review-event');assert.equal(after.confirmed,0);assert.equal(demo.sync.summary().confirmed_events,1);}
  catch(error){error.observed=observed;throw error;}
  return observed;
});
add('S08','an embedded verification batch stays out of production despite an outer flag mismatch',async()=>{
  const batch=clone(ATTACHED_BATCHES[2].data),a=await sync({isTest:false});
  const backup={schema_version:2,dataset_id:DATA.dataset_id,queue:{client_id:'mixed-recovery',pending:[],seen:[],confirmed:0,receipts:[{batch_id:batch.batch_id,batch}],recovered_batches:[],is_test:false}};
  const result=await a.sync.restore(backup);const observed={source_pointer:'tests/fixtures/P318-qwen-annotation-batches.json /2/data',outer_is_test:false,embedded_batch_is_test:batch.is_test,result,after:clone(a.sync.backup()),requests:a.remote.requests};
  try{assert.equal(result.restored,0,'a verification batch entered the production queue through restore');assert.equal(a.sync.summary().pending_events,0);assert.equal(a.remote.requests.length,0);}
  catch(error){error.observed=observed;throw error;}return observed;
});
add('S09','restore reports a reused batch_id with different payload instead of silently skipping it',async()=>{
  const a=await sync({isTest:false});await a.sync.enqueue(event('retained-batch-event',false));await a.sync.flush();
  const first=clone(a.sync.backup()),b=await sync({isTest:false});await b.sync.restore(first);
  const before=clone(b.sync.backup()),incoming=clone(first);
  incoming.queue.receipts[0].batch.entries=[event('different-incoming-event',false)];
  const result=await b.sync.restore(incoming),after=clone(b.sync.backup());
  const observed={same_batch_id:incoming.queue.receipts[0].batch.batch_id,original_entry:first.queue.receipts[0].batch.entries[0].event_id,incoming_entry:incoming.queue.receipts[0].batch.entries[0].event_id,result,before,after};
  try{assert.equal(result.restored,0);assert.match(b.sync.summary().error||'',/不一致|冲突/,'same batch_id with different bytes was silently skipped');assert.equal(C.stable(after.queue),C.stable(before.queue),'conflicting restore changed the retained queue');}
  catch(error){error.observed=observed;throw error;}
  const c=await sync({isTest:false}),sameInput=clone(first),emptyBefore=clone(c.sync.backup());
  sameInput.queue.receipts.push(incoming.queue.receipts[0]);
  const sameInputResult=await c.sync.restore(sameInput),emptyAfter=clone(c.sync.backup());
  const withinOneInput={result:sameInputResult,before:emptyBefore,after:emptyAfter};
  try{assert.equal(sameInputResult.restored,0);assert.match(c.sync.summary().error||'',/不一致|冲突/,'conflicting duplicate IDs inside one input were silently skipped');assert.equal(C.stable(emptyAfter.queue),C.stable(emptyBefore.queue),'preflight conflict partially changed a fresh queue');}
  catch(error){error.observed=withinOneInput;throw error;}
  const receiptBefore=clone(a.sync.backup()),receiptDiskBefore=a.storage.getItem(a.sync.storageKeys().queue),reusedEventInput=clone(first);
  const reused=event('retained-batch-event',false),oldVersion=reused.versions.find(v=>v.key==='old');
  reused.choice='old';reused.selected_native_sha256=oldVersion.native_sha256;reused.selected_generation_version=oldVersion.generation_version;
  reusedEventInput.queue.receipts[0].batch.batch_id='distinct-incoming-batch';reusedEventInput.queue.receipts[0].batch.entries=[reused];
  const reusedResult=await a.sync.restore(reusedEventInput),receiptAfter=clone(a.sync.backup());
  const eventAcrossBatches={same_event_id:reused.event_id,new_batch_id:'distinct-incoming-batch',result:reusedResult,before:receiptBefore,after:receiptAfter,durable_unchanged:a.storage.getItem(a.sync.storageKeys().queue)===receiptDiskBefore};
  try{assert.equal(receiptBefore.queue.pending.length,0);assert.equal(receiptBefore.queue.receipts.length,1);assert.equal(reusedResult.restored,0);assert.match(a.sync.summary().error||'',/不一致|冲突/,'a new batch reused a confirmed event ID with different payload');assert.equal(C.stable(receiptAfter.queue),C.stable(receiptBefore.queue),'event conflict changed the retained receipt queue');assert.equal(eventAcrossBatches.durable_unchanged,true);}
  catch(error){error.observed=eventAcrossBatches;throw error;}
  return{between_inputs:observed,within_one_input:withinOneInput,event_across_batches:eventAcrossBatches};
});
(async()=>{
  const results=[];for(const c of cases){try{results.push({id:c.id,risk:c.risk,passed:true,output:await c.fn()});}catch(error){results.push({id:c.id,risk:c.risk,passed:false,error:error.message,observed:error.observed??null,actual:error.actual,expected:error.expected,stack:error.stack});}}
  const report={generated_at_utc:new Date().toISOString(),sync_sha256:sha(SCRIPT),method:'Actual patched sync.js executed in isolated vm realms with injected fake GitHub response service',results,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length};
  fs.writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,failed:report.failed,failed_ids:results.filter(x=>!x.passed).map(x=>x.id),output:OUT}));if(report.failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
