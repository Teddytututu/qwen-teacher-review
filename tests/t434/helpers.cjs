'use strict';
// Adapter only: real P318 core/app/sync and shared validator; deterministic DOM/storage/HTTP doubles.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {TextEncoder}=require('node:util');
const sourceRoot=path.resolve(process.env.REVIEW_SOURCE_ROOT||path.join(__dirname,'../..'));
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const appSource=read(path.join(sourceRoot,'app.js')),syncSource=read(path.join(sourceRoot,'sync.js'));
const dataset=JSON.parse(read(path.join(__dirname,'fixtures/data.json')));
const clone=x=>JSON.parse(JSON.stringify(x)),tick=()=>new Promise(resolve=>setImmediate(resolve));
function memory(initial){const values=initial||new Map();return{values,failWrite:false,get length(){return values.size;},key(i){return [...values.keys()][i]??null;},getItem(k){return values.has(k)?values.get(k):null;},setItem(k,v){if(this.failWrite)throw Error('storage failure');values.set(k,String(v));},removeItem(k){values.delete(k);}};}
function locks(){const busy=new Set(),queued=new Map();async function acquire(name,callback){busy.add(name);try{return await callback({name});}finally{busy.delete(name);const q=queued.get(name)||[];if(q.length){const n=q.shift();queued.set(name,q);acquire(name,n.fn).then(n.resolve,n.reject);}}}return{request(name,opts,fn){if(typeof opts==='function'){fn=opts;opts={};}if(busy.has(name)){if(opts.ifAvailable)return Promise.resolve(fn(null));return new Promise((resolve,reject)=>{const q=queued.get(name)||[];q.push({fn,resolve,reject});queued.set(name,q);});}return acquire(name,fn);}};}
function dom(){
 const map=new Map(),handlers=new Map(),elements=[];
 function el(tag='DIV'){
  const classes=new Set(),listeners=new Map();
  const a={tagName:tag.toUpperCase(),children:[],dataset:{},value:'',checked:false,disabled:false,hidden:false,textContent:'',open:false,options:[{},{}],isConnected:true,
   append(...children){for(const c of children){if(c&&typeof c==='object')c.parentElement=this;}this.children.push(...children);},
   replaceChildren(...children){for(const c of this.children)if(c&&typeof c==='object')c.isConnected=false;this.children=[];this.append(...children);},
   setAttribute(k,v){this[k]=String(v);},getAttribute(k){return this[k]??null;},removeAttribute(k){delete this[k];},
   addEventListener(k,f){const q=listeners.get(k)||[];q.push(f);listeners.set(k,q);},
   dispatchEvent(e){e.target??=this;this['on'+e.type]?.(e);for(const f of listeners.get(e.type)||[])f(e);},
   click(){if(!this.disabled)return this.onclick?.({target:this});},focus(){},showModal(){this.open=true;},close(){this.open=false;},
   classList:{add(...cs){cs.forEach(x=>classes.add(x));},remove(...cs){cs.forEach(x=>classes.delete(x));},contains(c){return classes.has(c);},toggle(c,on){const use=on??!classes.has(c);use?classes.add(c):classes.delete(c);return use;}},
   querySelectorAll(selector){const all=[];const visit=n=>{for(const c of n.children||[])if(c&&typeof c==='object'){all.push(c);visit(c);}};visit(this);return select(all,selector);},querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  };
  Object.defineProperty(a,'innerHTML',{set(){throw Error('unexpected innerHTML');}});
  if(a.tagName==='IMG'){
   let src='';a.complete=false;a.naturalWidth=0;a.naturalHeight=0;
   Object.defineProperty(a,'src',{get(){return src;},set(v){src=String(v);a.currentSrc=src;a.complete=false;queueMicrotask(()=>{a.complete=true;a.naturalWidth=128;a.naturalHeight=128;a.dispatchEvent({type:'load',target:a});});}});
   a.decode=async()=>{};
  }
  elements.push(a);return a;
 }
 function select(all,s){
  all=all.filter(x=>x.isConnected!==false);
  if(s==='[data-choice]')return all.filter(x=>x.dataset.choice);
  if(s==='.figure[data-variant]')return all.filter(x=>x.dataset.variant);
  if(s==='img'||s.endsWith(' img'))return all.filter(x=>x.tagName==='IMG');
  if(s==='.missing-image')return all.filter(x=>x.classList.contains('missing-image'));
  if(s.includes('[data-choice]'))return all.filter(x=>x.dataset.choice);
  return [];
 }
 const document={getElementById(id){if(!map.has(id))map.set(id,el());return map.get(id);},createElement:el,querySelectorAll(s){if(s.startsWith('#images '))return this.getElementById('images').querySelectorAll(s.slice(8));return select(elements,s);},querySelector(s){return this.querySelectorAll(s)[0]||null;},addEventListener(k,f){handlers.set(k,f);}};
 for(const [id,value]of[['scope','all'],['filter','all'],['search','']])document.getElementById(id).value=value;
 document.getElementById('advance').checked=false;
 for(const choice of['old','new','redo']){const a=el('button');a.dataset.choice=choice;}
 return{document,map,handlers,elements};
}
function environment(options={}){
 const d=dom(),local=options.local||memory(),session=memory(),l=options.locks||locks(),timers=[],intervals=[],windowEvents=new Map(),syncEvents=[];
 const U=class extends URL{};U.createObjectURL=()=> 'blob:fixture';U.revokeObjectURL=()=>{};
 const fetch=options.fetch||(()=>Promise.resolve({ok:true,json:async()=>clone(options.data||dataset)}));
 const scope={console,document:d.document,localStorage:local,sessionStorage:session,navigator:{locks:l},crypto:{randomUUID:crypto.randomUUID,subtle:crypto.webcrypto.subtle},
  location:{href:'http://127.0.0.1/fixture/index.html',protocol:'http:',search:'',reload(){}},URL:U,URLSearchParams,Blob,TextEncoder,AbortSignal,btoa:s=>Buffer.from(s,'binary').toString('base64'),queueMicrotask,
  setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},setInterval(fn){intervals.push(fn);return intervals.length;},fetch,
  addEventListener(k,f){windowEvents.set(k,f);},QWEN_REVIEW_CONFIG:{isTest:true,apiBase:'https://example.invalid/repos/fixture/review',fetch}};
 scope.window=scope;
 if(options.syncStub!==false)scope.reviewSync={enqueue(x){syncEvents.push(clone(x));return Promise.resolve({queued:true});},seed(xs){xs.forEach(x=>syncEvents.push(clone(x)));return Promise.resolve();},summary(){return{pending_events:syncEvents.length};},configure(){return Promise.resolve();},legacyInfo(){return{};},legacyPending(){return[];},backup(){return null;}};
 const ctx=vm.createContext(scope);
 if(fs.existsSync(path.join(sourceRoot,'review-validation.js')))vm.runInContext(read(path.join(sourceRoot,'review-validation.js')),ctx,{filename:'review-validation.js'});
 vm.runInContext(read(path.join(sourceRoot,'P318-review-core.js')),ctx,{filename:'P318-review-core.js'});
 const result={ctx,d,local,session,l,timers,intervals,windowEvents,syncEvents,window:scope,eval:s=>vm.runInContext(s,ctx),
  async app(){vm.runInContext(appSource,ctx,{filename:'app.js'});await tick();await tick();},
  sync(){vm.runInContext(syncSource,ctx,{filename:'sync.js'});session.setItem('qwen-review-gh-token:test','fixture-token-never-export');},
  async import(data){ctx.importEvent={target:{files:[{text:async()=>JSON.stringify(data)}]}};await vm.runInContext("$('labels-file').onchange(importEvent)",ctx);await tick();},
  async ready(){for(let i=0;i<200;i++){if(scope.reviewApp){await tick();await tick();return;}await new Promise(resolve=>setTimeout(resolve,5));}throw Error('actual reviewApp initialization did not complete');},
  async settle(){await tick();await tick();}};
 return result;
}
function source(uid){return clone(dataset.items.find(x=>x.source_uid===uid));}
function subset(items){return{...clone(dataset),items};}
function entry(item,choice='old',time='2026-10-10T05:00:00.000Z'){return{source_uid:item.source_uid,source_sha256:item.source_sha256,versions:item.versions.map(v=>({key:v.key,native_sha256:v.native_sha256})),choice,updated_at:time};}
function server(mode='normal'){
 const objects=new Map(),calls=[];let dropped=false,onPut=null;const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>clone(value)});
 return{objects,calls,setOnPut(f){onPut=f;},async fetch(url,opts={}){const u=new URL(url),key=u.pathname,method=opts.method||'GET';calls.push({method,path:key});if(method==='GET'){if(mode==='conflict')return response(200,{sha:'different',html_url:'https://example.invalid/conflict',content:Buffer.from('{"other":true}').toString('base64')});if(!objects.has(key))return response(404,{});return response(200,objects.get(key));}assert.equal(method,'PUT');const body=JSON.parse(opts.body);const obj={sha:'fixture-'+crypto.createHash('sha256').update(body.content).digest('hex'),html_url:'https://example.invalid/receipt',content:body.content};objects.set(key,obj);if(onPut){const f=onPut;onPut=null;await f();}if(mode==='commit-drop'&&!dropped){dropped=true;throw Error('committed but response lost');}return response(201,{content:{sha:obj.sha,html_url:obj.html_url}});}};
}
module.exports={environment,source,subset,entry,clone,server,memory,dataset,sourceRoot};
