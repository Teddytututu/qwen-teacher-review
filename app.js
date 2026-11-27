'use strict';
let dataset,items=[],queue=[],cursor=0,journal,view,recoveryNotice='',legacyDraftRaw=null;
const $=id=>document.getElementById(id),Core=window.QwenReviewCore;
const key=x=>Core.comparisonKey(dataset.dataset_id,x);
const current=()=>queue[cursor];
function decision(x){return view?.groups.get(key(x))?.decision}
function refreshView(){view=journal.snapshot()}
function showSave(prefix=''){
  refreshView();
  const saved=view.history.length-view.unsaved.length;
  const message=view.unsaved.length?`${view.unsaved.length} 条选择仅保留在此页面，尚未写入本机；请导出 JSON 或重试保存`:
    view.storage_error?'本机存储不可用；导出 JSON 可备份当前页面中的记录':`本机已保存 ${saved} 条选择记录 · 刷新可恢复`;
  $('save').textContent=prefix+message;
  $('local-status').textContent=message;
  $('local-status').dataset.state=view.unsaved.length||view.storage_error?'error':'saved';
  $('retry-save').hidden=!view.unsaved.length;
  const notes=recoveryNotice?[recoveryNotice]:[];
  if(view.conflicts.length)notes.push(`${view.conflicts.length} 组选择有分歧，请重新选一次确认`);
  if(view.quarantine.length)notes.push(`${view.quarantine.length} 条异常记录已隔离，导出 JSON 可检查原记录`);
  if(view.incomplete_event_ids.length)notes.push(`${view.incomplete_event_ids.length} 条历史缺少前序记录，未套用为当前选择`);
  if(view.archived.length)notes.push(`${view.archived.length} 条旧版记录保留在历史中`);
  $('recovery-status').textContent=notes.join('；');
}
function renderHistory(x){
  const container=$('history-list');container.replaceChildren();
  const events=view.history.filter(e=>e.source_uid===x.source_uid).slice().reverse();
  $('history-count').textContent=`本图历史 · ${events.length} 条`;
  $('history-panel').hidden=!events.length;
  const names={old:'原版更好',new:'重跑更好',redo:'都重做'};
  for(const e of events){
    const row=document.createElement('li'),title=document.createElement('p'),detail=document.createElement('code');
    const currentVersion=e.comparison_key===key(x);
    title.textContent=`${e.updated_at} · ${names[e.choice]} · ${currentVersion?'当前比较':'旧版记录'}${e.legacy?' · 旧格式迁入':''}`;
    detail.textContent=`source ${e.source_sha256}\n`+e.versions.map(v=>`${v.key}: ${v.native_sha256} · ${v.generation_version??'旧文件未记录生成版本'}`).join('\n');
    row.append(title,detail);container.append(row);
  }
  $('re-review').onclick=()=>{document.querySelector('#images [data-choice]')?.focus();$('selection').textContent='请直接选择当前原版、重跑版，或都重做；旧记录继续保留'};
}

