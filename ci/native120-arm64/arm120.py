"""Native macOS arm64 0.5.120 fallback helper for one standard public GitHub macos-15 job.

The job is hosted in the public distributor repository; the PRODUCT is the frozen public
source commit pinned in arm120-pins.json, fetched credential-free into its own checkout.
The two identities differ and both are recorded: ci_* (distributor GITHUB_SHA, workflow,
run) and product/source_* (the checkout's actual Git HEAD/tree, which the unmodified
builder reads itself). Nothing here sets or overrides a build identity.

The verification contract is the reviewed Intel driver of the SAME frozen source
(ci/native120/intel120.py, digest-pinned), imported by path and called unchanged with
arm64 pins of the same shape: package audit (exact seven bins, no phone, two equal
reproducible lanes, MSRV, toolchain, anchor, Mach-O minos 13.0.0, unsigned), bundle
verification, safe extraction, 0.5.119 core reuse + native source pins, pinned download
and the runtime qualification check. Its x86_64-only `load_pins`/`host_check`/`run_ci`
are not used; nothing is monkeypatched.

  arm120.py plan [--source DIR]          offline: pins, reviewed pins, drivers, optional committed source pins
  arm120.py pin KEY                      print one pin (dotted key) for the job script
  arm120.py ci --out FILE                GitHub job identity: distributor HEAD == GITHUB_SHA, clean, committed bytes
  arm120.py host --out FILE              native Darwin arm64, not translated
  arm120.py source --src DIR --out FILE  frozen source identity (HEAD/tree/clean/standalone/pinned files)
  arm120.py inputs --src --work --out    pinned 0.5.119 arm64 archive, core reuse + source pins, anchor file
  arm120.py strip-probe --src --work --out --cargo --rustc --linker --sdk
                                         early toolchain gate: llvm-tools host LLVM library, real rust-objcopy,
                                         tiny strip=symbols release build in the builder's own environment
  arm120.py audit --src --work --out     package audit, archive extraction/verification, Mach-O arm64
  arm120.py runtime --src --work --out --qa Q   copy + check native-runtime-qa qualification.json
  arm120.py final --src --work --out --qa Q --job-exit N   collect existing evidence; never fabricates
"""
import argparse, hashlib, importlib.util, json, os, pathlib, platform, re, shutil, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
PINS = HERE / 'arm120-pins.json'
SCHEMA = 'stackbite.native120.arm64-fallback-pins.v1'
RESULT_SCHEMA = 'stackbite.native120.arm64-fallback-result.v1'
WORKFLOW = '.github/workflows/native-macos-arm64-fallback.yml'
PUBLISHED = (WORKFLOW, 'ci/native120-arm64/arm120.py', 'ci/native120-arm64/arm120-job.sh',
             'ci/native120-arm64/arm120-pins.json', 'ci/native120-arm64/mac-reviewed-pins-aarch64.json',
             'ci/native120-arm64/drivers/package-native-trust-adapted.py',
             'ci/native120-arm64/drivers/connect-native-qa.py', 'ci/native120-arm64/drivers/ordinary-posix.py')
INTEL = 'ci/native120/intel120.py'
RUNTIME_QA = 'ci/native120/native-runtime-qa.py'
DRIVERS = ('package-native-trust-adapted.py', 'connect-native-qa.py', 'ordinary-posix.py')
SOURCE_FILES = (INTEL, RUNTIME_QA, 'scripts/qa/lifecycle_regression.py', 'requirements-build.txt')
REMOTE_BINS = ('stackbite-remote', 'stackbite-remote-bridge')
MACHO_ARM64 = bytes.fromhex('cffaedfe0c000001')   # MH_MAGIC_64, CPU_TYPE_ARM64 (little-endian)
MACHO_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')
# The job script runs exactly these steps in this order (tests compare the script to this list).
STEPS = ('ci', 'host', 'source-fetch', 'source', 'venv', 'anchor', 'inputs', 'toolchain-1.98.1', 'toolchain-1.85.1',
         'llvm-tools-1.98.1', 'strip-probe', 'preflight-0', 'preflight-1', 'rust', 'portable', 'audit', 'runtime-qa', 'runtime-check',
         'lifecycle-single', 'lifecycle-update', 'provider-trust', 'connect-native-tests', 'ordinary', 'end-source')
# Evidence files: (copied name in ci-out, source relative to the QA parent or None when a driver writes it in place).
COLLECT = (('macos-arm64-runtime-qa.json', 'rq/qualification.json'),
           ('macos-arm64-runtime-qa-failure.json', 'rq/failure.json'),
           ('macos-arm64-lifecycle-single.json', 'ls/result.json'),
           ('macos-arm64-lifecycle-update.json', 'lu/result.json'),
           ('macos-arm64-ordinary-entry.json', 'rq/ordinary-entry-proof.json'),
           ('macos-arm64-ordinary-stages.jsonl', 'rq/ordinary-stages.jsonl'))
