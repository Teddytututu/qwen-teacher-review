"""Targeted real-browser regression. All display images are synthetic local fixtures.
No remote service, real teacher image, credential, or production sync is used.
"""
from pathlib import Path
import argparse, hashlib, json
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = HERE.parent
FIXTURE = b'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="green"/></svg>'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', type=Path, default=DEFAULT_BASE)
    parser.add_argument('--browser', default='/tmp/chromium')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    site = args.site.resolve()
    data = json.loads((site / 'data.json').read_text())
    data['synthetic_display'] = True
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        def session(patched, item='round_2_000'):
            context = browser.new_context()
            pending = []
            def handle(route):
                parsed = urlsplit(route.request.url)
                if parsed.hostname != 'localhost':
                    route.abort(); return
                rel = unquote(parsed.path).lstrip('/')
                if rel.startswith('images/'):
                    pending.append(route); return
                if rel == 'data.json':
                    route.fulfill(json=data); return
                if rel == 'config.js':
                    route.fulfill(content_type='application/javascript',body='window.QWEN_REVIEW_CONFIG={isTest:true};'); return
                target = site / rel
                if not target.is_file():
                    route.fulfill(status=404,body='missing'); return
                route.fulfill(path=target)
            context.route('**/*', handle)
            page = context.new_page()
            page.goto('http://localhost:9988/index.html?scope=all&id='+item, wait_until='domcontentloaded')
            page.wait_for_function('()=>Boolean(window.reviewApp)')
            page.wait_for_function('()=>document.querySelectorAll("#images img").length>0')
            page.evaluate('document.activeElement?.blur()')
            return context,page,pending
        def close_session(context, page, pending):
            page.wait_for_timeout(50)
            while pending:
                pending.pop().abort()
            page.wait_for_timeout(50)
            context.unroute_all(behavior='wait')
            context.close()
        def add(name, ok, detail=None):
            results.append({'name':name,'passed':bool(ok),'detail':detail})
        def selected(page):
            return page.evaluate('window.reviewApp.inspect().history.length')
        def release(page, routes, count=None, fail=False):
            chosen=routes[:count] if count is not None else list(routes)
            for route in chosen:
                if fail: route.abort()
                else: route.fulfill(content_type='image/svg+xml',body=FIXTURE)
                routes.remove(route)
            page.wait_for_timeout(80)
        context,page,pending=session(True)
        add('pending_buttons_disabled',page.locator('[data-choice]').evaluate_all('(xs)=>xs.every(x=>x.disabled)'))
        page.locator('[data-choice=old]').first.click(force=True); add('pending_native_click_blocked',selected(page)==0)
        page.evaluate('document.activeElement?.blur()');page.keyboard.press('1'); add('pending_keyboard_blocked',selected(page)==0)
        page.evaluate("choose('redo')"); add('pending_programmatic_choice_blocked',selected(page)==0)
        release(page,pending,1)
        add('one_of_three_images_blocks',page.locator('[data-choice]').evaluate_all('(xs)=>xs.every(x=>x.disabled)'))
        release(page,pending,1)
        add('two_of_three_images_blocks',page.locator('[data-choice]').evaluate_all('(xs)=>xs.every(x=>x.disabled)'))
        release(page,pending)
        add('all_images_unlock_choices',page.locator('[data-choice=old]').first.is_enabled() and page.locator('[data-choice=new]').first.is_enabled())
        page.keyboard.press('1')
        add('ready_keyboard_persists_one_test_event',selected(page)==1 and page.evaluate('window.reviewApp.exportData().is_test===true'))
        close_session(context,page,pending)
        context,page,pending=session(True)
        release(page,pending,1,fail=True); release(page,pending)
        page.evaluate("choose('old')")
        add('current_failed_image_blocks',selected(page)==0 and page.locator('.missing-image').count()==1 and page.locator('[data-choice=old]').first.is_disabled())
        close_session(context,page,pending)
        context,page,pending=session(True)
        old_routes=list(pending); pending.clear()
        page.click('#next'); page.wait_for_timeout(50)
        release(page,pending)
        for route in old_routes: route.abort()
        page.wait_for_timeout(80)
        add('stale_previous_error_does_not_lock_current',page.locator('.missing-image').count()==0 and page.locator('[data-choice=old]').first.is_enabled())
        close_session(context,page,pending)
        context,page,pending=session(True,'round_2_003')
        release(page,pending)
        add('one_version_item_enables_old_keeps_new_disabled',page.locator('[data-choice=old]').first.is_enabled() and page.locator('[data-choice=new]').evaluate_all('(xs)=>xs.every(x=>x.disabled)'))
        page.evaluate("choose('new')"); add('absent_new_version_blocked',selected(page)==0)
        page.evaluate("choose('redo')"); add('one_version_ready_redo_allowed',selected(page)==1)
        close_session(context,page,pending)
        context,page,pending=session(True)
        release(page,pending)
        page.locator('.review-menu').evaluate('(e)=>e.open=true');page.uncheck('#advance');page.locator('[data-choice=new]').first.click()
        add('ready_native_click_records_choice',selected(page)==1 and page.evaluate("window.reviewApp.exportData().items[0].choice==='new'"))
        # The queued event remains test-marked; refreshing must retain it.
        page.reload(wait_until='domcontentloaded');page.wait_for_function('()=>Boolean(window.reviewApp)')
        add('refresh_keeps_history_with_pending_images',selected(page)==1)
        close_session(context,page,pending)
        context,page,pending=session(True)
        item=data['items'][0]
        entry={'source_uid':item['source_uid'],'source_sha256':item['source_sha256'],
          'versions':item['versions'],'choice':'old','updated_at':'2026-11-27T09:00:00.000Z'}
        envelope={'dataset_id':data['dataset_id'],'history':[entry,None]}
        before=page.evaluate('JSON.stringify(Object.entries(localStorage))')
        page.locator('#labels-file').set_input_files({'name':'invalid-labels.json','mimeType':'application/json','buffer':json.dumps(envelope).encode()})
        page.wait_for_function("()=>document.getElementById('save').textContent.includes('未完成')")
        add('strict_file_import_bad_tail_atomic',selected(page)==0 and page.evaluate('JSON.stringify(Object.entries(localStorage))')==before)
        envelope['history']=[entry]
        page.locator('#labels-file').set_input_files({'name':'valid-labels.json','mimeType':'application/json','buffer':json.dumps(envelope).encode()})
        page.wait_for_function('()=>window.reviewApp.inspect().history.length===1')
        add('strict_file_import_valid_retained',page.evaluate("window.reviewApp.exportData().items[0].choice==='old'"))
        backup=page.evaluate('window.reviewApp.exportData()')
        bad={'schema_version':1,'dataset_id':data['dataset_id'],'history':[None]}
        page.locator('#file').set_input_files({'name':'damaged-backup.json','mimeType':'application/json','buffer':json.dumps(bad).encode()})
        page.wait_for_function('()=>window.reviewApp.inspect().quarantine.length>0')
        add('recovery_file_import_quarantines_preserves_history',selected(page)==1)
        page.locator('.review-menu').evaluate('(e)=>e.open=true')
        with page.expect_download() as event: page.locator('#json').click()
        downloaded=Path(event.value.path());exported=json.loads(downloaded.read_text())
        add('real_json_download_keeps_journal_and_test_marker',len(exported['history'])==1 and exported['is_test'] is True and len(exported['quarantine'])>0)
        page.set_viewport_size({'width':390,'height':900})
        add('review_mobile_390_no_overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        close_session(context,page,pending)
        # Single-file demo embeds the actual merged app/core with explicit test isolation.
        context=browser.new_context();context.route('http://**/*',lambda route:route.abort());context.route('https://**/*',lambda route:route.abort())
        page=context.new_page();page.goto((site/'demo.html').as_uri(),wait_until='domcontentloaded')
        page.wait_for_function('()=>Boolean(window.reviewApp)')
        page.wait_for_function('()=>!document.querySelector("[data-choice=old]").disabled')
        page.locator('[data-choice=old]').first.click()
        add('standalone_demo_real_click_is_test',page.evaluate('window.reviewApp.inspect().history.length===1&&window.reviewApp.exportData().is_test===true'))
        context.close();browser.close()
    report={'scope':'merged production scripts; synthetic display assets; all HTTP requests intercepted locally',
        'app_sha256':hashlib.sha256((site/'app.js').read_bytes()).hexdigest(),
        'core_sha256':hashlib.sha256((site/'P318-review-core.js').read_bytes()).hexdigest(),
        'expected':len(results),'executed':len(results),'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'skipped':0,'tests':results}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    raise SystemExit(0 if report['failed']==0 else 1)
if __name__ == '__main__': main()