function rebuild(keep,offset=0){const scope=items.filter(x=>$('scope').value==='all'||x.in_redo);const count=scope.filter(x=>decision(x)).length;$('progress').textContent=`已选择 ${count} / ${scope.length}`;queue=scope.filter(x=>($('filter').value==='all'||($('filter').value==='done')===Boolean(decision(x)))&&x.id.toLowerCase().includes($('search').value.toLowerCase().trim()));cursor=Math.min(Math.max(0,queue.length-1),Math.max(0,keep?queue.findIndex(x=>x.id===keep):0)+offset);render()}
function displayURL(url,contentHash){if(!url)return null;const resolved=new URL(url,location.href);if(['data:','blob:'].includes(resolved.protocol))return resolved.href;resolved.searchParams.set('review_sha256',contentHash);return resolved.href}
// Decoded display availability is separate from native-byte identity verification.
function reviewImagesReady(x=current()){
  if(!x)return false;
  const images=Array.from($('images').querySelectorAll('img'));
  return images.length===1+x.versions.length&&images.every(img=>img.complete&&img.naturalWidth>0);
}
function updateImageGate(){
  const x=current(),ready=reviewImagesReady(x);
  $('images').setAttribute('aria-busy',String(!ready&&!document.querySelector('.missing-image')));
  document.querySelectorAll('[data-choice]').forEach(button=>{
    button.disabled=!ready||button.dataset.choice==='new'&&!x?.versions.some(v=>v.key==='new');
    button.title=ready?'':'等待当前比较的全部图像加载完成';
  });
}
function figure(title,url,choice=null){const box=document.createElement('article');box.className='figure'+(choice&&url?' selectable':'');if(choice)box.dataset.variant=choice;const head=document.createElement('div');head.className='figure-heading';const h=document.createElement('h3');h.textContent=title;head.append(h);const zoom=()=>{$('zoomImage').src=url;$('zoomImage').alt=title;$('zoom').showModal()};if(url&&choice){const enlarge=document.createElement('button');enlarge.className='enlarge';enlarge.textContent='放大';enlarge.setAttribute('aria-label','放大'+title);enlarge.onclick=zoom;head.append(enlarge)}box.append(head);if(url){const button=document.createElement('button');button.className='picture';button.setAttribute('aria-label',choice?'选择'+title:'放大'+title);if(choice)button.dataset.choice=choice;const img=document.createElement('img');img.alt=title;img.decoding='async';img.onload=()=>{if(box.isConnected)updateImageGate()};img.onerror=()=>{if(!box.isConnected)return;box.classList.add('missing-image');img.alt='Native image not included in this package';document.querySelectorAll('[data-choice]').forEach(b=>b.disabled=true);$('selection').textContent='原图像字节未随包提供：已保留历史标签，待导入对应图片后审核。可打开只读展示体验沙盒。';updateImageGate();};img.src=url;button.append(img);button.onclick=choice?()=>choose(choice):zoom;box.append(button);if(choice){const tip=document.createElement('div');tip.className='pick-hint';tip.textContent='点击图片，选择这一版';box.append(tip)}}else{const p=document.createElement('div');p.className='placeholder';p.textContent='重跑队列生成中';box.append(p)}return box}
function render(){const x=current();$('empty').hidden=Boolean(x);$('images').replaceChildren();$('choices').hidden=!x;$('prev').disabled=cursor<=0;$('next').disabled=cursor>=queue.length-1;if(!x){$('id').textContent='当前筛选已完成';$('position').textContent='';$('selection').textContent='';$('credit').replaceChildren();$('history-panel').hidden=true;return}$('id').textContent=x.id;$('position').textContent=`${cursor+1} / ${queue.length}`;$('images').append(figure('原图',displayURL(x.source_image,x.source_sha256)),figure('原版',displayURL(x.versions.find(v=>v.key==='old').image,x.versions.find(v=>v.key==='old').native_sha256),'old'),figure('重跑',displayURL(x.versions.find(v=>v.key==='new')?.image,x.versions.find(v=>v.key==='new')?.native_sha256),'new'));const selected=decision(x);const names={old:'原版更好',new:'重跑更好',redo:'都重做'};const group=view.groups.get(key(x));const previous=view.history.filter(d=>d.source_uid===x.source_uid).slice().reverse()[0];$('selection').textContent=group?.conflict?'不同标签页或导入记录存在不同选择；重新选一次即可确认':selected?'你的选择：'+names[selected.choice]:group?.incomplete_event_ids.length?'历史缺少前序记录，尚未套用；请重新选一次确认':previous?'已有旧版选择：'+names[previous.choice]+'；请比较当前图片':'请选择一张，或将两版都列入重做';document.querySelectorAll('.figure[data-variant]').forEach(box=>box.classList.toggle('picked',box.dataset.variant===selected?.choice));document.querySelectorAll('[data-choice]').forEach(b=>{b.disabled=b.dataset.choice==='new'&&!x.versions.some(v=>v.key==='new');b.setAttribute('aria-pressed',String(selected?.choice===b.dataset.choice))});$('credit').replaceChildren();const p=document.createElement('p');p.textContent=`作者：${x.attribution} · 许可：${x.license} · 来源编号：${x.source_id}`;const link=document.createElement('a');link.href=x.source_page;link.target='_blank';link.rel='noopener';link.textContent='查看原图来源';$('credit').append(p,link);renderHistory(x);updateImageGate()}
function choose(choice){
  const x=current();if(!reviewImagesReady(x)||choice==='new'&&!x.versions.some(v=>v.key==='new'))return;
  const result=journal.choose(x,choice);showSave();
  if(result.persisted)window.reviewSync?.enqueue(result.event).catch(()=>{});
  const oldIndex=cursor;
  if(result.persisted&&$('advance').checked){
    if($('filter').value==='pending')rebuild(undefined,oldIndex);
    else rebuild(x.id,1);
  }else rebuild(x.id);
}
function exportData(){
  journal.refresh();showSave();
  const out=journal.exportData(window.reviewSync?.backup());
  out.diagnostics={stored_root:legacyDraftRaw,rejected_history:out.quarantine,
    sync:window.reviewSync?.diagnostics?.()||null};
  return Core.sanitizeBackup(out);
}