REQUIRED = ('ci.json', 'host.json', 'source.json', 'inputs.json', 'strip-probe.json', 'audit.json', 'macos-arm64-rust-manifest.json',
            'macos-arm64-bundle-manifest.json', 'macos-arm64-runtime-qa.json', 'runtime-check.json',
            'macos-arm64-lifecycle-single.json', 'macos-arm64-lifecycle-update.json',
            'macos-arm64-provider-trust.json', 'macos-arm64-provider-trust.test-adapter.json',
            'macos-arm64-connect-native-tests.json', 'macos-arm64-ordinary-entry.json', 'end-source.json')
HEX40, HEX64 = re.compile('[0-9a-f]{40}').fullmatch, re.compile('[0-9a-f]{64}').fullmatch
# Strip probe (rust-lang/rust#164063: rust-objcopy loads LLVM through an RPATH into the toolchain's host
# lib directory, which only the official llvm-tools component populates; fixed by rust-lang/rust#164134).
OTOOL, NM = '/usr/bin/otool', '/usr/bin/nm'
PROBE = 'sb120-strip-probe'
PROBE_MANIFEST = ('[package]\nname = "sb120-strip-probe"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n'
                  '[workspace]\n\n[profile.release]\nstrip = "symbols"\n')
PROBE_MAIN = ('#[inline(never)]\nfn sb120_probe_marker(value: u64) -> u64 {\n    value.wrapping_mul(31).rotate_left(7)\n}\n\n'
              'fn main() {\n    let value = sb120_probe_marker(std::hint::black_box(6));\n'
              '    println!("sb120-strip-probe {value}");\n}\n')
PROBE_OUTPUT = 'sb120-strip-probe 23808'
PROBE_MARKERS = ('sb120_probe_marker', 'sb120_strip_probe')
# Any Cargo/rustc warning fails the probe even when Cargo exits 0 (rustc reports a failed strip as a warning).
PROBE_WARNING = re.compile(r'^\s*warning\b|rust-objcopy|llvm-objcopy|library not loaded|dyld|sigabrt|abort', re.I | re.M)
LLVM_DEPENDENCY = re.compile(r'^\s*@rpath/(libLLVM[A-Za-z0-9_.+-]*\.dylib)\s', re.M)


class Refused(SystemExit):
    pass


def fail(*message):
    raise Refused('ARM120 REFUSED: ' + ' '.join(map(str, message)))


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(root, *args, binary=False):
    out = subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True).stdout
    return out if binary else out.decode('utf-8').strip()


def write_json(path, document, exclusive=True):
    path = pathlib.Path(path)
    with path.open('x' if exclusive else 'w', encoding='utf-8') as stream:
        stream.write(json.dumps(document, indent=2) + '\n')


def load_pins(path=PINS):
    pins = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    old, core, src = pins.get('old119') or {}, pins.get('core') or {}, pins.get('source') or {}
    rev = pins.get('macos_reviewed_pins_file') or {}
    bins = pins.get('bins') or []
    ok = (pins.get('schema') == SCHEMA and pins.get('version') == '0.5.120' and pins.get('baseline_version') == '0.5.119'
          and pins.get('platform') == 'macos-arm64' and pins.get('target') == 'aarch64-apple-darwin'
          and pins.get('runner') == 'macos-15' and pins.get('ci_repository') == 'Shinick-Han/stackbite'
          and src.get('repository') == 'shinick-dev/stackbite' and HEX40(str(src.get('commit'))) and HEX40(str(src.get('tree')))
          and pins.get('toolchain') == '1.98.1' and pins.get('msrv') == '1.85.1' and pins.get('deployment_target') == '13.0'
          and len(bins) == 7 and len(set(bins)) == 7 and bins == sorted(bins) and not any('phone' in b for b in bins)
          and set(REMOTE_BINS) <= set(bins)
          and all(HEX64(str(v)) for v in (old.get('sha256'), core.get('library_sha256'), core.get('manifest_sha256'),
                                          pins.get('update_public_key'), rev.get('sha256')))
          and str(old.get('url', '')).startswith('https://github.com/Shinick-Han/stackbite/releases/download/v0.5.119/')
          and old['url'].endswith('/' + str(old.get('name'))) and '-macos-arm64-' in old['name']
          and isinstance(old.get('size'), int) and 0 < old['size'] <= 64 * 1024 * 1024
          and old.get('version') == '0.5.119' and HEX40(str(old.get('commit'))) and HEX40(str(old.get('source_tree')))
          and core.get('directory') == 'private_pty/_native/terminal-core'
          and set(pins.get('drivers') or {}) == set(DRIVERS) and all(HEX64(str(v)) for v in pins['drivers'].values())
          and set(pins.get('source_files') or {}) == set(SOURCE_FILES) and all(HEX64(str(v)) for v in pins['source_files'].values())
          and isinstance(pins.get('preflights'), list) and len(pins['preflights']) == 2
          and all(set(p) == {'package', 'filter', 'expect'} and all(isinstance(v, str) and v and "'" not in v for v in p.values())
                  for p in pins['preflights'])
          and rev.get('path') == 'mac-reviewed-pins-aarch64.json')
    if not ok:
        fail('arm120 pins are incomplete or inconsistent')
    return pins


