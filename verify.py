"""Offline suite: standard-library Node/CLI checks; optional installed browser runtime.
Writes only to --out, never installs packages or contacts a production service.
"""
from pathlib import Path
import argparse,hashlib,json,os,platform,re,shutil,subprocess,sys,datetime
ROOT=Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);p.add_argument('--browser',default=os.environ.get('REVIEW_BROWSER_EXECUTABLE'));p.add_argument('--node',default=os.environ.get('REVIEW_NODE','node'));p.add_argument('--no-browser',action='store_true');a=p.parse_args()
 output=a.out.resolve()
 if output.is_relative_to(ROOT):p.error('--out must be outside the source directory')
 if not shutil.which(a.node):p.error('An installed Node.js runtime is required')
 if not a.no_browser and not a.browser:p.error('Provide --browser /path/to/chromium or explicitly --no-browser; no runtime will be downloaded')
 output.mkdir(parents=True,exist_ok=True)
 env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','REVIEW_SOURCE_ROOT':str(ROOT)}
 if a.browser:env['REVIEW_BROWSER_EXECUTABLE']=a.browser
 env['REVIEW_TEST_OUTPUT']=str(output/'t434-browser')
 if not env.get('PLAYWRIGHT_MODULE') and env.get('CODEX_PRIMARY_RUNTIME_NODE_MODULES'):
  module=Path(env['CODEX_PRIMARY_RUNTIME_NODE_MODULES'])/'playwright'
  if module.is_dir():env['PLAYWRIGHT_MODULE']=str(module)
 def frozen():return {x.relative_to(ROOT).as_posix():hashlib.sha256(x.read_bytes()).hexdigest() for x in sorted(ROOT.rglob('*')) if x.is_file() and '__pycache__' not in x.parts}
 before=frozen();rows=[]
 def run(name,cmd,unit,expected=None):
  result=subprocess.run([str(x) for x in cmd],cwd=ROOT,env=env,text=True,encoding='utf-8',errors='replace',capture_output=True)
  (output/(name+'.log')).write_text(result.stdout+result.stderr,encoding='utf-8')
  row={'name':name,'unit':unit,'expected':expected,'executed':True,'exit_code':result.returncode,'passed':result.returncode==0,'log':name+'.log'}
  for tag in ['tests','pass','fail','skipped']:
   values=re.findall(r'^# '+tag+r' (\d+)\s*$',result.stdout,re.M)
   if values:row['node_'+tag]=int(values[-1])
  rows.append(row);print(name+(' PASS' if row['passed'] else ' FAIL'),flush=True)
 run('p318-original-suite',[a.node,'tests/P318-run-unit-checks.cjs','--root',ROOT,'--output',output/'p318','--python',sys.executable],'original scripts',10)
 run('old-reader',[a.node,'tests/P318-old-reader-check.cjs','--root',ROOT,'--output',output/'old-reader'],'historical compatibility assertions',8)
 for index,count in [(0,22),(2,18)]:run('legacy-queue-'+str(index),[a.node,'tests/P318-legacy-queue-recovery-check.cjs','--root',ROOT,'--batch-index',index,'--output',output/('legacy-queue-'+str(index))],'named recovery assertions',count)
 run('marker-precedence',[a.node,'tools/P318-recover-marker-check.cjs','--recover',ROOT/'tools/P318-recover.cjs','--core',ROOT/'P318-review-core.js','--dataset',ROOT/'data.json','--batch-archive',ROOT/'tests/fixtures/P318-qwen-annotation-batches.json','--modern-export',ROOT/'tests/fixtures/P318-schema2-merge-export.json','--output',output/'marker-precedence.json'],'marker precedence cases',2)
 for name,files,count in [('w04-preserved',['tests/W04-review-core.test.cjs','tests/W04-recovery-cli.test.cjs'],30),('t434-compatible',['tests/t434/review-validation.test.cjs'],13),('merge-boundaries',['tests/merge-boundaries.test.cjs'],6),('legacy-dedup',['tests/merge-legacy-dedup.test.cjs'],2)]:run(name,[a.node,'--test','--test-reporter=tap',*files],'Node test cases',count)
 if a.no_browser:rows.append({'name':'real-browser','executed':False,'passed':None,'skipped':True,'reason':'explicit --no-browser'})
 else:
  run('real-browser',[sys.executable,'-B','tests/browser-merge-check.py','--site',ROOT,'--browser',a.browser,'--out',output/'browser-merge.json'],'real Chromium checks',21)
  run('t434-real-browser',[a.node,'tests/t434/browser-smoke.cjs'],'original browser scenarios with P318 adapter (10 original + 4 test-marker assertions)',6)
 after=frozen();unchanged=before==after
 summary={'generated_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':{'os':platform.platform(),'python':sys.version.split()[0],'node':subprocess.run([a.node,'--version'],capture_output=True,text=True).stdout.strip()},'network_scope':'Only local fixtures, loopback browser interception and in-memory fake HTTP; no production HTTP or package installation','source_unchanged':unchanged,'source_sha256':after,'commands':rows,'failed_commands':sum(r.get('passed') is False for r in rows),'skipped_commands':sum(r.get('skipped',False) for r in rows),'counting_note':'Do not add different units. P318 baseline 19 cases intentionally reproduce old defects; read p318/P318-portable-suite.json for 18 core,9 sync,CLI5 cases/33 named assertions and other scopes.'}
 (output/'run-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
 return 0 if unchanged and not summary['failed_commands'] else 1
if __name__=='__main__':raise SystemExit(main())
