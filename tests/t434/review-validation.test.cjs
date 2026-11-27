'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {environment,source,subset,entry,clone,server,memory,dataset,sourceRoot} = require('./helpers.cjs');
// P318 configures the dataset at runtime, so use the exact unchanged fixture identity.
const syncDataset = dataset.dataset_id;
const syncKey = 'qwen-github-sync:' + syncDataset;
const draftKey = 'qwen-human-review:' + dataset.dataset_id;
const snapshot = e => [...e.local.values.entries()];

function connected(data, options = {}) {
  const remote = server();
  let release;
  const delayed = new Promise(resolve => { release = () => resolve({ok:true,json:async()=>clone(data)}); });
  const e = environment({data,local:options.local,syncStub:false,
    fetch:(url,opts)=>String(url).startsWith('data.json')
      ? options.delayManifest ? delayed : Promise.resolve({ok:true,json:async()=>clone(data)})
      : remote.fetch(url,opts)});
  e.session.setItem('qwen-review-gh-token','fixture-token-never-export');
  e.sync();
  return {e,remote,release};
}
function queueState(pending,batch) {
  return {client_id:'fixture-client',pending:clone(pending),seen:[],confirmed:0,receipts:[],is_test:true,
    ...(batch ? {batch:clone(batch)} : {})};
}

test('import cannot choose a version absent from its comparison',async()=>{
  const item=source('round_2/003'),data=subset([item]),e=environment({data});
  await e.app();const before=snapshot(e);
  await e.import({dataset_id:data.dataset_id,history:[entry(item,'new')]});
  assert.equal(e.eval('exportData().items.length'),0);
  assert.deepEqual(snapshot(e),before);
  assert.equal(e.syncEvents.length,0);
});

test('malformed tail rolls back the entire import, retaining previous labels',async()=>{
  const item=source('round_2/000'),data=subset([item]),e=environment({data});
  await e.app();e.eval("choose('old')");await e.settle();
  const labels=clone(e.eval('exportData().history')),before=snapshot(e),events=e.syncEvents.length;
  await e.import({dataset_id:data.dataset_id,history:[entry(item,'new','2099-01-01T00:00:00.000Z'),null]});
  assert.deepEqual(clone(e.eval('exportData().history')),labels);
  assert.deepEqual(snapshot(e),before);assert.equal(e.syncEvents.length,events);
});

test('source, candidate slot, hash and selected hash are checked together',async()=>{
  const item=source('round_2/003'),data=subset([item]);
  const changes=[x=>x.source_uid='unknown',x=>x.source_sha256='f'.repeat(64),
    x=>x.versions=[],x=>x.versions.push({...x.versions[0]}),
    x=>x.versions[0].native_sha256='broken',x=>x.selected_native_sha256=null];
  for(const change of changes){
    const e=environment({data});await e.app();const before=snapshot(e),bad=entry(item);change(bad);
    await e.import({dataset_id:data.dataset_id,history:[bad]});
    assert.equal(e.eval('exportData().history.length'),0);assert.deepEqual(snapshot(e),before);
    assert.equal(e.syncEvents.length,0);
  }
});

test('legal old/new/redo choices save, reload, export and synchronize',async()=>{
  for(const choice of ['old','new','redo']){
    const item=source('round_2/000'),data=subset([item]),{e,remote}=connected(data);
    await e.app();await e.import({dataset_id:data.dataset_id,history:[entry(item,choice)]});
    const out=clone(e.eval('exportData()'));assert.equal(out.items.length,1);
    assert.equal(out.items[0].status,choice==='redo'?'redo':'pass');
    assert.equal(out.items[0].selected_native_sha256,choice==='redo'?null:item.versions.find(v=>v.key===choice).native_sha256);
    await e.window.reviewSync.flush();assert.equal(e.window.reviewSync.summary().confirmed_events,1);
    assert.equal(remote.calls.filter(x=>x.method==='PUT').length,1);
    const reloaded=environment({data,local:e.local});await reloaded.app();
    assert.equal(reloaded.eval('exportData().items[0].choice'),choice);
    assert.equal(JSON.stringify(out).includes('fixture-token-never-export'),false);
  }
});

test('historical native versions survive import and sync without becoming current',async()=>{
  const previous=source('round_2/000'),current=clone(previous);
  current.versions.find(v=>v.key==='new').native_sha256='f'.repeat(64);
  const data=subset([current]),{e}=connected(data);await e.app();
  await e.import({dataset_id:data.dataset_id,history:[entry(previous,'new')]});
  const out=clone(e.eval('exportData()'));
  assert.equal(out.items.length,0);assert.equal(out.history.length,1);
  // P318 additionally freezes generation_version; retain original key/native equality.
  const identityVersions=versions=>versions.map(({key,native_sha256})=>({key,native_sha256})).sort((a,b)=>a.key.localeCompare(b.key));
  assert.deepEqual(identityVersions(out.history[0].versions),identityVersions(entry(previous).versions));
  await e.window.reviewSync.flush();assert.equal(e.window.reviewSync.summary().confirmed_events,1);
});