def reviewed_pins(pins, here=HERE):
    data = (pathlib.Path(here) / pins['macos_reviewed_pins_file']['path']).read_bytes()
    if sha256_bytes(data) != pins['macos_reviewed_pins_file']['sha256']:
        fail('reviewed macOS pins file differs from its pin')
    doc = json.loads(data)
    if (doc.get('schema') != 'stackbite-macos-reviewed-pins-v1' or doc.get('target') != pins['target']
            or (doc.get('core') or {}).get('sha256') != pins['core']['library_sha256']
            or (doc.get('core') or {}).get('library') != 'libstackbite-terminal-core.dylib'):
        fail('reviewed macOS pins do not describe the pinned arm64 core')
    return doc


def contract_pins(pins, reviewed):
    """The arm64 pins in exactly the dict shape the Intel driver functions read (no x86 value inside)."""
    keys = ('version', 'baseline_version', 'target', 'toolchain', 'msrv', 'deployment_target', 'bins', 'old119', 'core',
            'update_public_key')
    return dict({k: pins[k] for k in keys}, macos_reviewed_pins=reviewed)


def check_drivers(pins, here=HERE):
    found = {name: sha256(pathlib.Path(here) / 'drivers' / name) for name in DRIVERS}
    if found != pins['drivers']:
        fail('a Root qualification driver differs from its pin', sorted(k for k in found if found[k] != pins['drivers'][k]))
    return found


def load_intel(src, pins):
    """The frozen source's own reviewed Intel driver module, by path, after its digest check (unchanged)."""
    path = pathlib.Path(src) / INTEL
    if sha256(path) != pins['source_files'][INTEL]:
        fail('the source Intel driver differs from its pin')
    spec = importlib.util.spec_from_file_location('stackbite_native120_intel120', path)
    module = importlib.util.module_from_spec(spec)
    saved = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = saved
    for name in ('component_identity', 'audit_package', 'verify_bundle', 'safe_extract', 'prepare_core',
                 'core_source_pins', 'check_runtime_qualification', 'download', 'load_builder', 'builder_source_identity'):
        if not callable(getattr(module, name, None)):
            fail('the Intel driver contract lacks', name)
    return module


def source_file_pins(src, pins, *, worktree=True):
    """Every pinned source file: committed HEAD blob (and the checked-out bytes) equal the pin."""
    found = {}
    for rel, expected in pins['source_files'].items():
        blob = sha256_bytes(git(src, 'cat-file', 'blob', 'HEAD:' + rel, binary=True))
        disk = sha256(pathlib.Path(src) / rel) if worktree else blob
        if blob != expected or disk != expected:
            fail('pinned source file differs', rel)
        found[rel] = expected
    return found


def source_identity(src, pins, intel=None):
    src = pathlib.Path(src).resolve(strict=True)
    if intel is not None:
        identity = intel.component_identity(src, standalone=True, github_sha=None, require_clean=True,
                                            baseline=pins['baseline_version'])
    else:
        identity = dict(commit=git(src, 'rev-parse', '--verify', 'HEAD^{commit}'), tree=git(src, 'rev-parse', 'HEAD^{tree}'),
                        clean=not git(src, 'status', '--porcelain', '--untracked-files=all'))
    if (identity['commit'], identity['tree']) != (pins['source']['commit'], pins['source']['tree']):
        fail('checked-out source HEAD/tree differ from the frozen pins')
    if identity.get('clean') is not True:
        fail('source checkout is not clean')
    return dict(identity, repository=pins['source']['repository'],
                shallow=git(src, 'rev-parse', '--is-shallow-repository') == 'true')


