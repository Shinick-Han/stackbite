"""Native macOS 0.5.121 helper for one standard public GitHub job per architecture (arm64 macos-15, x86_64 macos-15-intel).

Derived byte-for-byte by derive121.py from the qualified 0.5.120 arm64 helper (distributor
Shinick-Han/stackbite 9fb18829, run 43243456196); every change is listed in derive121.py.
One harness, two lanes: mac121-pins.json names the platform, and with it the exact target,
runner, CI repository and workflow. The PRODUCT is the frozen public source commit R pinned in
mac121-pins.json (bound by Root from runtime-source.json; a template without R refuses), fetched
credential-free into its own checkout. The identities differ and both are recorded: ci_* (the
CI repository GITHUB_SHA H, workflow, run) and product/source_* (the checkout's actual Git
HEAD/tree, which the unmodified builder reads itself). H is never claimed as R, and no 0.5.120
binary is relabelled 0.5.121: the published 0.5.120 archive is only the update baseline and the
source of the unchanged, separately reviewed terminal core and its license files.

The verification contract is the reviewed Intel driver of the SAME frozen source
(ci/native120/intel120.py of R, digest-pinned), imported by path and called unchanged with pins
of the same shape: package audit (exact seven bins, no phone, two equal reproducible lanes, MSRV,
toolchain, anchor, Mach-O minos 13.0.0, unsigned), bundle verification, safe extraction, core
reuse + native source pins, pinned download and the runtime qualification check. Its
x86_64-only `load_pins`/`host_check`/`run_ci` are not used; nothing is monkeypatched.

Test counts are discovered, never copied: each preflight and connect group first lists the
tests its exact cargo filter selects on this runner (`-- --list --format terse`) and then must
run exactly that set (every listed test ok or reported ignored, none failed, at least one).

  mac121.py plan [--source DIR]          offline: pins, reviewed pins, drivers, optional committed source pins
  mac121.py pin KEY                      print one pin (dotted key) for the job script
  mac121.py ci --out FILE                GitHub job identity: CI checkout HEAD == GITHUB_SHA, clean, committed bytes
  mac121.py host --out FILE              native Darwin host of the pinned architecture, not translated (no Rosetta)
  mac121.py source --src DIR --out FILE  frozen source identity (HEAD/tree/clean/standalone/pinned files)
  mac121.py inputs --src --work --out    pinned 0.5.120 archive, core reuse + source pins, anchor file
  mac121.py strip-probe --src --work --out --cargo --rustc --linker --sdk
                                         early toolchain gate: llvm-tools host LLVM library, real rust-objcopy,
                                         tiny strip=symbols release build in the builder's own environment
  mac121.py count --label L --list FILE --run FILE --out FILE [--allow-ignored]
                                         discovered-count receipt: the run executed exactly the listed tests
  mac121.py audit --src --work --out     package audit, archive extraction/verification, native Mach-O
  mac121.py runtime --src --work --out --qa Q   copy + check native-runtime-qa qualification.json
  mac121.py final --src --work --out --qa Q --job-exit N   collect existing evidence; never fabricates
"""
import argparse, hashlib, importlib.util, json, os, pathlib, platform, re, shutil, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
PINS = HERE / 'mac121-pins.json'
SCHEMA = 'stackbite.native121.macos-pins.v1'
RESULT_SCHEMA = 'stackbite.native121.macos-result.v1'
HARNESS = 'ci/native121-macos'
VERSION, BASELINE = '0.5.121', '0.5.120'
# One harness, two lanes. Everything lane-specific is fixed here and must equal the pins.
LANES = {
    'macos-arm64': dict(target='aarch64-apple-darwin', runner='macos-15', ci_repository='Shinick-Han/stackbite',
                        workflow='.github/workflows/native-macos-arm64-fallback.yml', machine='arm64',
                        reviewed='mac-reviewed-pins-aarch64.json', macho='cffaedfe0c000001',   # CPU_TYPE_ARM64
                        requirements='requirements-build.txt'),
    'macos-x86_64': dict(target='x86_64-apple-darwin', runner='macos-15-intel', ci_repository='shinick-dev/stackbite',
                         workflow='.github/workflows/native-macos-intel.yml', machine='x86_64',
                         reviewed='mac-reviewed-pins-x86_64.json', macho='cffaedfe07000001',   # CPU_TYPE_X86_64
                         # cryptography 50.x has no x86_64 macOS wheel: the source's reviewed Intel pin (48.0.1)
                         requirements='ci/native120/requirements-intel-build.txt'),
}
SHARED = ('mac121.py', 'mac121-job.sh', 'mac121-pins.json', 'drivers/package-native-trust-adapted.py',
          'drivers/connect-native-qa121.py', 'drivers/ordinary-posix121.py')