function download(name,text,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('json').onclick=()=>download('qwen-human-annotations.json',JSON.stringify(exportData(),null,2),'application/json');
$('csv').onclick=()=>{const rows=exportData().items,cols=['id','source_uid','choice','status','selected_native_sha256','source_sha256','selected_generation_version','split','license','attribution','updated_at'];const cell=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};download('qwen-human-annotations.csv','\ufeff'+[cols.join(','),...rows.map(r=>cols.map(k=>cell(r[k])).join(','))].join('\r\n'),'text/csv;charset=utf-8')};
$('import').onclick=()=>$('file').click();
async function importData(data){
  const keep=current()?.id;
  const result=await journal.importData(data,'file import');
  recoveryNotice='';refreshView();showSave();rebuild(keep);
  if(data.schema_version===2&&data.server_sync&&(journal.isTest||data.is_test!==true))await window.reviewSync?.restore(data.server_sync,view.history);
  const restoredLegacy=window.reviewSync?.legacyPending()??[];
  if(restoredLegacy.length){
    const recovered=await journal.importData({schema_version:1,dataset_id:journal.dataset.dataset_id,history:restoredLegacy},'restored legacy sync queue');
    for(const key of ['accepted','duplicates','quarantined','unsaved'])result[key]+=recovered[key];
    result.archived=recovered.archived;result.conflicts=recovered.conflicts;
    refreshView();
  }
  await window.reviewSync?.seed(view.history.filter(e=>!view.unsaved.includes(e.event_id)));
  rebuild(keep);
  showSave(`导入新增 ${result.accepted} 条、重复 ${result.duplicates} 条、异常 ${result.quarantined} 条。`);
  return result;
}
$('file').onchange=async e=>{
  try{if(!e.target.files[0])return;await importData(JSON.parse(await e.target.files[0].text()))}
  catch(error){recoveryNotice='导入未完成：'+error.message;showSave()}
  finally{$('file').value=''}
};
// Ordinary annotation import is all-or-nothing validation. Recovery uses importData.
async function importLabels(data){
  if(!dataset||!data||data.dataset_id!==dataset.dataset_id||!Array.isArray(data.history))
    throw Error('请选择本数据集的标注文件（须含 history 数组）');
  const schema=data.schema_version??1;
  if(![1,2].includes(schema))throw Error('unsupported annotation schema_version');
  const validator=Core.createSourceValidator(dataset),staged=[];
  const digest=async value=>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('')};
  for(const raw of data.history){
    const clean=validator.validateHistoryEntry(raw);
    const marked=data.is_test===true?{...clean,is_test:true}:clean;
    if(!journal.isTest&&marked.is_test===true)throw Error('test record is not a production annotation');
    staged.push(schema===1?await Core.legacyEvent(marked,dataset,digest,data.source_manifest_sha256??null):Core.normalizeEvent(marked,dataset));
  }
  const incoming=new Map(view.history.map(event=>[event.event_id,event]));
  for(const event of staged){
    const known=incoming.get(event.event_id);
    if(known&&Core.stable(known)!==Core.stable(event))throw Error('event_id collision');
    incoming.set(event.event_id,event);
  }
  const graph=Core.graphErrors([...incoming.values()]);
  if(staged.some(event=>graph.has(event.event_id)))throw Error('invalid event history graph');
  // No queue, storage, journal or labels have changed before this point.
  const result=await journal.importData({schema_version:2,dataset_id:dataset.dataset_id,history:staged},'validated annotation import');
  refreshView();showSave();rebuild(current()?.id);
  await window.reviewSync?.seed(staged.filter(event=>!view.unsaved.includes(event.event_id)));
  return result;
}
$('import-labels').onclick=()=>$('labels-file').click();
$('labels-file').onchange=async e=>{
  try{if(e.target.files[0])await importLabels(JSON.parse(await e.target.files[0].text()))}
  catch(error){$('save').textContent='导入未完成，原记录未改动：'+error.message}
  finally{$('labels-file').value=''}
};