def mode_plan(args, pins):
    reviewed = reviewed_pins(pins)
    plan = dict(schema='stackbite.native120.arm64-fallback-plan.v1', executes=False, network=False,
                ci_repository=pins['ci_repository'], runner=pins['runner'], source=pins['source'], target=pins['target'],
                version=pins['version'], bins=pins['bins'], drivers=check_drivers(pins),
                reviewed_pins_sha256=pins['macos_reviewed_pins_file']['sha256'], steps=list(STEPS),
                old119=dict((k, pins['old119'][k]) for k in ('name', 'sha256', 'size', 'commit')),
                contract_keys=sorted(contract_pins(pins, reviewed)))
    if args.source:
        src = pathlib.Path(args.source)
        head = (git(src, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD^{tree}'))
        if head != (pins['source']['commit'], pins['source']['tree']):
            fail('offline source HEAD/tree differ from the frozen pins')
        plan['source_files'] = source_file_pins(src, pins, worktree=False)
        version = json.loads(git(src, 'cat-file', 'blob', 'HEAD:package.json')).get('version')
        if version != pins['baseline_version']:
            fail('source package baseline differs', version)
        plan['source_verified_offline'] = True
    print(json.dumps(plan, indent=2))


def mode_pin(args, pins):
    value = pins
    for part in args.key.split('.'):
        value = value[int(part)] if isinstance(value, list) else value[part]
    print(' '.join(value) if isinstance(value, list) else value)


def mode_ci(args, pins):
    env = os.environ
    if env.get('GITHUB_ACTIONS') != 'true':
        fail('ci mode runs only inside the public GitHub Actions job')
    if env.get('GITHUB_REPOSITORY') != pins['ci_repository']:
        fail('job is not hosted in the pinned distributor', env.get('GITHUB_REPOSITORY'))
    root = HERE.parent.parent
    head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
    if head != env.get('GITHUB_SHA'):
        fail('distributor checkout HEAD differs from GITHUB_SHA')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        fail('distributor checkout is not clean')
    files = {}
    for rel in PUBLISHED:
        blob = sha256_bytes(git(root, 'cat-file', 'blob', 'HEAD:' + rel, binary=True))
        if blob != sha256(root / rel):
            fail('distributor file differs from its committed blob', rel)
        files[rel] = blob
    check_drivers(pins)
    reviewed_pins(pins)
    write_json(args.out, dict(ci_repository=env['GITHUB_REPOSITORY'], ci_commit=head, ci_tree=git(root, 'rev-parse', 'HEAD^{tree}'),
                              workflow_ref=env.get('GITHUB_WORKFLOW_REF'), workflow_sha=env.get('GITHUB_WORKFLOW_SHA'),
                              run_id=env.get('GITHUB_RUN_ID'), run_attempt=env.get('GITHUB_RUN_ATTEMPT'),
                              event=env.get('GITHUB_EVENT_NAME'), ref=env.get('GITHUB_REF'), files=files))


def host_record(run=subprocess.run, system=platform.system, machine=platform.machine):
    if system() != 'Darwin' or machine() != 'arm64':
        fail('needs a native arm64 macOS runner', system(), machine())
    sysctl = lambda key: run(['/usr/sbin/sysctl', '-n', key], capture_output=True, text=True).stdout.strip()
    translated, arm64 = sysctl('sysctl.proc_translated'), sysctl('hw.optional.arm64')
    if translated not in ('0', '') or arm64 != '1':
        fail('translated or non-arm64 process', translated, arm64)
    return dict(system='Darwin', machine='arm64', translated=False, hw_optional_arm64=True, mac_ver=platform.mac_ver()[0],
                python=sys.version.split()[0], python_machine=machine(), runner_os=os.environ.get('RUNNER_OS'),
                runner_arch=os.environ.get('RUNNER_ARCH'), image_os=os.environ.get('ImageOS'),
                image_version=os.environ.get('ImageVersion'))


def mode_host(args, pins):
    write_json(args.out, host_record())


def mode_source(args, pins):
    intel = load_intel(args.src, pins)
    identity = source_identity(args.src, pins, intel)
    identity['source_files'] = source_file_pins(args.src, pins)
    write_json(args.out, identity)


def mode_inputs(args, pins):
    intel, work, out = load_intel(args.src, pins), pathlib.Path(args.work), pathlib.Path(args.out)
    cpins, old = contract_pins(pins, reviewed_pins(pins)), pins['old119']
    (work / 'old119').mkdir()
    archive = work / 'old119' / old['name']
    intel.download(old['url'], archive, old['size'], old['sha256'])
    bundle = intel.safe_extract(archive, work / 'old119', old['name'].removesuffix('.tar.gz'))
    manifest = intel.verify_bundle(bundle, version=old['version'], commit=old['commit'], tree=old['source_tree'],
                                   target=pins['target'])
    if manifest.get('update_public_key') != pins['update_public_key']:
        fail('0.5.119 arm64 update anchor differs from the pinned key')
    core = intel.prepare_core(bundle, work / 'core', cpins)
    core['source_pins'] = intel.core_source_pins(args.src, work / 'core')
    if (work / 'core' / 'libstackbite-terminal-core.dylib').read_bytes()[:8] != MACHO_ARM64:
        fail('0.5.119 core library is not a 64-bit arm64 Mach-O')
    (work / 'inputs').mkdir()
    (work / 'inputs' / 'update-public.pub').write_text(pins['update_public_key'] + '\n', encoding='ascii')
    write_json(out / 'inputs.json', dict(old119=dict(name=old['name'], sha256=sha256(archive), size=archive.stat().st_size,
                                                     bundle=str(bundle)), core=core))


def tail(text, limit=4000):
    return text if len(text) <= limit else '...' + text[-limit:]


def recorded_run(record, run, argv, *, env, cwd, timeout=1800):
    argv = [str(a) for a in argv]
    row = dict(argv=argv, cwd=str(cwd))
    record['commands'].append(row)
    try:
        result = run(argv, env=env, cwd=str(cwd), capture_output=True, text=True, encoding='utf-8', errors='replace',
                     timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        row['error'] = repr(error)
        fail('strip probe command did not run', argv[0], error)
    row.update(exit=result.returncode, stdout=tail(result.stdout or ''), stderr=tail(result.stderr or ''))
    return result


def same_path(a, b):
    return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))


def strip_probe(*, src, work, out, pins, cargo, rustc, linker, sdk, intel, base, run=subprocess.run):
    """Early toolchain gate before every expensive build; writes strip-probe.json (also on refusal) and never fabricates."""
    record = dict(schema='stackbite.native120.arm64-strip-probe.v1', ok=False, toolchain=pins['toolchain'],
                  target=pins['target'], deployment_target=pins['deployment_target'], commands=[])
    try:
        _strip_probe(record, src=src, work=work, pins=pins, cargo=cargo, rustc=rustc, linker=linker, sdk=sdk,
                     intel=intel, base=dict(base), run=run)
        record['ok'] = True
    except Refused as refusal:
        record['refused'] = str(refusal.code)
        raise
    finally:
        write_json(pathlib.Path(out) / 'strip-probe.json', record)
    return record


def _strip_probe(record, *, src, work, pins, cargo, rustc, linker, sdk, intel, base, run):
    tc, target = pins['toolchain'], pins['target']
    src, work = pathlib.Path(src).resolve(strict=True), pathlib.Path(work).resolve(strict=True)
    probe = work / 'strip-probe'
    if probe.is_relative_to(src) or src.is_relative_to(probe):
        fail('strip probe must stay outside the source checkout', probe)
    if probe.exists() or probe.is_symlink():
        fail('strip probe directory already exists', probe)
    dyld = sorted(k for k in base if k.startswith('DYLD_'))
    if dyld:
        fail('the build environment must not carry dyld overrides', dyld)
    # Provenance: the frozen clean checkout and the builder's own identity probe (commit time = epoch).
    identity = source_identity(src, pins, intel)
    builder = intel.load_builder(src)
    probe_id = intel.builder_source_identity(builder, src, 'strip probe')
    if (probe_id['commit'], probe_id['tree']) != (identity['commit'], identity['tree']):
        fail('builder source identity differs from the checkout')
    record['source'] = dict(commit=identity['commit'], tree=identity['tree'], epoch=probe_id['epoch'])
    home = base.get('RUSTUP_HOME') or ''
    if not os.path.isabs(home):
        fail('RUSTUP_HOME must be the private absolute rustup home')
    sysroot = pathlib.Path(home) / 'toolchains' / f'{tc}-{target}'
    for tool, name in ((rustc, 'rustc'), (cargo, 'cargo')):
        if not same_path(tool, sysroot / 'bin' / name):
            fail(f'{name} is not the private {tc} toolchain binary', tool)
    probe.mkdir()
    project, target_dir = probe / 'project', probe / 'target'
    (project / 'src').mkdir(parents=True)
    (project / 'Cargo.toml').write_text(PROBE_MANIFEST, encoding='utf-8', newline='\n')
    (project / 'src' / 'main.rs').write_text(PROBE_MAIN, encoding='utf-8', newline='\n')
    # Exactly the builder's compiler environment (same base as the rust step), only its target dir is the probe's.
    env = intel.builder_environment(builder, base, source=src, target_dir=target_dir, rustc=rustc,
                                    commit=probe_id['commit'], version=pins['version'], target=target,
                                    epoch=probe_id['epoch'], linker=linker, sdk=sdk,
                                    deployment_target=pins['deployment_target'], anchor=pins['update_public_key'])
    if any(k.startswith('DYLD_') for k in env) or not same_path(env.get('CARGO_TARGET_DIR', ''), target_dir):
        fail('the builder environment is not the sanitized probe environment')
    record['environment'] = dict(keys=sorted(env), sha256=sha256_bytes(json.dumps(sorted(env.items())).encode('utf-8')),
                                 cargo_target_dir=str(target_dir))

    vv = recorded_run(record, run, [rustc, '-vV'], env=env, cwd=probe)
    info = dict(line.split(': ', 1) for line in (vv.stdout or '').splitlines() if ': ' in line)
    if vv.returncode != 0 or info.get('release') != tc or info.get('host') != target:
        fail('rustc is not the native', tc, target, 'compiler', info.get('release'), info.get('host'))
    printed = recorded_run(record, run, [rustc, '--print', 'sysroot'], env=env, cwd=probe)
    if printed.returncode != 0 or not same_path((printed.stdout or '').strip(), sysroot):
        fail('rustc sysroot is not the private toolchain', (printed.stdout or '').strip())
    # Check the Rust distribution's expected host lib path itself; rustup's exit status is not evidence.
    host = sysroot / 'lib' / 'rustlib' / target
    objcopy, host_lib = host / 'bin' / 'rust-objcopy', host / 'lib'
    if objcopy.is_symlink() or not objcopy.is_file():
        fail('the toolchain has no rust-objcopy', objcopy)
    deps = recorded_run(record, run, [OTOOL, '-L', objcopy], env=env, cwd=probe)
    names = sorted(set(LLVM_DEPENDENCY.findall(deps.stdout or '')))
    if deps.returncode != 0 or len(names) != 1:
        fail('rust-objcopy does not name exactly one @rpath LLVM library', names)
    loads = recorded_run(record, run, [OTOOL, '-l', objcopy], env=env, cwd=probe)
    lines = (loads.stdout or '').splitlines()
    rpaths = [re.sub(r'\s+\(offset \d+\)\s*$', '', lines[i + 2].strip()[5:]) for i, line in enumerate(lines[:-2])
              if line.strip() == 'cmd LC_RPATH' and lines[i + 2].strip().startswith('path ')]
    resolved = [os.path.realpath(p.replace('@loader_path', str(objcopy.parent)).replace('@executable_path', str(objcopy.parent)))
                for p in rpaths]
    library = host_lib / names[0]
    record['llvm'] = dict(rust_objcopy=str(objcopy), library_name=names[0], rpaths=rpaths, rpath_dirs=resolved,
                          expected_library=str(library))
    if loads.returncode != 0:
        fail('otool could not read rust-objcopy load commands')
    if library.is_symlink() or not library.is_file():
        fail('llvm-tools host LLVM library is missing from the toolchain host lib directory', library)
    real = library.resolve(strict=True)
    with real.open('rb') as stream:
        head = stream.read(8)
    if not real.is_relative_to(sysroot.resolve(strict=True)) or head != MACHO_ARM64:
        fail('host LLVM library is not a native arm64 Mach-O inside the toolchain', real)
    first = next((d for d in resolved if os.path.exists(os.path.join(d, names[0]))), None)
    if first is None or not same_path(first, host_lib):
        fail('rust-objcopy RPATH does not resolve its LLVM library to the toolchain host lib directory', first)
    record['llvm'].update(sha256=sha256(real), size=real.stat().st_size)
    version = recorded_run(record, run, [objcopy, '--version'], env=env, cwd=probe, timeout=120)
    if (version.returncode != 0 or 'LLVM version' not in (version.stdout or '')
            or PROBE_WARNING.search(version.stderr or '')):
        fail('rust-objcopy --version did not run cleanly', version.returncode, tail(version.stderr or '', 400))
    # Tiny real release build with strip=symbols: any warning or nonzero exit stops the job here.
    build = recorded_run(record, run, [cargo, 'build', '--manifest-path', project / 'Cargo.toml', '--release', '--offline',
                                       '--target', target], env=env, cwd=project)
    warnings = [line for line in ((build.stdout or '') + '\n' + (build.stderr or '')).splitlines() if PROBE_WARNING.search(line)]
    if build.returncode != 0 or warnings:
        fail('strip=symbols probe build failed or warned', build.returncode, warnings[:5])
    binary = target_dir / target / 'release' / PROBE
    if binary.is_symlink() or not binary.is_file():
        fail('strip probe produced no binary', binary)
    with binary.open('rb') as stream:
        if stream.read(8) != MACHO_ARM64:
            fail('strip probe binary is not a native arm64 Mach-O')
    record['binary'] = dict(path=str(binary), sha256=sha256(binary), size=binary.stat().st_size)
    ran = recorded_run(record, run, [binary], env=env, cwd=probe, timeout=60)
    if ran.returncode != 0 or (ran.stdout or '').strip() != PROBE_OUTPUT:
        fail('strip probe binary did not run natively', ran.returncode)
    symbols = recorded_run(record, run, [NM, binary], env=env, cwd=probe, timeout=60)
    if ((symbols.returncode != 0 and 'no symbols' not in (symbols.stderr or ''))
            or any(m in (symbols.stdout or '') for m in PROBE_MARKERS)):
        fail('strip probe binary still carries local symbols (not stripped)')
    commands = recorded_run(record, run, [OTOOL, '-l', binary], env=env, cwd=probe, timeout=60)
    minos = re.findall(r'^\s*minos\s+(\S+)\s*$', commands.stdout or '', re.M)
    if commands.returncode != 0 or minos not in ([pins['deployment_target']], [pins['deployment_target'] + '.0']):
        fail('strip probe binary minos differs from the deployment target', minos)
    after = source_identity(src, pins, intel)
    if (after['commit'], after['tree']) != (identity['commit'], identity['tree']):
        fail('source identity changed during the strip probe')
    record['source_after'] = dict(commit=after['commit'], tree=after['tree'], clean=after['clean'])


def mode_strip_probe(args, pins):
    strip_probe(src=args.src, work=args.work, out=args.out, pins=pins, cargo=args.cargo, rustc=args.rustc,
                linker=args.linker, sdk=args.sdk, intel=load_intel(args.src, pins), base=os.environ)


def macho_files(bundle):
    rows = {}
    for path in sorted(pathlib.Path(bundle).rglob('*')):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                head = stream.read(8)
            if head[:4] in MACHO_MAGICS:
                rows[path.relative_to(bundle).as_posix()] = head.hex()
    return rows


def mode_audit(args, pins):
    intel, src, work, out = load_intel(args.src, pins), pathlib.Path(args.src), pathlib.Path(args.work), pathlib.Path(args.out)
    cpins = contract_pins(pins, reviewed_pins(pins))
    identity = source_identity(src, pins, intel)
    builder = intel.load_builder(src)
    probe = intel.builder_source_identity(builder, src, 'after build')
    if (probe['commit'], probe['tree']) != (identity['commit'], identity['tree']):
        fail('builder source identity differs from the checkout')
    manifest = json.loads((work / 'rust-package' / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('source_date_epoch') != probe['epoch']:
        fail('package SOURCE_DATE_EPOCH differs from the commit time')
    audit = intel.audit_package(manifest, identity=identity, pins=cpins)
    shutil.copyfile(work / 'rust-package' / 'manifest.json', out / 'macos-arm64-rust-manifest.json')
    name = f"stackbite-{pins['version']}-macos-arm64-{identity['commit'][:12]}"
    archive = work / 'archives' / (name + '.tar.gz')
    (out / 'archives').mkdir()
    shutil.copyfile(archive, out / 'archives' / archive.name)
    bundle = intel.safe_extract(archive, work / 'archives', name)
    intel.verify_bundle(bundle, version=pins['version'], commit=identity['commit'], tree=identity['tree'], target=pins['target'])
    info = json.loads((bundle / 'runtime/build-info.json').read_text(encoding='utf-8'))
    if (info.get('commit'), info.get('version')) != (identity['commit'], pins['version']):
        fail('packaged runtime build-info differs from the checked-out commit')
    machos = macho_files(bundle)
    images = (manifest.get('macos') or {}).get('images') or {}
    wrong = sorted(k for k, v in machos.items() if bytes.fromhex(v) != MACHO_ARM64)
    if wrong or len(machos) != len(pins['bins']) + 1 or set(machos) != set(images):
        fail('bundle Mach-O images are not exactly the audited native arm64 set', wrong[:10], len(machos), len(images))
    for src_name, dst in (('manifest.json', 'macos-arm64-bundle-manifest.json'), ('SHA256SUMS.json', 'macos-arm64-bundle-SHA256SUMS.json'),
                          ('portable.json', 'macos-arm64-bundle-portable.json')):
        shutil.copyfile(bundle / src_name, out / dst)
    (work / 'bundle.path').write_text(str(bundle) + '\n', encoding='utf-8')
    write_json(out / 'audit.json', dict(audit, builder_probe=probe, archive=dict(name=archive.name, sha256=sha256(archive),
                                        size=archive.stat().st_size), bundle=str(bundle), macho_arm64=len(machos),
                                        files=len(json.loads((bundle / 'SHA256SUMS.json').read_text(encoding='utf-8'))),
                                        build_info=info))


def mode_runtime(args, pins):
    intel, out, qa = load_intel(args.src, pins), pathlib.Path(args.out), pathlib.Path(args.qa)
    collect(out, qa)
    audit = json.loads((out / 'audit.json').read_text(encoding='utf-8'))
    doc = json.loads((out / 'macos-arm64-runtime-qa.json').read_text(encoding='utf-8'))
    phases = intel.check_runtime_qualification(doc, driver_sha256=pins['source_files'][RUNTIME_QA],
                                               commit=pins['source']['commit'], version=pins['version'],
                                               archive_sha256=audit['archive']['sha256'], files=audit['files'])
    write_json(out / 'runtime-check.json', dict(driver=RUNTIME_QA, driver_sha256=pins['source_files'][RUNTIME_QA],
                                                 phases=phases, events=len(doc['events'])))


def collect(out, qa):
    """Copy every evidence file that exists; nothing is created for a step that did not run."""
    copied = []
    if not qa or not pathlib.Path(qa).is_dir():
        return copied
    for name, rel in COLLECT:
        source, target = pathlib.Path(qa) / rel, pathlib.Path(out) / name
        if source.is_file() and not source.is_symlink() and not target.exists():
            shutil.copyfile(source, target)
            copied.append(name)
    return copied


def read_steps(out):
    path = pathlib.Path(out) / 'steps.jsonl'
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def mode_end_source(args, pins):
    """End-of-job source identity: still the frozen HEAD/tree and clean after every build/QA step."""
    identity = source_identity(args.src, pins)
    write_json(pathlib.Path(args.out) / 'end-source.json', identity)


def final_document(*, pins, out, steps, job_exit, ci, source_end, copied):
    out = pathlib.Path(out)
    names = [s.get('step') for s in steps]
    missing = [r for r in REQUIRED if not (out / r).is_file()]
    failed = [s for s in steps if s.get('exit') != 0]
    passed = (job_exit == 0 and names == list(STEPS) and not failed and not missing and source_end is not None
              and (source_end['commit'], source_end['tree']) == (pins['source']['commit'], pins['source']['tree']))
    receipts = {p.relative_to(out).as_posix(): sha256(p) for p in sorted(out.rglob('*'))
                if p.is_file() and p.name != 'arm120-final.json'}
    audit = json.loads((out / 'audit.json').read_text(encoding='utf-8')) if (out / 'audit.json').is_file() else {}
    host = json.loads((out / 'host.json').read_text(encoding='utf-8')) if (out / 'host.json').is_file() else None
    return dict(schema=RESULT_SCHEMA, passed=passed, job_exit=job_exit, platform=pins['platform'], target=pins['target'],
                version=pins['version'], product_repository=pins['source']['repository'],
                product_commit=source_end['commit'] if source_end else None,
                product_tree=source_end['tree'] if source_end else None,
                frozen_source=pins['source'], ci_repository=(ci or {}).get('ci_repository'), ci_commit=(ci or {}).get('ci_commit'),
                ci_workflow_ref=(ci or {}).get('workflow_ref'), ci_run_id=(ci or {}).get('run_id'),
                ci_run_attempt=(ci or {}).get('run_attempt'), ci_identity_equals_product=False,
                runner=host, archive=audit.get('archive'), steps=steps, expected_steps=list(STEPS),
                failed_steps=[s.get('step') for s in failed], missing_receipts=missing, collected=copied, receipts=receipts,
                signed=False, published=False, private_key_used=False, secrets_used=False)


def mode_final(args, pins):
    out = pathlib.Path(args.out)
    if not out.is_dir():
        fail('no job output directory')
    copied = collect(out, args.qa)
    ci = json.loads((out / 'ci.json').read_text(encoding='utf-8')) if (out / 'ci.json').is_file() else None
    end = json.loads((out / 'end-source.json').read_text(encoding='utf-8')) if (out / 'end-source.json').is_file() else None
    doc = final_document(pins=pins, out=out, steps=read_steps(out), job_exit=args.job_exit, ci=ci, source_end=end, copied=copied)
    write_json(out / 'arm120-final.json', doc)
    print(json.dumps(dict(passed=doc['passed'], product_commit=doc['product_commit'], ci_commit=doc['ci_commit'],
                          failed_steps=doc['failed_steps'], missing_receipts=doc['missing_receipts']), indent=2))
    if not doc['passed']:
        raise SystemExit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='mode', required=True)
    sub.add_parser('plan').add_argument('--source')
    sub.add_parser('pin').add_argument('key')
    for name in ('ci', 'host'):
        sub.add_parser(name).add_argument('--out', required=True)
    sub.add_parser('source').add_argument('--src', required=True)
    sub.choices['source'].add_argument('--out', required=True)
    probe = sub.add_parser('strip-probe')
    for option in ('--src', '--work', '--out', '--cargo', '--rustc', '--linker', '--sdk'):
        probe.add_argument(option, required=True)
    for name in ('inputs', 'audit', 'runtime', 'end-source', 'final'):
        p = sub.add_parser(name)
        p.add_argument('--src', required=True)
        p.add_argument('--work', required=True)
        p.add_argument('--out', required=True)
        p.add_argument('--qa', default='')
        if name == 'final':
            p.add_argument('--job-exit', type=int, required=True)
    args = parser.parse_args(argv)
    pins = load_pins()
    {'plan': mode_plan, 'pin': mode_pin, 'ci': mode_ci, 'host': mode_host, 'source': mode_source, 'inputs': mode_inputs,
     'strip-probe': mode_strip_probe, 'audit': mode_audit, 'runtime': mode_runtime, 'end-source': mode_end_source, 'final': mode_final}[args.mode](args, pins)


if __name__ == '__main__':
    main()
