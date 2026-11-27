#!/usr/bin/env node
'use strict';
// Independent regression review of the P318 pure core, using actual manifest rows.
// No framework, browser, network, or production storage is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const args = require('./P318-test-support.cjs').paths();
const ROOT = args.root;
const modulePath = path.join(ROOT, 'P318-review-core.js');
const outputPath = args.result('P318-core-review-results.json');
const C = require(modulePath);
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const BATCHES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/P318-qwen-annotation-batches.json'), 'utf8'));
const TWO = DATA.items[0];
const ONE = DATA.items.find(x => x.versions.length === 1);
const clone = x => JSON.parse(JSON.stringify(x));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const digest = async x => sha(x);
const T0 = '2026-11-26T01:00:00.000Z';

class Storage {
  constructor() { this.values = new Map(); this.fail = false; }
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i] ?? null; }
  getItem(k) { return this.values.get(k) ?? null; }
  setItem(k, v) { if(this.fail) throw Error('QuotaExceededError: review fixture');this.values.set(k,String(v)); }
  removeItem(k) { this.values.delete(k); }
}
let serial = 0;
function store(storage=new Storage(),dataset=DATA) {
  const context=++serial;let seq=0;
  return C.createStore({dataset,storage,now:()=>T0,id:()=>`audit-${context}-${++seq}`,digest,isTest:true});
}
function event(id, item=TWO, choice='old', parents=[], extra={}) {
  return {schema_version:2,event_id:id,dataset_id:DATA.dataset_id,source_manifest_sha256:DATA.source_manifest_sha256,
    source_uid:item.source_uid,source_sha256:item.source_sha256,versions:clone(item.versions),choice,
    updated_at:T0,client_id:'independent-audit',parents,is_test:true,...extra};
}
function envelope(events, version=2, extra={}) {
  return {schema_version:version,dataset_id:DATA.dataset_id,source_manifest_sha256:DATA.source_manifest_sha256,history:events,...extra};
}
function legacy(item=TWO, choice='old', extra={}) {
  return {source_uid:item.source_uid,source_sha256:item.source_sha256,versions:item.versions.map(v=>({key:v.key,native_sha256:v.native_sha256})),choice,updated_at:T0,...extra};
}
const tests=[];
function test(id, risk, fn) { tests.push({id,risk,fn}); }

