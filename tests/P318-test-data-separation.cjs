#!/usr/bin/env node
'use strict';
// One adoption-risk counterexample: a synthetic-display fixture uses authentic
// UID/hash metadata, so test marks must survive export/import and shared origins.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=require('./P318-test-support.cjs').paths();
const ROOT=args.root,modulePath=path.join(ROOT,'P318-review-core.js');
const output=args.result('P318-test-data-separation-results.json');
const C=require(modulePath),DATA=JSON.parse(fs.readFileSync(path.join(ROOT,'data.json'),'utf8'));
class Storage{constructor(){this.m=new Map();}get length(){return this.m.size;}key(i){return [...this.m.keys()][i]??null;}getItem(k){return this.m.get(k)??null;}setItem(k,v){this.m.set(k,String(v));}}
let seq=0;const make=(disk,isTest)=>C.createStore({dataset:DATA,storage:disk,isTest,id:()=>`test-separation-${++seq}`,now:()=> '2026-11-26T03:00:00.000Z'});
(async()=>{
  const shared=new Storage(),demo=make(shared,true);const chosen=demo.choose(DATA.items[0],'new');const file=demo.exportData();
  const production=make(new Storage(),false);let imported=null,refusal=null;
  try{imported=await production.importData(file,'synthetic-display demo export');}catch(error){refusal=error.message;}
  const sameOriginProduction=make(shared,false);
  const importedCurrent=production.exportData().items,sharedCurrent=sameOriginProduction.exportData().items;
  const report={generated_at_utc:new Date().toISOString(),module_sha256:crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'),
    risk:'A fixture has real source UID/content hashes but only synthetic display images; it must not become a production human label.',
    input:{source_pointer:'data.json /items/0',dataset_id:DATA.dataset_id,source_uid:chosen.event.source_uid,source_sha256:chosen.event.source_sha256,versions:chosen.event.versions,choice:chosen.event.choice,export_is_test:file.is_test,event_is_test:chosen.event.is_test},
    output:{imported,refusal,imported_current:importedCurrent,shared_origin_current:sharedCurrent,test_prefix:demo.prefix,production_prefix:sameOriginProduction.prefix,quarantine:production.snapshot().quarantine},
    passed:importedCurrent.length===0&&sharedCurrent.length===0};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,import_current:importedCurrent.length,shared_origin_current:sharedCurrent.length,output}));if(!report.passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