$('retry-save').onclick=async()=>{journal.retrySave();refreshView();await window.reviewSync?.seed(view.history.filter(e=>!view.unsaved.includes(e.event_id)));showSave();rebuild(current()?.id)};
$('backup-now').onclick=()=>$('json').click();

$('prev').onclick=()=>{cursor=Math.max(0,cursor-1);render()};$('next').onclick=()=>{cursor=Math.min(queue.length-1,cursor+1);render()};for(const id of ['scope','filter','search'])$(id).addEventListener(id==='search'?'input':'change',()=>rebuild());
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName)||$('zoom').open||$('auth-dialog')?.open)return;if(['1','2','3','ArrowLeft','ArrowRight'].includes(e.key))e.preventDefault();if(e.key==='1')choose('old');if(e.key==='2')choose('new');if(e.key==='3')choose('redo');if(e.key==='ArrowLeft')$('prev').click();if(e.key==='ArrowRight')$('next').click()});document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>choose(b.dataset.choice));window.addEventListener('storage',e=>{if(journal&&(e.key===null||e.key.startsWith(journal.prefix)||e.key.startsWith(journal.quarantinePrefix))){journal.refresh();showSave();rebuild(current()?.id)}});
window.addEventListener('beforeunload',e=>{if(journal?.snapshot().unsaved.length){e.preventDefault();e.returnValue=''}});
$('refresh').onclick=()=>location.reload();
(location.protocol==='file:' ? Promise.resolve(window.QWEN_DATA) : fetch('data.json?v='+Date.now(),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('图片清单无法读取');return r.json()})).then(async d=>{
  dataset=Core.validateDataset(d);items=d.items;window.reviewValidation.configureSources(items);
  const isTest=window.QWEN_REVIEW_CONFIG?.isTest===true||d.synthetic_display===true;
  journal=Core.createStore({dataset,storage:()=>localStorage,isTest});
  await window.reviewSync?.configure(d,{isTest});
  if(window.reviewSync?.legacyInfo().error)recoveryNotice='旧同步记录读取异常，请导出备份后检查原记录';
  const legacyKey='qwen-human-review:'+d.dataset_id;
  let legacy=null;
  try{
    legacy=localStorage.getItem(legacyKey);
    if(legacy){const parsed=JSON.parse(legacy);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('旧草稿不是标注对象');await journal.importData({schema_version:1,dataset_id:d.dataset_id,is_test:window.reviewSync?.legacyInfo().is_test===true,history:Object.values(parsed)},'legacy browser draft')}
  }catch(error){
    if(legacy!==null){legacyDraftRaw=legacy;await journal.importData({schema_version:1,dataset_id:d.dataset_id,history:[legacy]},'legacy browser draft parse failure');}
    recoveryNotice+=(recoveryNotice?'；':'')+'旧草稿保留原位，恢复提示：'+error.message;
  }
  // Legacy queue entries can contain clicks that never reached the old draft.
  const pending=window.reviewSync?.legacyPending()??[];
  if(pending.length)await journal.importData({schema_version:1,dataset_id:d.dataset_id,history:pending},'legacy sync queue');
  refreshView();
  $('freshness').textContent=`${d.counts.sources} 张来源图 · 重跑 ${d.counts.reruns}/${d.counts.redo_scope} · ${isTest?'离线演示：图片为合成缩略图，选择为测试记录':'点击选择即可标注'}`;
  $('scope').options[0].textContent=`${d.counts.redo_scope} 张重做清单`;$('scope').options[1].textContent=`全部 ${d.counts.sources} 张`;
  const q=new URLSearchParams(location.search);if(q.get('scope')==='all')$('scope').value='all';
  showSave();rebuild(q.get('id'));
  window.reviewApp={exportData,importData,importLabels,inspect:()=>journal.snapshot(),retrySave:()=>{const results=journal.retrySave();showSave();return results}};
  window.reviewSync?.seed(view.history.filter(e=>!view.unsaved.includes(e.event_id))).catch(()=>{});
}).catch(e=>{$('id').textContent='图片清单读取提示';$('save').textContent=e.message;$('local-status').textContent=e.message});
