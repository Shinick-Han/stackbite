"""POSIX final-package qualification recipes against exact native release source."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,tempfile,time
p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--package',required=True);p.add_argument('--cargo',required=True);p.add_argument('--rustc',required=True);p.add_argument('--target-dir',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
source=pathlib.Path(a.source).resolve(strict=True);package=pathlib.Path(a.package).resolve(strict=True);target=pathlib.Path(a.target_dir).resolve(strict=True)
assert os.name!='nt','Windows uses the existing shared build-lane wrapper'
for d in [source,target,*source.parents]:assert not (d/'ARCHIVED.json').exists()
meta=json.loads((package/'portable.json').read_text());commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
assert commit==meta['commit'] and not subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip()
review=json.loads((package/'stackbite-hook-review.json').read_text());assert review['reviewed_commit']==commit
keep={'PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','CARGO_HOME','RUSTUP_HOME','SDKROOT','MACOSX_DEPLOYMENT_TARGET','SSL_CERT_FILE','SSL_CERT_DIR'}
env={k:v for k,v in os.environ.items() if k in keep};env.update(RUSTC=a.rustc,CARGO_TARGET_DIR=str(target),CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='2',RUST_TEST_THREADS='1',STACKBITE_TEST_NATIVE_BUNDLE=str(package),STACKBITE_BUILD_COMMIT=commit,STACKBITE_BUILD_VERSION=meta['version'])
env['PATH']=str(pathlib.Path(a.rustc).parent)+os.pathsep+env.get('PATH','/usr/bin:/bin')
# Historical packaged recipes still name the removed duplicate launcher. Use
# a private test-only workspace with one explicit adapter; the frozen source
# and the extracted package are never edited or augmented with aliases.
original_test=source/'rust/crates/stackbite-management/tests/provider_context_trust.rs'
test_text=original_test.read_text()
helper='fn packaged_launcher(home: &Path) -> PathBuf {\n    let document: Value = serde_json::from_slice(&fs::read(home.join("manifest.json")).unwrap()).unwrap();\n    let relative = document["binaries"]["stackbite-launcher"]["path"].as_str().unwrap();\n    let path = Path::new(relative);\n    assert!(path.components().all(|c| matches!(c, std::path::Component::Normal(_))));\n    assert_eq!(path.components().count(), 1);\n    home.join(path)\n}\n\n'
anchor='fn a_built_package_review_qualifies_its_launcher() {'
assert test_text.count(anchor)==1
# Put helper before the attributes so #[test]/#[ignore] stay on the recipe.
anchor='#[test]\n#[ignore = "needs STACKBITE_TEST_NATIVE_BUNDLE (an extracted native bundle)"]\n'+anchor
assert test_text.count(anchor)==1;test_text=test_text.replace(anchor,helper+anchor)
for function,end in [('fn a_built_package_review_qualifies_its_launcher()', 'fn prepare_package_launch'),('fn prepare_package_launch','fn assert_package_bypass'),('fn a_built_package_prepares_its_fenced_bypass_and_refuses_a_changed_copy()',None)]:
    lo=test_text.index(function);hi=test_text.index(end,lo) if end else len(test_text)
    part=test_text[lo:hi]
    expected={'fn a_built_package_review_qualifies_its_launcher()':1,'fn prepare_package_launch':1,'fn a_built_package_prepares_its_fenced_bypass_and_refuses_a_changed_copy()':3}[function]
    assert part.count('join(format!("stackbite-launcher{EXE}"))')==expected
    for name in ['home','copy','manifest']:
        part=part.replace(name+'.join(format!("stackbite-launcher{EXE}"))','packaged_launcher(&'+name+')')
    test_text=test_text[:lo]+part+test_text[hi:]
overlay_root=pathlib.Path(tempfile.mkdtemp(prefix='native-trust-test-adapter-',dir=pathlib.Path(os.environ.get('TMPDIR') or tempfile.gettempdir()).resolve()))
overlay_source=overlay_root/'stackbite'
shutil.copytree(source,overlay_source,ignore=shutil.ignore_patterns('.git','.codegraph','target','node_modules','__pycache__','.venv'))
overlay_test=overlay_source/'rust/crates/stackbite-management/tests/provider_context_trust.rs'
assert overlay_test.read_bytes()==original_test.read_bytes()
overlay_test.write_text(test_text)
adapter_evidence={'scope':'test-only manifest-path adaptation, production source and package unchanged','runtime_source':commit,'original_test_sha256':hashlib.sha256(original_test.read_bytes()).hexdigest(),'adapted_test_sha256':hashlib.sha256(overlay_test.read_bytes()).hexdigest(),'workspace':str(overlay_source),'adapter_driver_sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
pathlib.Path(a.receipt).with_suffix('.test-adapter.json').write_text(json.dumps(adapter_evidence,indent=2))
source=overlay_source
manifest=source/'rust/Cargo.toml'

cache_lock=None
selected_release_lane=False
source_record_invalidated=False
package_manifest=json.loads((package/'manifest.json').read_text())
if (target/package_manifest['build_cache']['keys']['build'][:24]/'lane-1').is_dir():
    # --cache-dir is a container of Cargo targets, not itself a Cargo target.
    # Select the exact finished package's existing build lane and serialize it
    # with the builder's lock. Never manufacture a missing Cargo safety tag.
    container=target
    key=package_manifest['build_cache']['keys']['build']
    target=(container/key[:24]/'lane-1').resolve(strict=True)
    assert target.is_relative_to(container) and (target/'CACHEDIR.TAG').is_file()
    cache_lock_path=target.parent/'lane-1.lock'
    cache_lock=cache_lock_path.open('x')
    cache_lock.write(json.dumps({'pid':os.getpid(),'purpose':'exact-package-native-trust','source':commit}));cache_lock.flush()
    selected_release_lane=True
    env['CARGO_TARGET_DIR']=str(target)
    env['STACKBITE_BUILD_TARGET']=package_manifest['target']
    previous=target.parent/'lane-1.source.json'
    if previous.exists():
        pathlib.Path(a.receipt).with_suffix('.lane-source-before.json').write_bytes(previous.read_bytes())
        previous.unlink();source_record_invalidated=True
metadata=json.loads(subprocess.check_output([a.cargo,'metadata','--manifest-path',str(manifest),'--no-deps','--format-version','1','--locked'],env=env,cwd=source))
packages=[x['name']+'@'+x['version'] for x in metadata['packages'] if x.get('source') is None]
assert packages
clean=[a.cargo,'clean','--manifest-path',str(manifest),'--target-dir',str(target)]
if selected_release_lane:clean+=['--release','--target',package_manifest['target']]
for name in packages:clean+=['--package',name]
receipt=pathlib.Path(a.receipt);log=receipt.with_suffix('.log');before=time.monotonic()
# Current Cargo.toml bundles provider_context_trust.rs under bundle_provider.
# Resolve and validate that real target before running either regular or ignored recipes.
management=next(x for x in metadata['packages'] if x['name']=='stackbite-management')
tests={x['name'] for x in management['targets'] if 'test' in x['kind']}
assert {'bundle_provider','codex_qualify_probe'}<=tests
registration=(source/'rust/crates/stackbite-management/tests/bundle_provider.rs').read_text()
assert '#[path = "provider_context_trust.rs"]' in registration and 'mod provider_context_trust;' in registration
base=[a.cargo,'test','--manifest-path',str(manifest),'--locked','-p','stackbite-management']
if selected_release_lane:base+=['--release','--target',package_manifest['target']]
probe=base+['--test','codex_qualify_probe','--','--nocapture','--test-threads=1']
regular=base+['--test','bundle_provider','provider_context_trust::','--','--nocapture','--test-threads=1']
command=base+['--test','bundle_provider','provider_context_trust::','--','--ignored','--nocapture','--test-threads=1']
try:
    with log.open('w') as out:
        code=subprocess.run(clean,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
        for argv in [probe,regular,command]:
            if not code:code=subprocess.run(argv,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
finally:
    if cache_lock is not None:
        cache_lock.close();cache_lock_path.unlink()
text=log.read_text(errors='replace');ran=[line for line in text.splitlines() if line.startswith('test ') and ' ... ok' in line]
assert code==0 and len(ran)>=2,(code,'Expected both direct closure and full prepare package recipes',text[-3000:])
for name in ['a_built_package_prepares_its_fenced_bypass_and_refuses_a_changed_copy','a_built_package_review_qualifies_its_launcher']:
    assert any(name in line for line in ran),('Missing final-package test',name)
record=dict(test_command_routing={'probe':probe,'regular':regular,'ignored':command,'test_source':'provider_context_trust.rs','actual_cargo_target':'bundle_provider','module_filter':'provider_context_trust::'},source=commit,version=meta['version'],package=str(package),native_platform=os.uname().sysname,command=command,exit=code,tests=ran,seconds=round(time.monotonic()-before,2),existing_target=str(target),selected_package_build_lane=selected_release_lane,source_record_invalidated=source_record_invalidated,cleaned_first_party_packages=packages,provider='genuine inert fixture; real vendor login/loading not claimed')
receipt.write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
