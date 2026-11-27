"""Build a standalone, synthetic, network-free review demo."""
from pathlib import Path
import json
import re
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'tests/fixtures/data.json').read_text('utf-8'))
data['synthetic_display'] = True
for item in data['items']:
    for index, target in enumerate([item, *item['versions']]):
        color = ['#527d9f', '#77a18d', '#c48658'][index]
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="{color}"/><circle cx="128" cy="128" r="70" fill="white"/></svg>'
        target['source_image' if target is item else 'image'] = 'data:image/svg+xml,' + quote(svg)

html = (ROOT / 'index.html').read_text('utf-8')
html = re.sub(r'<link rel="stylesheet"[^>]+>', '<style>' + (ROOT / 'style.css').read_text('utf-8') + '</style>', html)
html = re.sub(r'<script src="[^"]+"></script>', '', html)
html = re.sub(r'<dialog id="auth-dialog".*?</dialog>', '', html, flags=re.S)
html = re.sub(r'<button id="(?:connect-github|sync-now)"[^>]*>.*?</button>', '', html)
html = html.replace('148张重做清单', '演示比较清单').replace('全部500张', '全部2张演示图')
html = html.replace('每5次选择保存到 GitHub', '虚构演示 · 保存到当前浏览器')
html = html.replace('选你喜欢的图', '选图演示 · 虚构数据')
html = html.replace('href="ATTRIBUTIONS.json"', 'href="data:application/json,%7B%22source%22:%22synthetic%22%7D"')
html = html.replace('<head>', '''<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">''')
setup = '''
const demoData = __DEMO_DATA__;
window.QWEN_DATA=demoData;
window.QWEN_REVIEW_CONFIG={isTest:true};
document.getElementById('sync-status').textContent='虚构演示：仅本机保存，不连接远端';
window.fetch = async url => {
  if(String(url).startsWith('data.json'))return {ok:true,json:async()=>demoData};
  throw Error('演示只读取内嵌虚构清单');
};
// No synchronization module or remote configuration is embedded in this demo.
'''.replace('__DEMO_DATA__', json.dumps(data, ensure_ascii=False))
app = (ROOT / 'app.js').read_text('utf-8').replace(
    '500张原图 · 重跑已同步 ${d.counts.reruns}/148 · 点击选择即可标注',
    '${d.counts.sources}张虚构演示图 · ${d.counts.reruns}组双候选 · 点击选择即可标注')
code = setup + '\n' + (ROOT / 'review-validation.js').read_text('utf-8') + '\n' + (ROOT / 'P318-review-core.js').read_text('utf-8') + '\n' + app
html = html.replace('</body>', '<script>' + code + '</script></body>')
(ROOT / 'demo.html').write_text(html, encoding='utf-8', newline='\n')
print('Created demo.html from synthetic fixtures and current page source')
