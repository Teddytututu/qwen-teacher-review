const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../P318-review-core.js');
const full=JSON.parse(fs.readFileSync(path.join(__dirname,'../data.json'),'utf8'));
const d={...full,items:full.items.slice(0,2)};const item=d.items[0];
function storage(){const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),clear:()=>m.clear()}}
let serial=0;function store(st=storage()){return C.createStore({dataset:d,storage:st,id:()=>`fixture-${++serial}`,now:()=>new Date().toISOString()})}
test('dataset validates unique identities',()=>a.equal(C.validateDataset(d),d));
test('duplicate source identity rejected',()=>a.throws(()=>C.validateDataset({...d,items:[item,item]})));
test('malformed hashes rejected',()=>a.throws(()=>C.validateDataset({...d,source_manifest_sha256:'x'})));
test('safe batch paths reject traversal',()=>a.throws(()=>C.pathId('../bad','path')));
test('metadata rename keeps comparison identity',()=>a.equal(C.comparisonKey(d.dataset_id,item),C.comparisonKey(d.dataset_id,{...item,versions:item.versions.map(v=>({...v,generation_version:'renamed'}))})));
test('native byte changes alter identity',()=>a.notEqual(C.comparisonKey(d.dataset_id,item),C.comparisonKey(d.dataset_id,{...item,versions:item.versions.map(v=>({...v,native_sha256:'a'.repeat(64)}))})));
test('source byte changes alter identity',()=>a.notEqual(C.comparisonKey(d.dataset_id,item),C.comparisonKey(d.dataset_id,{...item,source_sha256:'b'.repeat(64)})));
test('append preserves old event on changed decision',()=>{const s=store();s.choose(item,'old');s.choose(item,'new');a.equal(s.snapshot().history.length,2);a.equal(s.exportData().items[0].choice,'new')});
test('refresh restores persisted event',()=>{const st=storage();store(st).choose(item,'old');a.equal(store(st).exportData().items[0].choice,'old')});
test('duplicate import is idempotent',async()=>{const s=store();s.choose(item,'old');const e=s.exportData();await s.importData(e);a.equal(s.snapshot().history.length,1)});
test('conflicting branches are explicit until rechoose',async()=>{const one=store(),two=store();one.choose(item,'old');two.choose(item,'new');await one.importData(two.exportData());a.equal(one.snapshot().conflicts.length,1);one.choose(item,'redo');a.equal(one.snapshot().conflicts.length,0)});
test('legacy real human records migrate',async()=>{const old=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/P318-real-history-reconstruction.json')));const s=store();const stats=await s.importData(old);a.ok(stats.accepted>=7);a.equal(s.snapshot().history.length,old.history.length)});
test('malformed import quarantines instead of selecting',async()=>{const s=store();const stats=await s.importData({schema_version:1,dataset_id:d.dataset_id,history:[{choice:'old'}]});a.equal(stats.quarantined,1);a.equal(s.exportData().items.length,0)});
test('unknown dataset cannot merge',async()=>{await a.rejects(()=>store().importData({schema_version:2,dataset_id:'other',history:[]}))});
test('quota failure retains unsaved event',()=>{const st=storage();st.setItem=()=>{throw Error('quota')};const s=store(st);a.equal(s.choose(item,'old').persisted,false);a.equal(s.snapshot().unsaved.length,1)});
test('export retains a quota-failed choice',()=>{const st=storage();st.setItem=()=>{throw Error('quota')};const s=store(st);s.choose(item,'new');a.equal(s.exportData().history.length,1)});
test('test records cannot pollute production',async()=>{const t=C.createStore({dataset:d,storage:storage(),isTest:true});t.choose(item,'old');const s=store();const stats=await s.importData(t.exportData());a.equal(stats.quarantined,1);a.equal(s.exportData().items.length,0)});
test('token nested in quarantined input is stripped on export',async()=>{const s=store();await s.importData({schema_version:1,dataset_id:d.dataset_id,history:[{token:'FAKE_SECRET_123',bad:true}]});const exp=s.exportData({token:'FAKE_SECRET_123',pending:[],raw:'{"authorization":"FAKE_SECRET_123"}'});a.ok(!JSON.stringify(exp).includes('FAKE_SECRET_123'));a.ok(!JSON.stringify(C.sanitizeBackup('token=FAKE_SECRET_123')).includes('FAKE_SECRET_123'))});

test('credential fields cannot be queued for remote sync',()=>{const s=store();const e=s.choose(item,'old').event;a.throws(()=>C.validateQueueEntry({...e,token:'FAKE_TOKEN'},d),/credential/)});
test('credential fields cannot enter immutable batch payload',()=>{const s=store();const e=s.choose(item,'old').event;a.throws(()=>C.validateBatch({dataset_id:d.dataset_id,client_id:'safe',batch_id:'batch',created_at:new Date().toISOString(),entries:[e],authorization:'FAKE'},d),/credential/)});

test('repeated credential-bearing malformed imports do not duplicate quarantine',async()=>{const s=store();const input={schema_version:1,dataset_id:d.dataset_id,history:[{token:'FAKE',bad:true}]};await s.importData(input);await s.importData(input);a.equal(s.snapshot().quarantine.length,1)});
test('malformed quoted credential strings with punctuation are fully redacted',()=>{a.ok(!C.sanitizeBackup('{"token":"FAKE!@# TOKEN",broken').includes('FAKE'));a.ok(!C.sanitizeBackup("password='private ! word',broken").includes('private'))});
