#!/usr/bin/env node
'use strict';
// Damage one history timestamp in a real CLI export of one supplied batch.
// Compare exact app.importData, the actual startup legacy-queue bridge, and CLI.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const args = {root:path.resolve(__dirname,'..'),expect:'closed'};
for(let i=2;i<process.argv.length;i++) {
  const a=process.argv[i];
  if(a==='--help'){console.log('node tests/P318-legacy-queue-recovery-check.cjs --output DIRECTORY [--root REPO] [--cli CLI] [--manifest DATA] [--batch-index 0|2] [--expect closed|vulnerable]');process.exit(0);}
  if(!['--root','--cli','--manifest','--output','--expect','--batch-index'].includes(a)||!process.argv[i+1])throw Error('Invalid argument '+a);
  args[a.slice(2)]=process.argv[++i];
}
if(!args.output||!['closed','vulnerable'].includes(args.expect))throw Error('Use --output DIRECTORY and valid --expect');
const root=path.resolve(args.root), output=path.resolve(args.output);
const relative=path.relative(root,output);
if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('--output must be outside --root');
fs.mkdirSync(output,{recursive:true});
const cli=path.resolve(args.cli||path.join(root,'tools/P318-recover.cjs'));
const manifest=path.resolve(args.manifest||path.join(root,'data.json'));
const batchFile=path.join(__dirname,'fixtures/P318-qwen-annotation-batches.json');
const Core=require(path.join(root,'P318-review-core.js'));
const DATA=JSON.parse(fs.readFileSync(manifest)), APP=fs.readFileSync(path.join(root,'app.js'),'utf8'), SYNC=fs.readFileSync(path.join(root,'sync.js'),'utf8');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const inputFiles=[manifest,batchFile,cli,path.join(root,'app.js'),path.join(root,'sync.js'),path.join(root,'P318-review-core.js'),__filename];
const hashes=()=>Object.fromEntries(inputFiles.map(f=>[f,sha(fs.readFileSync(f))]));
const start=APP.indexOf('async function importData(data){'), end=APP.indexOf("$('file').onchange",start);
const bridgeStart=APP.indexOf('const pending=window.reviewSync?.legacyPending()??[];');
const bridgeEnd=APP.indexOf('  refreshView();',bridgeStart);
assert.ok(start>=0&&end>start&&bridgeStart>=0&&bridgeEnd>bridgeStart);
const importFunction=APP.slice(start,end), startupBridge=APP.slice(bridgeStart,bridgeEnd);
class Storage {
  constructor(){this.values=new Map();}
  get length(){return this.values.size;}
  key(i){return [...this.values.keys()][i]??null;}
  getItem(k){return this.values.get(k)??null;}
  setItem(k,v){this.values.set(k,String(v));}
  removeItem(k){this.values.delete(k);}
}
async function realm(storage){
  let serial=0; const session=new Storage(), requests=[], nodes=new Map();
  const journal=Core.createStore({dataset:DATA,storage,isTest:true,now:()=> '2026-11-26T07:30:00.000Z',
    id:()=> 'P318-legacy-queue-'+(++serial),digest:async value=>sha(value)});
  const scope={console,QwenReviewCore:Core,QWEN_REVIEW_CONFIG:{isTest:true,apiBase:'https://example.invalid',fetch:async(...a)=>{requests.push(a);throw Error('Unexpected network');}},
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',dataset:{},disabled:false});return nodes.get(id);},addEventListener(){}},
    localStorage:storage,sessionStorage:session,navigator:{locks:{request:async(name,options,callback)=>(typeof options==='function'?options:callback)({name})}},
    crypto:{randomUUID:()=> 'P318-sync-legacy-queue-'+(++serial)},Date,TextEncoder,btoa:value=>Buffer.from(value,'binary').toString('base64'),
    AbortSignal:{timeout:()=>({})},setTimeout:()=>1,setInterval:()=>1,addEventListener(){},journal,dataset:DATA,d:DATA,
    view:journal.snapshot(),recoveryNotice:'',current:()=>DATA.items.find(x=>x.source_uid==='round_2/000')};
  scope.window=scope;const context=vm.createContext(scope);
  vm.runInContext(SYNC,context,{filename:'actual-sync.js'});await scope.reviewSync.configure(DATA,{isTest:true});
  vm.runInContext('function refreshView(){view=journal.snapshot()} function showSave(){refreshView()} function rebuild(){}\n'+importFunction,context,{filename:'actual-app-import.js'});
  return {scope,context,journal,requests,session};
}
function runCLI(input,folder){
  const command=[cli,'--dataset',manifest,'--test-data','--out',path.join(output,folder),input];
  const r=spawnSync(process.execPath,command,{encoding:'utf8'});
  if(r.error)throw r.error;
  return {command:[process.execPath,...command],exit_code:r.status,stdout:r.stdout,stderr:r.stderr,
    report:JSON.parse(fs.readFileSync(path.join(output,folder,'P318-merge-report.json'))),
    exported:JSON.parse(fs.readFileSync(path.join(output,folder,'P318-merged-annotations.json')))};
}
async function main(){
  const began=new Date().toISOString(), beforeHashes=hashes();
  const batchIndex=Number(args['batch-index']||0);
  assert.ok([0,2].includes(batchIndex),'Use original batch 0 (no manifest field) or 2 (known manifest field)');
  const batch=JSON.parse(fs.readFileSync(batchFile))[batchIndex].data;
  write('P318-original-single-batch.json',batch);
  const pristine=runCLI(path.join(output,'P318-original-single-batch.json'),'P318-pristine');
  assert.equal(pristine.exit_code,0);assert.equal(pristine.exported.history.length,5);
  const damaged=clone(pristine.exported);
  damaged.history[0].updated_at='P318-damaged-history-timestamp';
  write('P318-legacy-queue-damaged-history.json',damaged);
  const storage=new Storage(), first=await realm(storage);
  first.scope.__input=damaged;
  const imported=await vm.runInContext('importData(__input)',first.context);
  const warm=first.journal.exportData(first.scope.reviewSync.backup());
  const second=await realm(storage);
  await vm.runInContext('(async()=>{'+startupBridge+'refreshView()})()',second.context,{filename:'actual-app-startup-legacy-bridge.js'});
  const reloaded=second.journal.exportData(second.scope.reviewSync.backup());
  const cliResult=runCLI(path.join(output,'P318-legacy-queue-damaged-history.json'),'P318-damaged-recovered');
  let rejectedControl=null;
  if(args.expect==='closed'&&batchIndex===0){
    const contradictory=clone(damaged);
    contradictory.server_sync.queue.pending[0].choice='new';
    write('P318-legacy-queue-rejected-input.json',contradictory);
    rejectedControl=runCLI(path.join(output,'P318-legacy-queue-rejected-input.json'),'P318-rejected-queue');
  }
  const damagedUid=damaged.history[0].source_uid;
  const choice=x=>x.items.find(e=>e.source_uid===damagedUid)?.choice??null;
  const compact=x=>({history:x.history.length,current:x.items.length,quarantine:x.quarantine.length,
    pending:x.server_sync.queue.pending.length,choice_for_damaged_source:choice(x),
    history_manifest_values:[...new Set(x.history.map(e=>e.source_manifest_sha256))]});
  const checks={pristine_original_batch_recovery:pristine.exit_code===0,
    exactly_one_history_field_damaged:pristine.exported.history.every((e,i)=>Core.stable(i===0?{...damaged.history[i],updated_at:e.updated_at}:damaged.history[i])===Core.stable(e)),
    original_pending_retained:Core.stable(damaged.server_sync.queue.pending)===Core.stable(pristine.exported.server_sync.queue.pending),
    original_batch_retained:Core.stable(damaged.server_sync.queue.recovered_batches[0])===Core.stable(batch),
    pending_payloads_unchanged:[warm,reloaded,cliResult.exported].every(x=>Core.stable(x.server_sync.queue.pending)===Core.stable(damaged.server_sync.queue.pending)),
    recovered_batch_bytes_unchanged:[warm,reloaded,cliResult.exported].every(x=>Core.stable(x.server_sync.queue.recovered_batches[0])===Core.stable(batch)),
    quarantine_keeps_damaged_record:[warm,reloaded,cliResult.exported].every(x=>x.quarantine.some(q=>q.raw?.updated_at==='P318-damaged-history-timestamp')),
    no_network:first.requests.length+second.requests.length===0,
    no_credentials:first.session.length+second.session.length===0,
    input_sources_unchanged:Core.stable(beforeHashes)===Core.stable(hashes()),
    reload_recovers_five_choices:reloaded.items.length===5&&(args.expect==='closed'?reloaded.history.length===5:reloaded.history.length>=5),
    expected_app_warm:warm.history.length===(args.expect==='closed'?5:4),
    expected_cli:cliResult.exported.history.length===(args.expect==='closed'?5:4),
    warm_reload_parity:args.expect==='closed'?Core.stable(warm.history)===Core.stable(reloaded.history):warm.history.length!==reloaded.history.length,
    cli_reports_damaged_input:cliResult.exit_code===3,
    no_recovery_conflict:[warm,reloaded,cliResult.exported].every(x=>x.conflicts.length===0),
    pending_not_duplicated:[warm,reloaded,cliResult.exported].every(x=>x.server_sync.queue.pending.length===5),
    manifest_context_matches_expectation:args.expect==='closed'?
      [warm,reloaded,cliResult.exported].every(x=>x.history.every(e=>e.source_manifest_sha256===(batch.source_manifest_sha256??null))):
      warm.history.every(e=>e.source_manifest_sha256===(batch.source_manifest_sha256??null))
  };
  if(rejectedControl)Object.assign(checks,{
    rejected_queue_exit_is_attention:rejectedControl.exit_code===3,
    rejected_pending_never_becomes_current:rejectedControl.exported.history.length===4&&rejectedControl.exported.items.length===4&&choice(rejectedControl.exported)===null,
    rejected_original_kept:rejectedControl.exported.quarantine.some(q=>q.raw?.pending?.[0]?.choice==='new'),
    rejected_queue_diagnosed:rejectedControl.report.queue_errors.length===1&&rejectedControl.exported.quarantine.length===2
  });
  const report={is_test:true,synthetic_display:true,started_at_utc:began,finished_at_utc:new Date().toISOString(),expect:args.expect,
    method:'Exact actual app import and startup bridge with actual core/sync in independent VM realms; DOM presentation and Web Locks are doubles. CLI child process. One original supplied batch, one damaged history timestamp. No network or browser pixels.',
    source_sha256:beforeHashes,input_origin:{file:batchFile,pointer:'/'+batchIndex+'/data',batch_id:batch.batch_id,source_manifest_sha256:batch.source_manifest_sha256??null,changed_pointer:'/history/0/updated_at'},
    import_function:importFunction,startup_bridge:startupBridge,imported,observed:{warm:compact(warm),reloaded:compact(reloaded),cli:compact(cliResult.exported)},checks,
    passed:Object.values(checks).every(Boolean),cli:{command:cliResult.command,exit_code:cliResult.exit_code,stdout:cliResult.stdout,stderr:cliResult.stderr},
    rejected_queue_control:rejectedControl?{command:rejectedControl.command,exit_code:rejectedControl.exit_code,
      result:rejectedControl.report.result,current_choices:rejectedControl.exported.items}:null};
  write('P318-warm-export.json',warm);write('P318-reloaded-export.json',reloaded);write('P318-legacy-queue-recovery-result.json',report);
  console.log(JSON.stringify({output,expect:args.expect,observed:report.observed,checks:Object.keys(checks).length,passed:report.passed}));
  assert.ok(report.passed);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