def published(pins):
    lane = LANES[pins['platform']]
    return (lane['workflow'], *(f'{HARNESS}/{name}' for name in SHARED), f"{HARNESS}/{lane['reviewed']}")


def macho_magic(pins):
    """MH_MAGIC_64 plus the pinned architecture's CPU type (little-endian)."""
    return bytes.fromhex(LANES[pins['platform']]['macho'])


INTEL = 'ci/native120/intel120.py'
RUNTIME_QA = 'ci/native120/native-runtime-qa.py'
DRIVERS = ('package-native-trust-adapted.py', 'connect-native-qa121.py', 'ordinary-posix121.py')
SOURCE_FILES = (INTEL, RUNTIME_QA, 'scripts/qa/lifecycle_regression.py', 'requirements-build.txt',
                'ci/native120/requirements-intel-build.txt')
REMOTE_BINS = ('stackbite-remote', 'stackbite-remote-bridge')
MACHO_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')
# The job script runs exactly these steps in this order (tests compare the script to this list).
STEPS = ('ci', 'host', 'source-fetch', 'source', 'venv', 'anchor', 'inputs', 'toolchain-1.98.1', 'toolchain-1.85.1',
         'llvm-tools-1.98.1', 'strip-probe', 'preflight-0', 'preflight-1', 'rust', 'portable', 'audit', 'runtime-qa', 'runtime-check',
         'lifecycle-single', 'lifecycle-update', 'provider-trust', 'connect-native-tests', 'ordinary', 'end-source')
# Evidence files: (copied name in ci-out, '{platform}' = pins platform; source relative to the QA parent).
COLLECT = (('{platform}-runtime-qa.json', 'rq/qualification.json'),
           ('{platform}-runtime-qa-failure.json', 'rq/failure.json'),
           ('{platform}-lifecycle-single.json', 'ls/result.json'),
           ('{platform}-lifecycle-update.json', 'lu/result.json'),
           ('{platform}-ordinary-entry.json', 'rq/ordinary-entry-proof.json'),
           ('{platform}-ordinary-stages.jsonl', 'rq/ordinary-stages.jsonl'))
REQUIRED = ('ci.json', 'host.json', 'source.json', 'inputs.json', 'strip-probe.json', 'preflight-0.json',
            'preflight-1.json', 'audit.json', '{platform}-rust-manifest.json',
            '{platform}-bundle-manifest.json', '{platform}-runtime-qa.json', 'runtime-check.json',
            '{platform}-lifecycle-single.json', '{platform}-lifecycle-update.json',
            '{platform}-provider-trust.json', '{platform}-provider-trust.test-adapter.json',
            '{platform}-connect-native-tests.json', '{platform}-ordinary-entry.json', 'end-source.json')
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
    raise Refused('MAC121 REFUSED: ' + ' '.join(map(str, message)))


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
    old, core, src = pins.get('old120') or {}, pins.get('core') or {}, pins.get('source') or {}
    rev = pins.get('macos_reviewed_pins_file') or {}
    bins = pins.get('bins') or []
    lane = LANES.get(pins.get('platform'))
    if lane is None:
        fail('mac121 pins name no supported platform', pins.get('platform'))
    if not (HEX40(str(src.get('commit'))) and HEX40(str(src.get('tree')))):
        fail('mac121 pins carry no bound frozen source R: Root must bind runtime-source.json first (no guessed SHA)')
    prefix = 'https://github.com/Shinick-Han/stackbite/releases/download/v0.5.120/'
    ok = (pins.get('schema') == SCHEMA and pins.get('version') == VERSION and pins.get('baseline_version') == BASELINE
          and pins.get('target') == lane['target'] and pins.get('runner') == lane['runner']
          and pins.get('ci_repository') == lane['ci_repository'] and pins.get('workflow') == lane['workflow']
          and src.get('repository') == 'shinick-dev/stackbite'
          and pins.get('toolchain') == '1.98.1' and pins.get('msrv') == '1.85.1' and pins.get('deployment_target') == '13.0'
          and len(bins) == 7 and len(set(bins)) == 7 and bins == sorted(bins) and not any('phone' in b for b in bins)
          and set(REMOTE_BINS) <= set(bins)
          and all(HEX64(str(v)) for v in (old.get('sha256'), core.get('library_sha256'), core.get('manifest_sha256'),
                                          pins.get('update_public_key'), rev.get('sha256')))
          and str(old.get('url', '')).startswith(prefix) and old['url'] == prefix + str(old.get('name'))
          and old.get('name') == f"stackbite-0.5.120-{pins['platform']}-{str(old.get('commit'))[:12]}.tar.gz"
          and isinstance(old.get('size'), int) and 0 < old['size'] <= 64 * 1024 * 1024
          and old.get('version') == BASELINE and HEX40(str(old.get('commit'))) and HEX40(str(old.get('source_tree')))
          and old['commit'] != src['commit']
          and core.get('directory') == 'private_pty/_native/terminal-core'
          and set(pins.get('drivers') or {}) == set(DRIVERS) and all(HEX64(str(v)) for v in pins['drivers'].values())
          and set(pins.get('source_files') or {}) == set(SOURCE_FILES) and all(HEX64(str(v)) for v in pins['source_files'].values())
          and isinstance(pins.get('preflights'), list) and len(pins['preflights']) == 2
          and all(set(p) == {'package', 'filter'} and all(isinstance(v, str) and v and "'" not in v for v in p.values())
                  for p in pins['preflights'])
          and rev.get('path') == lane['reviewed'] and pins.get('build_requirements') == lane['requirements'])
    if not ok:
        fail('mac121 pins are incomplete or inconsistent')
    return pins


