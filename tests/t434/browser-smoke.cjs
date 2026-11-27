'use strict';
// Real-browser smoke test. The ephemeral local server serves synthetic fixtures only.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const root=path.resolve(process.env.REVIEW_SOURCE_ROOT||path.join(__dirname,'../..'));
const output=path.resolve(process.env.REVIEW_TEST_OUTPUT || path.join(root,'.review-work'));
const item={id:'fixture_001',source_uid:'fixture/001',source_sha256:'c'.repeat(64),
  source_id:'synthetic',split:'fixture',license:'CC0',attribution:'Synthetic test fixture',
  source_page:'https://example.invalid/source',source_image:'fixture.svg',in_redo:true,
  versions:[{key:'old',native_sha256:'a'.repeat(64),image:'fixture.svg',generation_version:'fixture-1'}]};
const data={dataset_id:'synthetic-review-test',source_manifest_sha256:'d'.repeat(64),
  counts:{sources:1,reruns:0,redo_scope:1},synthetic_display:true,items:[item]};
const assetTypes={'index.html':'text/html','style.css':'text/css','app.js':'text/javascript',
  'sync.js':'text/javascript','review-validation.js':'text/javascript',
  'P318-review-core.js':'text/javascript','config.js':'text/javascript','data.js':'text/javascript'};

(async()=>{
  await fs.mkdir(output,{recursive:true});
  let browser;const errors=[],external=[];
  const server=http.createServer(async(req,res)=>{
    try{
      const file=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
      if(file==='data.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
      else if(file==='data.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end('window.QWEN_DATA='+JSON.stringify(data)+';');}
      else if(file==='fixture.svg'){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#527d9f"/><circle cx="64" cy="64" r="35" fill="#fff"/></svg>');}
      else if(file==='favicon.ico'){res.writeHead(204);res.end();}
      else if(assetTypes[file]){res.writeHead(200,{'Content-Type':assetTypes[file]});res.end(await fs.readFile(path.join(root,file)));}
      else{res.writeHead(404);res.end();}
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    browser=await chromium.launch({headless:true,
      ...(process.env.REVIEW_BROWSER_EXECUTABLE ? {executablePath:process.env.REVIEW_BROWSER_EXECUTABLE} : {})});
    const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
    await context.route('**/*',route=>{
      if(route.request().url().startsWith(origin+'/'))return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?scope=all');
    await page.getByRole('heading',{name:'fixture_001',exact:true}).waitFor();
    await page.locator('.review-menu > summary').click();
    await page.locator('#advance').uncheck();
    // The merged menu has extra recovery controls; close its real overlay before clicking an image.
    await page.locator('.review-menu > summary').click();
    await page.getByRole('button',{name:'选择原版',exact:true}).click();
    const exported=async()=>{
      if(!await page.locator('.review-menu').evaluate(el=>el.open))await page.locator('.review-menu > summary').click();
      const wait=page.waitForEvent('download');await page.locator('#json').click();
      const download=await wait;return JSON.parse(await fs.readFile(await download.path(),'utf8'));
    };
    const importHistory=async(history)=>{
      await page.locator('#labels-file').setInputFiles({name:'fixture.json',mimeType:'application/json',
        buffer:Buffer.from(JSON.stringify({schema_version:2,dataset_id:data.dataset_id,is_test:true,history}))});
    };
    const selected=await exported();assert.equal(selected.items[0].choice,'old');
    assert.equal(selected.is_test,true);assert.ok(selected.history.every(e=>e.is_test===true));
    const good=selected.history[0];
    await importHistory([{...good,choice:'new',selected_native_sha256:null}]);
    await page.locator('#save').filter({hasText:'导入未完成'}).waitFor();
    const rejected=await exported();assert.deepEqual(rejected.history,selected.history);
    const invented={...good,event_id:'T434-adapted-invented',parents:[],versions:[{...good.versions[0],key:'old',native_sha256:'f'.repeat(64)}],selected_native_sha256:'f'.repeat(64)};
    delete invented.comparison_key; // Changed native identity must be recomputed by the real core.
    await importHistory([invented]);
    const historical=await exported();assert.equal(historical.history.length,2);
    assert.equal(historical.items.length,1);assert.equal(historical.items[0].selected_native_sha256,'a'.repeat(64));
    await page.reload();await page.getByRole('heading',{name:'fixture_001',exact:true}).waitFor();
    await page.locator('.review-menu > summary').click();
    const restored=await exported();assert.equal(restored.history.length,2);assert.equal(restored.is_test,true);
    await importHistory([{...good,event_id:'T434-adapted-redo',parents:[good.event_id],choice:'redo',selected_native_sha256:null,selected_generation_version:null,updated_at:'2099-01-01T00:00:00.000Z'}]);
    const redo=await exported();assert.equal(redo.items[0].status,'redo');assert.equal(redo.is_test,true);
    assert.equal(await page.evaluate(()=>sessionStorage.length),0);
    assert.equal(external.length,0);assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'browser-smoke.png'),fullPage:true});
    const result={passed:true,checks:['UI choice','JSON download','invalid import retains labels',
      'invented hash stays historical','reload preserves history','valid redo import'],
      external_requests:external.length,session_storage_entries:0,page_errors:errors,synthetic_fixture:true,is_test:true,original_business_assert_call_sites:10,additional_test_marker_assert_call_sites:4,adaptation:'Explicit labels-file with schema-2 events; distinct invented event ID; redo child points to existing head; real P318 dependencies served'};
    await fs.writeFile(path.join(output,'browser-smoke.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  }finally{
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
