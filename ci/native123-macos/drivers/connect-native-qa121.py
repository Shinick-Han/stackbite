"""Native connect release QA (0.5.121): derived from the 0.5.120 driver by derive121.py. The minimum of each
group is DISCOVERED on this runner (cargo test -- --list of the exact filter) instead of a copied constant;
the run must execute exactly that listed set, all ok, none ignored."""
import argparse,hashlib,json,os,pathlib,re,subprocess,time
p=argparse.ArgumentParser()
for name in ['source','package','cache','cargo','rustc','receipt']:p.add_argument('--'+name,required=True)
a=p.parse_args();S=pathlib.Path(a.source).resolve();B=pathlib.Path(a.package).resolve();cache=pathlib.Path(a.cache).resolve();out=pathlib.Path(a.receipt)
os.umask(0o077)
meta=json.loads((B/'portable.json').read_text());m=json.loads((B/'manifest.json').read_text())
C=subprocess.check_output(['git','rev-parse','HEAD'],cwd=S,text=True).strip()
assert C==meta['commit'] and not subprocess.check_output(['git','status','--porcelain'],cwd=S,text=True).strip()
target=cache/m['build_cache']['keys']['build'][:24]/'lane-1'
assert target.is_dir() and (target/'CACHEDIR.TAG').is_file()
keep={'PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','CARGO_HOME','RUSTUP_HOME','SDKROOT','MACOSX_DEPLOYMENT_TARGET','SSL_CERT_FILE','SSL_CERT_DIR'}
env={k:v for k,v in os.environ.items() if k in keep};env.update(RUSTC=a.rustc,CARGO_TARGET_DIR=str(target),CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='2',STACKBITE_BUILD_COMMIT=C,STACKBITE_BUILD_VERSION=meta['version'],STACKBITE_BUILD_TARGET=m['target'])
env['PATH']=str(pathlib.Path(a.rustc).parent)+os.pathsep+env.get('PATH','/usr/bin:/bin')
lock=target.parent/'lane-1.lock';results=[];started=time.monotonic()
with lock.open('x') as handle:
 handle.write(json.dumps({'pid':os.getpid(),'source':C,'purpose':'connect-native-release-qa'}));handle.flush()
 try:
  for package,selector in [('stackbite-launcher','production::native_connect_'),('stackbite-terminal-tui','connect::')]:
   log=out.with_name('connect-'+package+'.log');argv=[a.cargo,'test','--locked','--release','--target',m['target'],'-p',package,'--lib',selector,'--','--test-threads=1']
   listing=subprocess.run(argv[:-1]+['--list','--format','terse'],cwd=S/'rust',env=env,capture_output=True,text=True)
   listed=re.findall(r'^(\S+): test$',listing.stdout,re.M);minimum=len(listed)
   assert listing.returncode==0 and minimum>0 and len(set(listed))==minimum,('connect discovery failed',package,listing.returncode,minimum)
   with log.open('w') as f:r=subprocess.run(argv,cwd=S/'rust',env=env,stdout=f,stderr=subprocess.STDOUT)
   text=log.read_text(errors='replace');ran=re.findall(r'^test (\S+) \.\.\. ok$',text,re.M);counts=re.findall(r'test result: ok\. (\d+) passed; 0 failed; (\d+) ignored;',text);n=sum(int(x[0]) for x in counts);ignored=sum(int(x[1]) for x in counts)
   row={'package':package,'exit':r.returncode,'passed':n,'ignored':ignored,'minimum':minimum,'discovered':minimum,'discovery':'cargo test -- --list --format terse','listed_sha256':hashlib.sha256('\n'.join(sorted(listed)).encode()).hexdigest(),'argv':argv,'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()};results.append(row)
   assert r.returncode==0 and n==minimum and ignored==0 and sorted(ran)==sorted(listed),row
 finally:lock.unlink()
assert C==subprocess.check_output(['git','rev-parse','HEAD'],cwd=S,text=True).strip() and not subprocess.check_output(['git','status','--porcelain'],cwd=S,text=True).strip()
record={'source':C,'version':meta['version'],'target':m['target'],'host':os.uname().sysname,'checks':results,'passed':True,'seconds':round(time.monotonic()-started,2),'user_state_touched':False}
out.write_text(json.dumps(record,indent=2));print(json.dumps(record))
