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
  for package,selector,minimum in [('stackbite-launcher','production::native_connect_',121),('stackbite-terminal-tui','connect::',19)]:
   log=out.with_name('connect-'+package+'.log');argv=[a.cargo,'test','--locked','--release','--target',m['target'],'-p',package,'--lib',selector,'--','--test-threads=1']
   with log.open('w') as f:r=subprocess.run(argv,cwd=S/'rust',env=env,stdout=f,stderr=subprocess.STDOUT)
   text=log.read_text(errors='replace');counts=re.findall(r'test result: ok\. (\d+) passed; 0 failed; (\d+) ignored;',text);n=sum(int(x[0]) for x in counts);ignored=sum(int(x[1]) for x in counts)
   row={'package':package,'exit':r.returncode,'passed':n,'ignored':ignored,'minimum':minimum,'argv':argv,'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()};results.append(row)
   assert r.returncode==0 and n>=minimum and ignored==0,row
 finally:lock.unlink()
assert C==subprocess.check_output(['git','rev-parse','HEAD'],cwd=S,text=True).strip() and not subprocess.check_output(['git','status','--porcelain'],cwd=S,text=True).strip()
record={'source':C,'version':meta['version'],'target':m['target'],'host':os.uname().sysname,'checks':results,'passed':True,'seconds':round(time.monotonic()-started,2),'user_state_touched':False}
out.write_text(json.dumps(record,indent=2));print(json.dumps(record))
