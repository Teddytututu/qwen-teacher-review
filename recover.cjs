#!/usr/bin/env node
/* Offline merge CLI: uses the same validators as the browser. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./P318-review-core.js');
function memory(){const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)}}
async function merge(dataset,inputs){
 const journal=C.createStore({dataset,storage:memory(),id:()=>crypto.randomUUID()});const queues=[],quarantine=[];
 for(const input of inputs){
  await journal.importData(input,'offline input');
  if(input.server_sync){try{if(input.server_sync.schema_version!==2||input.server_sync.dataset_id!==dataset.dataset_id)throw Error('sync backup identity mismatch');const q=C.validateQueue(input.server_sync.queue,dataset);if(q.is_test||q.pending.some(e=>e.is_test)||q.batch?.is_test||q.recovered_batches.some(b=>b.is_test||b.entries.some(e=>e.is_test)))throw Error('test sync queue cannot enter production recovery');queues.push(q)}catch(e){quarantine.push({reason:e.message,raw:input.server_sync})}}
 }
 const history=journal.snapshot().history,entries=new Map(),batches=new Map(),badEntries=new Set(),badBatches=new Set();
 for(const queue of queues){
  const pending=[...queue.pending,...(queue.batch?.entries??[]),...queue.recovered_batches.flatMap(b=>b.entries)];
  try{C.validateHistoryBinding(pending,history,dataset)}catch(e){quarantine.push({reason:e.message,raw:queue});continue}
  for(const e of pending){if(badEntries.has(e.event_id))continue;const old=entries.get(e.event_id);if(old&&C.stable(old)!==C.stable(e)){quarantine.push({reason:'queue event conflict',raw:e});entries.delete(e.event_id);badEntries.add(e.event_id)}else entries.set(e.event_id,e)}
  for(const b of [queue.batch,...queue.recovered_batches].filter(Boolean)){const k=b.batch_id;if(badBatches.has(k))continue;const old=batches.get(k);if(old&&C.stable(old)!==C.stable(b)){quarantine.push({reason:'immutable batch conflict',raw:b});batches.delete(k);badBatches.add(k)}else batches.set(k,b)}
  const legacy=C.legacyQueueEntries(queue);if(legacy.length)await journal.importData({schema_version:1,dataset_id:dataset.dataset_id,history:legacy},'legacy accepted queue');
 }
 const sync={schema_version:2,client_id:'offline-recovery',pending:[...entries.values()],seen:[...entries.values()].map(e=>e.legacy_fingerprint||(e.schema_version===2?'event:'+e.event_id:[e.source_uid,e.updated_at,e.choice,...e.versions.map(v=>v.native_sha256)].join('|'))),confirmed:0,receipts:[],recovered_batches:[...batches.values()],recovered_evidence:quarantine.map(q=>({origin:q.reason,raw:JSON.stringify(C.sanitizeBackup(q.raw))})),is_test:false};
 const result=journal.exportData({schema_version:2,dataset_id:dataset.dataset_id,queue:sync});result.quarantine.push(...C.sanitizeBackup(quarantine));return result;
}
module.exports={merge};
if(require.main===module)(async()=>{
 const args=process.argv.slice(2);let dataset=path.join(__dirname,'data.json'),out='recovered.json',files=[];
 for(let i=0;i<args.length;i++){if(args[i]==='--dataset')dataset=args[++i];else if(args[i]==='--out')out=args[++i];else files.push(args[i])}
 if(!files.length)throw Error('Usage: node recover.cjs --dataset data.json --out recovered.json input1.json [input2.json]');
 const d=JSON.parse(fs.readFileSync(dataset,'utf8')),inputs=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));const result=await merge(d,inputs);fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({history:result.history.length,conflicts:result.conflicts.length,quarantine:result.quarantine.length}));process.exitCode=result.conflicts.length||result.quarantine.length?3:0;
})().catch(e=>{console.error(e.message);process.exitCode=2});