def reviewed_pins(pins, here=HERE):
    data = (pathlib.Path(here) / pins['macos_reviewed_pins_file']['path']).read_bytes()
    if sha256_bytes(data) != pins['macos_reviewed_pins_file']['sha256']:
        fail('reviewed macOS pins file differs from its pin')
    doc = json.loads(data)
    if (doc.get('schema') != 'stackbite-macos-reviewed-pins-v1' or doc.get('target') != pins['target']
            or (doc.get('core') or {}).get('sha256') != pins['core']['library_sha256']
            or (doc.get('core') or {}).get('library') != 'libstackbite-terminal-core.dylib'):
        fail('reviewed macOS pins do not describe the pinned core')
    return doc


def contract_pins(pins, reviewed):
    """The lane pins in exactly the dict shape the Intel driver functions read."""
    keys = ('version', 'baseline_version', 'target', 'toolchain', 'msrv', 'deployment_target', 'bins', 'old120', 'core',
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
                 'core_source_pins', 'check_runtime_qualification', 'download', 'load_builder', 'builder_source_identity',
                 'llvm_tools_canonical'):
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
    plan = dict(schema='stackbite.native121.macos-plan.v1', executes=False, network=False,
                ci_repository=pins['ci_repository'], runner=pins['runner'], platform=pins['platform'], workflow=pins['workflow'], source=pins['source'], target=pins['target'],
                version=pins['version'], bins=pins['bins'], drivers=check_drivers(pins),
                reviewed_pins_sha256=pins['macos_reviewed_pins_file']['sha256'], steps=list(STEPS),
                old120=dict((k, pins['old120'][k]) for k in ('name', 'sha256', 'size', 'commit')), published=list(published(pins)),
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
        fail('job is not hosted in the pinned CI repository', env.get('GITHUB_REPOSITORY'))
    root = HERE.parent.parent
    head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
    if head != env.get('GITHUB_SHA'):
        fail('CI checkout HEAD differs from GITHUB_SHA')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        fail('CI checkout is not clean')
    files = {}
    for rel in published(pins):
        blob = sha256_bytes(git(root, 'cat-file', 'blob', 'HEAD:' + rel, binary=True))
        if blob != sha256(root / rel):
            fail('CI harness file differs from its committed blob', rel)
        files[rel] = blob
    check_drivers(pins)
    reviewed_pins(pins)
    write_json(args.out, dict(ci_repository=env['GITHUB_REPOSITORY'], ci_commit=head, ci_tree=git(root, 'rev-parse', 'HEAD^{tree}'),
                              workflow_ref=env.get('GITHUB_WORKFLOW_REF'), workflow_sha=env.get('GITHUB_WORKFLOW_SHA'),
                              run_id=env.get('GITHUB_RUN_ID'), run_attempt=env.get('GITHUB_RUN_ATTEMPT'),
                              event=env.get('GITHUB_EVENT_NAME'), ref=env.get('GITHUB_REF'), files=files))


def host_record(run=subprocess.run, system=platform.system, machine=platform.machine, pins=None):
    lane = LANES[(pins or load_pins())['platform']]
    if system() != 'Darwin' or machine() != lane['machine']:
        fail('needs a native', lane['machine'], 'macOS runner', system(), machine())
    sysctl = lambda key: run(['/usr/sbin/sysctl', '-n', key], capture_output=True, text=True).stdout.strip()
    translated, arm64 = sysctl('sysctl.proc_translated'), sysctl('hw.optional.arm64')
    # Rosetta: an x86_64 process on Apple silicon reports proc_translated 1 and hw.optional.arm64 1,
    # so the x86_64 lane also requires real Intel hardware (hw.optional.arm64 absent or 0).
    native = arm64 == '1' if lane['machine'] == 'arm64' else arm64 in ('0', '')
    if translated not in ('0', '') or not native:
        fail('translated or foreign-architecture process', translated, arm64)
    return dict(system='Darwin', machine=lane['machine'], translated=False, hw_optional_arm64=arm64 == '1',
                mac_ver=platform.mac_ver()[0], python=sys.version.split()[0], python_machine=machine(),
                runner_os=os.environ.get('RUNNER_OS'), runner_arch=os.environ.get('RUNNER_ARCH'),
                image_os=os.environ.get('ImageOS'), image_version=os.environ.get('ImageVersion'))


def mode_host(args, pins):
    write_json(args.out, host_record(pins=pins))


def mode_source(args, pins):
    intel = load_intel(args.src, pins)
    identity = source_identity(args.src, pins, intel)
    identity['source_files'] = source_file_pins(args.src, pins)
    write_json(args.out, identity)


def mode_inputs(args, pins):
    intel, work, out = load_intel(args.src, pins), pathlib.Path(args.work), pathlib.Path(args.out)
    cpins, old = contract_pins(pins, reviewed_pins(pins)), pins['old120']
    (work / 'old120').mkdir()
    archive = work / 'old120' / old['name']
    intel.download(old['url'], archive, old['size'], old['sha256'])
    bundle = intel.safe_extract(archive, work / 'old120', old['name'].removesuffix('.tar.gz'))
    manifest = intel.verify_bundle(bundle, version=old['version'], commit=old['commit'], tree=old['source_tree'],
                                   target=pins['target'])
    if manifest.get('update_public_key') != pins['update_public_key']:
        fail('0.5.120 update anchor differs from the pinned key')
    core = intel.prepare_core(bundle, work / 'core', cpins)
    core['source_pins'] = intel.core_source_pins(args.src, work / 'core')
    if (work / 'core' / 'libstackbite-terminal-core.dylib').read_bytes()[:8] != macho_magic(pins):
        fail('0.5.120 core library is not a 64-bit Mach-O of the pinned architecture')
    (work / 'inputs').mkdir()
    (work / 'inputs' / 'update-public.pub').write_text(pins['update_public_key'] + '\n', encoding='ascii')
    write_json(out / 'inputs.json', dict(old120=dict(name=old['name'], sha256=sha256(archive), size=archive.stat().st_size,
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
    record = dict(schema='stackbite.native121.macos-strip-probe.v1', ok=False, toolchain=pins['toolchain'],
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


def host_llvm_library(record, library, *, sysroot, target, pins, intel):
    """The host LLVM library rust-objcopy loads, resolved; refuses unless it is a native Mach-O inside the toolchain.

    A link -> real file is accepted exactly as the 0.5.120 Intel llvm_tools_layout guard accepts it: the target
    resolves inside the toolchain, is a file, and the link and the target are both files of the installed official
    llvm-tools component (its rustup manifest; component name from R's intel120.llvm_tools_canonical).
    """
    library, sysroot = pathlib.Path(library), pathlib.Path(sysroot)
    if not (library.exists() or library.is_symlink()):
        fail('llvm-tools host LLVM library is missing from the toolchain host lib directory', library)
    root = sysroot.resolve(strict=True)
    real = library.resolve()
    if not real.is_relative_to(root) or not real.is_file():
        fail('the host LLVM library does not resolve to a toolchain file', real)
    if library.is_symlink():
        rustlib = root / 'lib' / 'rustlib'
        name = f'{intel.llvm_tools_canonical(rustlib, target)}-{target}'
        components = (rustlib / 'components').read_text(encoding='utf-8').split() if (rustlib / 'components').is_file() else []
        if name not in components:
            fail('the official llvm-tools component is not installed in the toolchain', name)
        manifest = rustlib / f'manifest-{name}'
        entries = set(manifest.read_text(encoding='utf-8').splitlines()) if manifest.is_file() else set()
        link, file = library.relative_to(sysroot).as_posix(), real.relative_to(root).as_posix()
        if 'file:' + link not in entries or 'file:' + file not in entries:
            fail('the host LLVM library is not a file of the official llvm-tools component', link)
        record['llvm'].update(link=link, link_file=file, component=name)
    with real.open('rb') as stream:
        head = stream.read(8)
    if head != macho_magic(pins):
        fail('host LLVM library is not a native Mach-O of the pinned architecture inside the toolchain', real)
    return real


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
    real = host_llvm_library(record, library, sysroot=sysroot, target=target, pins=pins, intel=intel)
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
        if stream.read(8) != macho_magic(pins):
            fail('strip probe binary is not a native Mach-O of the pinned architecture')
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


LIST_LINE = re.compile(r'^(\S+): test$', re.M)
RUN_LINE = re.compile(r'^test (\S+) \.\.\. (ok|FAILED|ignored)(?:, .*)?$', re.M)
RESULT_LINE = re.compile(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; '
                         r'(\d+) filtered out', re.M)


def discovered_count(list_text, run_text, *, label, allow_ignored=True):
    """Exactly the tests the filter lists ran: each listed test is ok (or ignored), none failed, none extra."""
    listed = LIST_LINE.findall(list_text)
    if not listed or len(listed) != len(set(listed)):
        fail(label, 'discovery listed no tests or repeated a name', len(listed))
    rows = RUN_LINE.findall(run_text)
    results = RESULT_LINE.findall(run_text)
    names = [n for n, _ in rows]
    ok = sorted(n for n, s in rows if s == 'ok')
    ignored = sorted(n for n, s in rows if s == 'ignored')
    failed = sorted(n for n, s in rows if s == 'FAILED')
    passed = sum(int(r[1]) for r in results)
    if (failed or len(names) != len(set(names)) or set(names) != set(listed) or not ok
            or any(r[0] != 'ok' or r[2] != '0' for r in results) or passed != len(ok)
            or sum(int(r[3]) for r in results) != len(ignored) or (ignored and not allow_ignored)):
        fail(label, 'run differs from the discovered tests', dict(listed=len(listed), ok=len(ok), ignored=len(ignored),
                                                                failed=failed[:5], extra=sorted(set(names) - set(listed))[:5],
                                                                missing=sorted(set(listed) - set(names))[:5]))
    return dict(label=label, discovery='cargo test -- --list --format terse', listed=len(listed), passed=len(ok),
                ignored=len(ignored), failed=0, ignored_names=ignored,
                listed_sha256=sha256_bytes('\n'.join(sorted(listed)).encode('utf-8')))


def mode_count(args, pins):
    doc = discovered_count(pathlib.Path(args.list).read_text(encoding='utf-8', errors='replace'),
                           pathlib.Path(args.run).read_text(encoding='utf-8', errors='replace'),
                           label=args.label, allow_ignored=args.allow_ignored)
    doc.update(list_sha256=sha256(args.list), run_sha256=sha256(args.run))
    write_json(args.out, doc)
    print(json.dumps(doc))


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
    shutil.copyfile(work / 'rust-package' / 'manifest.json', out / f"{pins['platform']}-rust-manifest.json")
    name = f"stackbite-{pins['version']}-{pins['platform']}-{identity['commit'][:12]}"
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
    wrong = sorted(k for k, v in machos.items() if bytes.fromhex(v) != macho_magic(pins))
    if wrong or len(machos) != len(pins['bins']) + 1 or set(machos) != set(images):
        fail('bundle Mach-O images are not exactly the audited native set', wrong[:10], len(machos), len(images))
    for src_name, dst in (('manifest.json', '{platform}-bundle-manifest.json'), ('SHA256SUMS.json', '{platform}-bundle-SHA256SUMS.json'),
                          ('portable.json', '{platform}-bundle-portable.json')):
        shutil.copyfile(bundle / src_name, out / dst.format(platform=pins['platform']))
    (work / 'bundle.path').write_text(str(bundle) + '\n', encoding='utf-8')
    write_json(out / 'audit.json', dict(audit, builder_probe=probe, archive=dict(name=archive.name, sha256=sha256(archive),
                                        size=archive.stat().st_size), bundle=str(bundle), macho_native=len(machos),
                                        files=len(json.loads((bundle / 'SHA256SUMS.json').read_text(encoding='utf-8'))),
                                        build_info=info))


def mode_runtime(args, pins):
    intel, out, qa = load_intel(args.src, pins), pathlib.Path(args.out), pathlib.Path(args.qa)
    collect(out, qa, pins['platform'])
    audit = json.loads((out / 'audit.json').read_text(encoding='utf-8'))
    doc = json.loads((out / f"{pins['platform']}-runtime-qa.json").read_text(encoding='utf-8'))
    phases = intel.check_runtime_qualification(doc, driver_sha256=pins['source_files'][RUNTIME_QA],
                                               commit=pins['source']['commit'], version=pins['version'],
                                               archive_sha256=audit['archive']['sha256'], files=audit['files'])
    write_json(out / 'runtime-check.json', dict(driver=RUNTIME_QA, driver_sha256=pins['source_files'][RUNTIME_QA],
                                                 phases=phases, events=len(doc['events'])))


def collect(out, qa, platform_name):
    """Copy every evidence file that exists; nothing is created for a step that did not run."""
    copied = []
    if not qa or not pathlib.Path(qa).is_dir():
        return copied
    for name, rel in COLLECT:
        name = name.format(platform=platform_name)
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
    missing = [r for r in (n.format(platform=pins['platform']) for n in REQUIRED) if not (out / r).is_file()]
    failed = [s for s in steps if s.get('exit') != 0]
    passed = (job_exit == 0 and names == list(STEPS) and not failed and not missing and source_end is not None
              and (source_end['commit'], source_end['tree']) == (pins['source']['commit'], pins['source']['tree']))
    receipts = {p.relative_to(out).as_posix(): sha256(p) for p in sorted(out.rglob('*'))
                if p.is_file() and p.name != 'mac121-final.json'}
    audit = json.loads((out / 'audit.json').read_text(encoding='utf-8')) if (out / 'audit.json').is_file() else {}
    host = json.loads((out / 'host.json').read_text(encoding='utf-8')) if (out / 'host.json').is_file() else None
    return dict(schema=RESULT_SCHEMA, passed=passed, job_exit=job_exit, platform=pins['platform'], target=pins['target'],
                version=pins['version'], product_repository=pins['source']['repository'],
                product_commit=source_end['commit'] if source_end else None,
                product_tree=source_end['tree'] if source_end else None,
                frozen_source=pins['source'], ci_repository=(ci or {}).get('ci_repository'), ci_commit=(ci or {}).get('ci_commit'),
                ci_workflow_ref=(ci or {}).get('workflow_ref'), ci_run_id=(ci or {}).get('run_id'),
                ci_run_attempt=(ci or {}).get('run_attempt'), ci_identity_equals_product=(ci or {}).get('ci_commit') == pins['source']['commit'],
                baseline_version=pins['baseline_version'], baseline_archive=pins['old120']['name'], ci_workflow=pins['workflow'],
                runner=host, archive=audit.get('archive'), steps=steps, expected_steps=list(STEPS),
                failed_steps=[s.get('step') for s in failed], missing_receipts=missing, collected=copied, receipts=receipts,
                signed=False, published=False, private_key_used=False, secrets_used=False)


def mode_final(args, pins):
    out = pathlib.Path(args.out)
    if not out.is_dir():
        fail('no job output directory')
    copied = collect(out, args.qa, pins['platform'])
    ci = json.loads((out / 'ci.json').read_text(encoding='utf-8')) if (out / 'ci.json').is_file() else None
    end = json.loads((out / 'end-source.json').read_text(encoding='utf-8')) if (out / 'end-source.json').is_file() else None
    doc = final_document(pins=pins, out=out, steps=read_steps(out), job_exit=args.job_exit, ci=ci, source_end=end, copied=copied)
    write_json(out / 'mac121-final.json', doc)
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
    count = sub.add_parser('count')
    for option in ('--label', '--list', '--run', '--out'):
        count.add_argument(option, required=True)
    count.add_argument('--allow-ignored', action='store_true')
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
     'strip-probe': mode_strip_probe, 'count': mode_count, 'audit': mode_audit, 'runtime': mode_runtime, 'end-source': mode_end_source, 'final': mode_final}[args.mode](args, pins)


if __name__ == '__main__':
    main()
