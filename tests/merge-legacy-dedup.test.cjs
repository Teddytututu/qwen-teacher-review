'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {environment,source,subset,entry,clone,server,memory}=require('./t434/helpers.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function ready(e){for(let i=0;i<1000&&!e.window.reviewApp;i++)await tick();assert.ok(e.window.reviewApp,'application must finish migration');await e.window.reviewSync.seed(e.window.reviewApp.inspect().history)}
for(const flushFirst of [true,false])test('legacy seen reconstruction: '+(flushFirst?'flush before migration':'migration before flush'),async()=>{
 const item=source('round_2/003'),data=subset([item]),good={...entry(item),event_id:'waiting'},oldKey='qwen-github-sync:'+data.dataset_id;
 const raw=JSON.stringify({client_id:'fixture-client',pending:[good],seen:[],confirmed:0,receipts:[],is_test:true});
 const local=memory(new Map([[oldKey,raw]])),remote=server();
 const fetch=(url,opts)=>String(url).startsWith('data.json')?Promise.resolve({ok:true,json:async()=>clone(data)}):remote.fetch(url,opts);
 const e=environment({data,local,syncStub:false,fetch});e.sync();
 const digest=e.window.crypto.subtle.digest.bind(e.window.crypto.subtle);let release;const gate=new Promise(resolve=>release=resolve);let requested=false;
 e.window.crypto.subtle={digest:async(...args)=>{requested=true;await gate;return digest(...args)}};
 await e.app();for(let i=0;i<1000&&!requested;i++)await tick();assert.equal(requested,true);
 assert.equal(e.window.reviewSync.backup().queue.pending.length,1);
 if(flushFirst){await e.window.reviewSync.flush();assert.equal(e.window.reviewSync.summary().confirmed_events,1)}
 release();await ready(e);await e.window.reviewSync.flush();
 const q=clone(e.window.reviewSync.backup().queue);
 assert.equal(q.confirmed,1);assert.equal(q.pending.length,0);assert.equal(remote.calls.filter(x=>x.method==='PUT').length,1);
 assert.equal(q.receipts.length,1);assert.equal(q.receipts[0].batch.entries.length,1);assert.equal(q.receipts[0].batch.entries[0].event_id,'waiting');
 assert.equal(JSON.stringify(q.receipts[0].batch.entries[0]),JSON.stringify(good));assert.equal(local.getItem(oldKey),raw);
 // Independently lose only the derived seen index, retaining confirmed immutable receipt bytes.
 const key=e.window.reviewSync.storageKeys().queue;local.setItem(key,JSON.stringify({...q,seen:[]}));
 const fresh=environment({data,local,syncStub:false,fetch});fresh.sync();await fresh.app();await ready(fresh);await fresh.window.reviewSync.flush();
 assert.equal(fresh.window.reviewSync.summary().confirmed_events,1);assert.equal(fresh.window.reviewSync.summary().pending_events,0);
 assert.equal(remote.calls.filter(x=>x.method==='PUT').length,1);assert.deepEqual(clone(fresh.window.reviewSync.backup().queue.receipts),q.receipts);
});