test('R01','real manifest order normalization does not create false new comparisons',async()=>{
  C.validateDataset(DATA);
  for(const item of DATA.items) {
    const reversed={...item,versions:[...item.versions].reverse()};
    assert.equal(C.comparisonKey(DATA.dataset_id,item),C.comparisonKey(DATA.dataset_id,reversed));
  }
  // An explicitly foreign legacy dataset is evidence, not a missing field to fill.
  const batch=clone(BATCHES[2].data),wrongEntry={...clone(batch.entries[0]),dataset_id:'P318-explicit-wrong-dataset'};
  batch.entries=[wrongEntry];
  const queue={client_id:'P318-dataset-check',pending:[wrongEntry],seen:[],receipts:[],confirmed:0,is_test:true};
  const legacyDatasetErrors=[()=>C.validateQueue(queue,DATA),()=>C.validateBatch(batch,DATA)].map(validate=>{
    try{validate();return null;}catch(error){return error.message;}
  });
  assert.deepEqual(legacyDatasetErrors,['dataset_id mismatch','dataset_id mismatch']);
  return {rows:DATA.items.length,order_changes_preserved_identity:true,legacy_wrong_dataset:{input_dataset_id:wrongEntry.dataset_id,queue_error:legacyDatasetErrors[0],batch_error:legacyDatasetErrors[1]}};
});
test('R02','new without a compared image and malformed timestamps are rejected',async()=>{
  const s=store();
  assert.throws(()=>s.choose(ONE,'new'),/choice has no compared image/);
  for(const value of [undefined,'zz-corrupt-time','2026/11/26']) assert.throws(()=>C.normalizeEvent(event('bad',TWO,'old',[],{updated_at:value}),DATA));
  const result=await s.importData(envelope([legacy(TWO,'redo'),null,legacy(ONE,'new'),legacy(TWO,'new',{updated_at:'zz-corrupt-time'})],1));
  assert.equal(result.accepted,1);assert.equal(result.quarantined,3);assert.equal(s.snapshot().history.length,1);
  const choice=s.choose(TWO,'new');assert.equal(choice.persisted,true);assert.equal(s.exportData().items[0].choice,'new');
  return {stats:result,history:s.exportData().history,quarantine:s.snapshot().quarantine};
});
test('R03','every action survives a complete v2 export/import round trip',async()=>{
  const s=store();s.choose(TWO,'old');s.choose(TWO,'new');s.choose(ONE,'redo');const exported=s.exportData();
  const next=store();const imported=await next.importData(exported);const again=next.exportData();
  assert.equal(imported.accepted,3);assert.deepEqual(again.history,exported.history);assert.deepEqual(again.items,exported.items);
  return {accepted:imported.accepted,history:again.history};
});
test('R04','metadata-only generation change preserves decision and captured provenance',async()=>{
  const disk=new Storage(),s=store(disk);s.choose(TWO,'new');const before=s.exportData();
  const data=clone(DATA);data.items[0].versions.find(x=>x.key==='new').generation_version='changed-name-only';
  const next=store(disk,data);const after=next.exportData();
  assert.equal(after.items[0].choice,'new');assert.equal(after.items[0].selected_generation_version,before.items[0].selected_generation_version);assert.deepEqual(after.history,before.history);
  return {captured_generation:before.items[0].selected_generation_version,current_manifest_generation:'changed-name-only',restored_generation:after.items[0].selected_generation_version};
});
test('R05','a changed source SHA archives the old event without projecting it onto the new source',async()=>{
  const disk=new Storage(),s=store(disk);s.choose(TWO,'old');const data=clone(DATA);data.items[0].source_sha256=sha('changed-source');
  const next=store(disk,data);assert.equal(next.exportData().items.length,0);assert.equal(next.snapshot().archived.length,1);assert.equal(next.snapshot().history[0].source_sha256,TWO.source_sha256);
  return {archived:next.snapshot().archived,active:next.exportData().items};
});
test('R06','same-time divergent decisions keep both heads and one further click resolves them',async()=>{
  const disk=new Storage(),a=store(disk),b=store(disk);a.choose(TWO,'old');b.choose(TWO,'new');const reloaded=store(disk);
  assert.equal(reloaded.snapshot().conflicts.length,1);assert.equal(reloaded.exportData().items.length,0);
  const heads=reloaded.snapshot().conflicts[0].event_ids;const resolution=reloaded.choose(TWO,'redo');assert.deepEqual([...resolution.event.parents].sort(),[...heads].sort());
  assert.equal(reloaded.snapshot().conflicts.length,0);assert.equal(reloaded.exportData().items[0].choice,'redo');assert.equal(reloaded.snapshot().history.length,3);
  return {heads,resolution:resolution.event,history:reloaded.snapshot().history};
});
test('R07','different payloads with the same imported event ID are never silently overwritten',async()=>{
  const s=store();const result=await s.importData(envelope([event('same-id',TWO,'old'),event('same-id',TWO,'new')]));
  assert.equal(result.accepted,1);assert.equal(result.quarantined,1);assert.equal(s.exportData().items[0].choice,'old');
  return {stats:result,retained:s.snapshot().history,quarantine:s.snapshot().quarantine};
});
test('R08','memory-versus-disk collision must mark the in-memory event as not durable',async()=>{
  const disk=new Storage(),s=store(disk);const chosen=s.choose(TWO,'old');const other=C.normalizeEvent({...chosen.event,choice:'new',selected_native_sha256:TWO.versions.find(x=>x.key==='new').native_sha256,selected_generation_version:TWO.versions.find(x=>x.key==='new').generation_version},DATA);
  disk.setItem(s.prefix+chosen.event.event_id,C.stable(other));s.refresh();const state=s.snapshot();
  assert.equal(state.history.find(x=>x.event_id===chosen.event.event_id).choice,'old');assert.ok(state.quarantine.length>0);
  assert.ok(state.unsaved.includes(chosen.event.event_id),'memory event is absent from disk but is not marked unsaved');
  return {memory:state.history,unsaved:state.unsaved,quarantine:state.quarantine,disk:JSON.parse(disk.getItem(s.prefix+chosen.event.event_id))};
});
test('R09','a missing parent from the same comparison can be restored later',async()=>{
  const s=store();await s.importData(envelope([event('child',TWO,'new',['parent'])]));
  assert.deepEqual(s.snapshot().groups.get(C.comparisonKey(DATA.dataset_id,TWO)).missing_parents,['parent']);
  assert.equal(s.exportData().items.length,0,'an incomplete ancestor chain is not a reviewed current choice');
  const result=await s.importData(envelope([event('parent',TWO,'old')]));s.refresh();
  assert.equal(result.accepted,1);assert.equal(s.exportData().items[0].choice,'new');assert.equal(s.snapshot().history.length,2);
  return {stats:result,history:s.snapshot().history};
});
test('R10','a cross-comparison parent diagnoses the incomplete child while preserving both records',async()=>{
  const disk=new Storage(),s=store(disk);await s.importData(envelope([event('child',TWO,'new',['parent'])]));
  assert.equal(s.exportData().items.length,0);
  const result=await s.importData(envelope([event('parent',ONE,'old')]));s.refresh();const after=s.snapshot();
  assert.equal(result.accepted,1);assert.ok(after.quarantine.some(q=>q.raw?.event_id==='child'),'invalid child relation is not diagnosed');
  assert.ok(disk.getItem(s.prefix+'child'),'original child bytes must remain recoverable');
  assert.equal(s.exportData().items.find(x=>x.id===TWO.id),undefined);assert.equal(s.exportData().items.find(x=>x.id===ONE.id).choice,'old');
  return {stats:result,history:after.history,quarantine:after.quarantine};
});
test('R11','a newly imported parent cycle is quarantined as a whole',async()=>{
  const s=store();const result=await s.importData(envelope([event('a',TWO,'old',['b']),event('b',TWO,'new',['a'])]));
  assert.equal(result.accepted,0);assert.equal(result.quarantined,2);assert.equal(s.snapshot().history.length,0);
  return {stats:result,quarantine:s.snapshot().quarantine};
});
test('R12','later input that closes a cycle cannot silently become a current selection',async()=>{
  const disk=new Storage(),s=store(disk);await s.importData(envelope([event('a',TWO,'old',['b'])]));const result=await s.importData(envelope([event('b',TWO,'new',['a'])]));s.refresh();
  assert.ok(result.quarantined>=1);assert.equal(s.exportData().items.length,0);assert.ok(disk.getItem(s.prefix+'a'),'original bytes were removed');
  return {stats:result,history:s.snapshot().history,quarantine:s.snapshot().quarantine};
});
test('R13','legacy import preserves the export envelope manifest, not today\'s manifest',async()=>{
  const data=clone(DATA);data.source_manifest_sha256=sha('current-source-manifest');const s=store(new Storage(),data);
  await s.importData(envelope([legacy(TWO,'new')],1));const e=s.snapshot().history[0];
  assert.equal(e.source_manifest_sha256,DATA.source_manifest_sha256,'legacy provenance was substituted with current manifest');
  assert.equal(e.selected_generation_version,null);assert.ok(e.versions.every(v=>v.generation_version===null));
  return {event:e,export_manifest:DATA.source_manifest_sha256,current_manifest:data.source_manifest_sha256};
});
test('R14','a storage error retains the exportable action and retry persists the same event',async()=>{
  const disk=new Storage(),s=store(disk);disk.fail=true;const chosen=s.choose(TWO,'new');assert.equal(chosen.persisted,false);assert.deepEqual(s.snapshot().unsaved,[chosen.event.event_id]);
  const before=s.exportData();assert.equal(before.history.length,1);disk.fail=false;const saved=s.retrySave();assert.equal(saved[0].persisted,true);assert.equal(saved[0].event_id,chosen.event.event_id);
  const fresh=store(disk);assert.equal(fresh.exportData().items[0].choice,'new');assert.deepEqual(fresh.exportData().history,before.history);
  return {event_id:chosen.event.event_id,before_unsaved:before.recovery.unsaved_event_ids,retry:saved,after:fresh.exportData().history};
});
test('R15','unsaved events invalidated by graph checks cannot crash retrySave',async()=>{
  const disk=new Storage(),s=store(disk);disk.fail=true;
  s.append(event('a',TWO,'old',['b']));s.append(event('b',TWO,'new',['a']));s.refresh();
  assert.doesNotThrow(()=>s.retrySave(),'retry dereferenced an event removed by graph validation');
  return {state:s.snapshot()};
});
test('R16','warm and cold views of the same two-tab graph produce the same current choices',async()=>{
  const disk=new Storage(),a=store(disk),b=store(disk);
  await a.importData(envelope([event('child',TWO,'new',['parent'])]));assert.equal(a.exportData().items.length,0);
  await b.importData(envelope([event('parent',ONE,'old')]));a.refresh();const fresh=store(disk);
  assert.deepEqual(a.exportData().items,fresh.exportData().items,'warm page and reload disagree');
  assert.equal(a.exportData().items.some(x=>x.id===TWO.id),false);
  assert.ok(disk.getItem(a.prefix+'child'));assert.ok(disk.getItem(a.prefix+'parent'));
  return {warm:a.exportData().items,cold:fresh.exportData().items,quarantine:fresh.snapshot().quarantine};
});
test('R17','actual legacy pending metadata and its matching draft snapshot are both retained',async()=>{
  const batch=BATCHES[2].data,pending=clone(batch.entries[0]);pending.is_test=batch.is_test;
  const draft={source_uid:pending.source_uid,source_sha256:pending.source_sha256,versions:clone(pending.versions),choice:pending.choice,updated_at:pending.updated_at};
  const s=store();const first=await s.importData(envelope([pending],1));const second=await s.importData(envelope([draft],1));
  assert.equal(first.quarantined,0);assert.equal(second.quarantined,0,'richer pending and its draft were treated as an event-ID collision');
  assert.equal(s.snapshot().conflicts.length,0);
  assert.ok(s.snapshot().history.some(e=>e.selected_generation_version===pending.selected_generation_version),'known selected generation was discarded');
  assert.ok(s.snapshot().history.some(e=>e.legacy_original_event_id===pending.event_id),'original pending event_id was discarded');
  return {source_pointer:'/2/data/entries/0',pending,draft,first,second,history:s.snapshot().history};
});
test('R18','known and unknown legacy manifests are distinct evidence, not a silent provenance overwrite',async()=>{
  const s=store(),draft=legacy(TWO,'old');const a=await s.importData(envelope([draft],1,{source_manifest_sha256:null}));const b=await s.importData(envelope([draft],1));
  assert.equal(a.quarantined,0);assert.equal(b.quarantined,0);assert.equal(s.snapshot().conflicts.length,0);
  assert.ok(s.snapshot().history.some(e=>e.source_manifest_sha256===null));assert.ok(s.snapshot().history.some(e=>e.source_manifest_sha256===DATA.source_manifest_sha256));
  const duplicate=await s.importData(envelope([draft],1));assert.equal(duplicate.accepted,0);assert.ok(duplicate.duplicates>=1);
  return {first:a,second:b,duplicate,history:s.snapshot().history};
});

(async()=>{
  const results=[];
  for(const t of tests) {
    try {results.push({id:t.id,risk:t.risk,passed:true,output:await t.fn()});}
    catch(error) {results.push({id:t.id,risk:t.risk,passed:false,error:error.message,stack:error.stack});}
  }
  const report={generated_at_utc:new Date().toISOString(),module_sha256:sha(fs.readFileSync(modulePath)),method:'Independent pure-Node API tests; actual attached manifest rows and in-memory Storage double',results,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length};
  fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,failed_ids:results.filter(x=>!x.passed).map(x=>x.id),output:outputPath}));
  if(report.failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