test('invented native hashes stay out of current results',async()=>{
  const item=source('round_2/003'),data=subset([item]),e=environment({data});
  await e.app();const invented=entry(item);
  invented.versions[0].native_sha256='f'.repeat(64);
  await e.import({dataset_id:data.dataset_id,history:[invented]});
  const out=clone(e.eval('exportData()'));
  assert.equal(out.history.length,1);assert.equal(out.items.length,0);
  assert.equal(e.eval('decision(items[0])'),undefined);
});

test('bad cached history is retained for diagnosis and excluded from normal export',async()=>{
  const item=source('round_2/003'),data=subset([item]),bad=entry(item,'new');
  const key=item.source_uid+'|'+item.versions.map(v=>v.key+':'+v.native_sha256).join('|');
  const local=memory(new Map([[draftKey,JSON.stringify({[key]:bad})]])),{e,remote}=connected(data,{local});
  await e.app();const out=clone(e.eval('exportData()'));
  assert.equal(out.items.length,0);assert.equal(out.history.length,0);
  assert.deepEqual(out.diagnostics.rejected_history[0].raw,bad);
  assert.equal(remote.calls.length,0);assert.deepEqual(JSON.parse(local.getItem(draftKey)),{[key]:bad});
});

test('null, array and malformed stored roots remain intact and exportable',async()=>{
  const data=subset([source('round_2/003')]);
  for(const raw of ['null','[]','{broken']){
    const local=memory(new Map([[draftKey,raw]])),e=environment({data,local});
    await e.app();const out=clone(e.eval('exportData()'));
    assert.equal(out.diagnostics.stored_root,raw);assert.equal(out.history.length,0);
    e.eval("choose('old')");await e.settle();
    assert.equal(local.getItem(draftKey),raw);
    assert.equal(e.eval('exportData().items[0].choice'),'old');
    assert.equal(e.eval('exportData().diagnostics.stored_root'),raw);
  }
});

test('invalid pending and fixed batches retain bytes while producing zero HTTP calls',async()=>{
  const item=source('round_2/003'),data=subset([item]);
  const bad={...entry(item,'new'),event_id:'bad',selected_native_sha256:null};
  const good={...entry(item),event_id:'good'};
  for(const state of [queueState([bad]),queueState([good],{batch_id:'fixed',entries:[bad]})]){
    const local=memory(new Map([[syncKey,JSON.stringify(state)]])),{e,remote}=connected(data,{local});
    await e.app();const before=snapshot(e);await e.window.reviewSync.flush();
    assert.equal(remote.calls.length,0);assert.deepEqual(snapshot(e),before);
    assert.deepEqual(clone(e.window.reviewSync.diagnostics().pending),state.pending);
  }
});

test('delayed manifest preserves queued events then permits normal flush',async()=>{
  const item=source('round_2/003'),data=subset([item]),good={...entry(item),event_id:'waiting'};
  const local=memory(new Map([[syncKey,JSON.stringify(queueState([good]))]]));
  const {e,remote,release}=connected(data,{local,delayManifest:true});await e.app();
  const before=snapshot(e);await e.window.reviewSync.flush();
  assert.equal(remote.calls.length,0);assert.deepEqual(snapshot(e),before);
  // Before manifest resolution P318 has no journal/export yet; check the real validator readiness.
  assert.equal(e.window.reviewValidation.isReady(),false);
  release();await e.ready();await e.settle();await e.window.reviewSync.flush();
  assert.equal(e.window.reviewSync.summary().confirmed_events,1);
  await e.settle();await e.window.reviewSync.flush();
  assert.equal(e.window.reviewSync.summary().confirmed_events,1);
  assert.equal(e.window.reviewSync.summary().pending_events,0);
  assert.equal(remote.calls.filter(x=>x.method==='PUT').length,1);
});

test('manifest readiness clears its transient warning even with an empty queue',async()=>{
  const data=subset([source('round_2/003')]),{e,release}=connected(data,{delayManifest:true});
  await e.app();await e.window.reviewSync.flush();
  assert.equal(e.d.document.getElementById('sync-status').dataset.state,'retry');
  release();await e.ready();await e.settle();await e.window.reviewSync.flush();
  // P318 calls its empty confirmed state 'confirmed'; both names denote no transient retry.
  assert.ok(['saved','confirmed'].includes(e.d.document.getElementById('sync-status').dataset.state));
  assert.equal(e.window.reviewSync.summary().error,null);
});

test('direct enqueue uses the same validation',async()=>{
  const item=source('round_2/003'),{e,remote}=connected(subset([item]));await e.app();
  const before=snapshot(e);// Give a valid queue identity so refusal exercises candidate validation, not a missing event ID.
  const rejected=await e.window.reviewSync.enqueue({...entry(item,'new'),event_id:'invalid-direct'});
  assert.equal(rejected.queued,false);assert.equal(rejected.validation_failed,true);
  assert.equal(e.window.reviewSync.summary().pending_events,0);
  assert.deepEqual(snapshot(e),before);assert.equal(remote.calls.length,0);
});

test('page loads the shared validator before sync and app',()=>{
  const html=fs.readFileSync(path.join(sourceRoot,'index.html'),'utf8');
  const validator=html.indexOf('src="review-validation.js');
  assert.ok(validator>=0 && validator<html.indexOf('src="sync.js') && validator<html.indexOf('src="app.js'));
});
