"""Native macOS 0.5.123 helper (PLATFORM123, tools/derive123.py): the EXECUTED 0.5.122 helper of H 1dd7e036
(ARM run 43503274148 macos-26, Intel run 43503291973 macos-15-intel, both success) with only the literal
version/baseline/name substitutions listed in derive123.py. Lanes: arm64 macos-26, x86_64 macos-15-intel.
Update baseline = the published, digest-pinned 0.5.122 archive (old122). The 0.5.122 description follows
unchanged; read its 0.5.122/0.5.121 as 0.5.123/0.5.122 and its SB122/mac122 names as SB123/mac123.

Native macOS 0.5.122 helper: standard public GitHub jobs of Shinick-Han/stackbite (arm64 macos-26, x86_64 macos-15-intel).

PLATFORM122 adaptation (tools/derive122.py) of the EXECUTED 0.5.121 helper (R121-PLATFORM-B1-REPAIR
bound-3efd770c-b1, ARM CI f989ee63). What changed for 0.5.122:
* The PRODUCT is the PRIVATE shinick-dev/stackbite at the Root-bound commit R, checked out read-only by the
  workflow's pinned actions/checkout (deploy key only as its ssh-key input, persist-credentials false) into
  $GITHUB_WORKSPACE/.ci-private-source. `credscan` (the reviewed H credential scan) proves no credential
  survived; `ci` accepts exactly that one untracked nested checkout and nothing else.
* Both lanes run in Shinick-Han/stackbite; SB122_PLATFORM (a literal in each workflow) selects
  mac122-pins-<platform>.json, and `ci` requires the running workflow to be that lane's workflow.
* Update baseline = the published, digest-pinned 0.5.121 archive (old121); its unchanged terminal core is
  reused under the same reviewed pins (hash chain kept, never relabelled). source_package_version and the
  first-party license files (rust/PROJECT-NOTICE.txt, LICENSE) are Root-bound pins; a template refuses.
* Raw logs and receipts stay in $RUNNER_TEMP/private-diagnostics (sealed by seal122.sh with CMS for local
  decryption only); `public` writes the upload-safe public-summary.json and the stripped archive.
The 0.5.121 description follows unchanged; read its 0.5.121/0.5.120 as 0.5.122/0.5.121.

Native macOS 0.5.121 helper for one standard public GitHub job per architecture (arm64 macos-15, x86_64 macos-15-intel).

Derived byte-for-byte by derive121.py from the qualified 0.5.120 arm64 helper (distributor
Shinick-Han/stackbite 9fb18829, run 43243456196); every change is listed in derive121.py.
One harness, two lanes: mac122-pins.json names the platform, and with it the exact target,
runner, CI repository and workflow. The PRODUCT is the frozen public source commit R pinned in
mac122-pins.json (bound by Root from runtime-source.json; a template without R refuses), fetched
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

  mac122.py plan [--source DIR]          offline: pins, reviewed pins, drivers, optional committed source pins
  mac122.py pin KEY                      print one pin (dotted key) for the job script
  mac122.py ci --out FILE                GitHub job identity: CI checkout HEAD == GITHUB_SHA, clean, committed bytes
  mac122.py host --out FILE              native Darwin host of the pinned architecture, not translated (no Rosetta)
  mac122.py source --src DIR --out FILE  frozen source identity (HEAD/tree/clean/standalone/pinned files)
  mac122.py inputs --src --work --out    pinned 0.5.120 archive, core reuse + source pins, anchor file
  mac122.py strip-probe --src --work --out --cargo --rustc --linker --sdk
                                         early toolchain gate: llvm-tools host LLVM library, real rust-objcopy,
                                         tiny strip=symbols release build in the builder's own environment
  mac122.py count --label L --list FILE --run FILE --out FILE [--allow-ignored]
                                         discovered-count receipt: the run executed exactly the listed tests
  mac122.py audit --src --work --out     package audit, archive extraction/verification, native Mach-O
  mac122.py runtime --src --work --out --qa Q   copy + check native-runtime-qa qualification.json
  mac122.py final --src --work --out --qa Q --job-exit N   collect existing evidence; never fabricates
"""
import argparse, hashlib, importlib.util, json, os, pathlib, platform, re, shutil, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
PRIVATE_CHECKOUT = '.ci-private-source'
PLATFORM_ENV = 'SB123_PLATFORM'
PUBLIC_SCHEMA = 'stackbite.native123.macos-public-summary.v1'
ARCHIVE_NAME = re.compile(r'stackbite-0\.5\.123-macos-(arm64|x86_64)-[0-9a-f]{12}\.tar\.gz').fullmatch
SCHEMA = 'stackbite.native123.macos-pins.v1'
RESULT_SCHEMA = 'stackbite.native123.macos-result.v1'
HARNESS = 'ci/native123-macos'
VERSION, BASELINE = '0.5.123', '0.5.122'
# One harness, two lanes. Everything lane-specific is fixed here and must equal the pins.
LANES = {
    'macos-arm64': dict(target='aarch64-apple-darwin', runner='macos-26', ci_repository='Shinick-Han/stackbite',
                        workflow='.github/workflows/native-macos-arm64-fallback.yml', machine='arm64',
                        reviewed='mac-reviewed-pins-aarch64.json', macho='cffaedfe0c000001',   # CPU_TYPE_ARM64
                        requirements='requirements-build.txt'),
    'macos-x86_64': dict(target='x86_64-apple-darwin', runner='macos-15-intel', ci_repository='Shinick-Han/stackbite',
                         workflow='.github/workflows/native-macos-intel.yml', machine='x86_64',
                         reviewed='mac-reviewed-pins-x86_64.json', macho='cffaedfe07000001',   # CPU_TYPE_X86_64
                         # cryptography 50.x has no x86_64 macOS wheel: the source's reviewed Intel pin (48.0.1)
                         requirements='ci/native120/requirements-intel-build.txt'),
}
SHARED = ('mac123.py', 'mac123-job.sh', 'seal123.sh', 'diagnostics-recipient.pem', 'drivers/package-native-trust-adapted.py',
          'drivers/connect-native-qa121.py', 'drivers/ordinary-posix121.py')


def published(pins):
    lane = LANES[pins['platform']]
    return (lane['workflow'], *(f'{HARNESS}/{name}' for name in SHARED), f"{HARNESS}/{lane['reviewed']}",
            f"{HARNESS}/mac123-pins-{pins['platform']}.json")


def pins_path(environ=os.environ):
    """The lane pins file named by the workflow's literal SB122_PLATFORM (never a dispatch input)."""
    name = environ.get(PLATFORM_ENV)
    if name not in LANES:
        fail('SB123_PLATFORM names no supported lane', name)
    return HERE / f'mac123-pins-{name}.json'


def macho_magic(pins):
    """MH_MAGIC_64 plus the pinned architecture's CPU type (little-endian)."""
    return bytes.fromhex(LANES[pins['platform']]['macho'])


INTEL = 'ci/native120/intel120.py'
RUNTIME_QA = 'ci/native120/native-runtime-qa.py'
DRIVERS = ('package-native-trust-adapted.py', 'connect-native-qa121.py', 'ordinary-posix121.py')
SOURCE_FILES = (INTEL, RUNTIME_QA, 'scripts/qa/lifecycle_regression.py', 'requirements-build.txt',
                'ci/native120/requirements-intel-build.txt',
                # first-party license metadata (0.5.122+ proprietary; earlier MIT grants and third-party
                # notices unchanged): Root binds the exact reviewed bytes after the final freeze
                'rust/PROJECT-NOTICE.txt', 'LICENSE')
REMOTE_BINS = ('stackbite-remote', 'stackbite-remote-bridge')
MACHO_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')
# The job script runs exactly these steps in this order (tests compare the script to this list).
STEPS = ('ci', 'host', 'credentials', 'source', 'venv', 'anchor', 'inputs', 'toolchain-1.98.1', 'toolchain-1.85.1',
         'llvm-tools-1.98.1', 'strip-probe', 'preflight-0', 'preflight-1', 'tui-lib', 'rust', 'portable', 'audit', 'runtime-qa', 'runtime-check',
         'lifecycle-single', 'lifecycle-update', 'provider-trust', 'connect-native-tests', 'ordinary', 'end-source')
# Evidence files: (copied name in ci-out, '{platform}' = pins platform; source relative to the QA parent).
COLLECT = (('{platform}-runtime-qa.json', 'rq/qualification.json'),
           ('{platform}-runtime-qa-failure.json', 'rq/failure.json'),
           ('{platform}-lifecycle-single.json', 'ls/result.json'),
           ('{platform}-lifecycle-update.json', 'lu/result.json'),
           ('{platform}-ordinary-entry.json', 'rq/ordinary-entry-proof.json'),
           ('{platform}-ordinary-stages.jsonl', 'rq/ordinary-stages.jsonl'))
REQUIRED = ('ci.json', 'host.json', 'source.json', 'inputs.json', 'strip-probe.json', 'preflight-0.json',
            'preflight-1.json', 'tui-lib.json', 'audit.json', '{platform}-rust-manifest.json',
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
    raise Refused('MAC123 REFUSED: ' + ' '.join(map(str, message)))


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


def load_pins(path):
    pins = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    old, core, src = pins.get('old122') or {}, pins.get('core') or {}, pins.get('source') or {}
    rev = pins.get('macos_reviewed_pins_file') or {}
    bins = pins.get('bins') or []
    lane = LANES.get(pins.get('platform'))
    if lane is None:
        fail('mac123 pins name no supported platform', pins.get('platform'))
    if not (HEX40(str(src.get('commit'))) and HEX40(str(src.get('tree')))):
        fail('mac123 pins carry no bound frozen source R: Root must bind runtime-source.json first (no guessed SHA)')
    prefix = 'https://github.com/Shinick-Han/stackbite/releases/download/v0.5.122/'
    ok = (pins.get('schema') == SCHEMA and pins.get('version') == VERSION and pins.get('baseline_version') == BASELINE
          and pins.get('target') == lane['target'] and pins.get('runner') == lane['runner']
          and pins.get('ci_repository') == lane['ci_repository'] and pins.get('workflow') == lane['workflow']
          and src.get('repository') == 'shinick-dev/stackbite' and src.get('visibility') == 'private'
          and src.get('checkout_path') == PRIVATE_CHECKOUT
          and re.fullmatch(r'\d+\.\d+\.\d+', str(pins.get('source_package_version'))) is not None
          and valid_tui_lib(pins.get('tui_lib'))
          and pins.get('toolchain') == '1.98.1' and pins.get('msrv') == '1.85.1' and pins.get('deployment_target') == '13.0'
          and len(bins) == 7 and len(set(bins)) == 7 and bins == sorted(bins) and not any('phone' in b for b in bins)
          and set(REMOTE_BINS) <= set(bins)
          and all(HEX64(str(v)) for v in (old.get('sha256'), core.get('library_sha256'), core.get('manifest_sha256'),
                                          pins.get('update_public_key'), rev.get('sha256')))
          and str(old.get('url', '')).startswith(prefix) and old['url'] == prefix + str(old.get('name'))
          and old.get('name') == f"stackbite-0.5.122-{pins['platform']}-{str(old.get('commit'))[:12]}.tar.gz"
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
        fail('mac123 pins are incomplete or inconsistent')
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
    keys = ('version', 'baseline_version', 'target', 'toolchain', 'msrv', 'deployment_target', 'bins', 'old122', 'core',
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
                                            baseline=pins['source_package_version'])
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
    plan = dict(schema='stackbite.native123.macos-plan.v1', executes=False, network=False,
                ci_repository=pins['ci_repository'], runner=pins['runner'], platform=pins['platform'], workflow=pins['workflow'], source=pins['source'], target=pins['target'],
                version=pins['version'], bins=pins['bins'], drivers=check_drivers(pins),
                reviewed_pins_sha256=pins['macos_reviewed_pins_file']['sha256'], steps=list(STEPS),
                old122=dict((k, pins['old122'][k]) for k in ('name', 'sha256', 'size', 'commit')), published=list(published(pins)),
                contract_keys=sorted(contract_pins(pins, reviewed)))
    if args.source:
        src = pathlib.Path(args.source)
        head = (git(src, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD^{tree}'))
        if head != (pins['source']['commit'], pins['source']['tree']):
            fail('offline source HEAD/tree differ from the frozen pins')
        plan['source_files'] = source_file_pins(src, pins, worktree=False)
        version = json.loads(git(src, 'cat-file', 'blob', 'HEAD:package.json')).get('version')
        if version != pins['source_package_version']:
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
    # Exactly one untracked entry is allowed: the nested private checkout made by the workflow (a separate
    # Git repository, so it is listed as one directory). Anything else is a dirty CI checkout.
    if git(root, 'status', '--porcelain', '--untracked-files=all') not in ('', f'?? {PRIVATE_CHECKOUT}/'):
        fail('CI checkout is not clean')
    if env.get('GITHUB_WORKFLOW_REF', '').split('@')[0] != f"{pins['ci_repository']}/{pins['workflow']}":
        fail('running workflow is not the pinned lane workflow', env.get('GITHUB_WORKFLOW_REF'))
    if pathlib.Path(env.get('GITHUB_WORKSPACE', '')).resolve() != root.resolve():
        fail('harness does not run from the CI workspace checkout')
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
    cpins, old = contract_pins(pins, reviewed_pins(pins)), pins['old122']
    (work / 'old122').mkdir()
    archive = work / 'old122' / old['name']
    intel.download(old['url'], archive, old['size'], old['sha256'])
    bundle = intel.safe_extract(archive, work / 'old122', old['name'].removesuffix('.tar.gz'))
    manifest = intel.verify_bundle(bundle, version=old['version'], commit=old['commit'], tree=old['source_tree'],
                                   target=pins['target'])
    if manifest.get('update_public_key') != pins['update_public_key']:
        fail('0.5.122 update anchor differs from the pinned key')
    core = intel.prepare_core(bundle, work / 'core', cpins)
    core['source_pins'] = intel.core_source_pins(args.src, work / 'core')
    if (work / 'core' / 'libstackbite-terminal-core.dylib').read_bytes()[:8] != macho_magic(pins):
        fail('0.5.122 core library is not a 64-bit Mach-O of the pinned architecture')
    (work / 'inputs').mkdir()
    (work / 'inputs' / 'update-public.pub').write_text(pins['update_public_key'] + '\n', encoding='ascii')
    write_json(out / 'inputs.json', dict(old122=dict(name=old['name'], sha256=sha256(archive), size=archive.stat().st_size,
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
    record = dict(schema='stackbite.native123.macos-strip-probe.v1', ok=False, toolchain=pins['toolchain'],
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
                if p.is_file() and p.name != 'mac123-final.json'}
    audit = json.loads((out / 'audit.json').read_text(encoding='utf-8')) if (out / 'audit.json').is_file() else {}
    host = json.loads((out / 'host.json').read_text(encoding='utf-8')) if (out / 'host.json').is_file() else None
    return dict(schema=RESULT_SCHEMA, passed=passed, job_exit=job_exit, platform=pins['platform'], target=pins['target'],
                version=pins['version'], product_repository=pins['source']['repository'],
                product_commit=source_end['commit'] if source_end else None,
                product_tree=source_end['tree'] if source_end else None,
                frozen_source=pins['source'], ci_repository=(ci or {}).get('ci_repository'), ci_commit=(ci or {}).get('ci_commit'),
                ci_workflow_ref=(ci or {}).get('workflow_ref'), ci_run_id=(ci or {}).get('run_id'),
                ci_run_attempt=(ci or {}).get('run_attempt'), ci_identity_equals_product=(ci or {}).get('ci_commit') == pins['source']['commit'],
                baseline_version=pins['baseline_version'], baseline_archive=pins['old122']['name'], ci_workflow=pins['workflow'],
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
    write_json(out / 'mac123-final.json', doc)
    print(json.dumps(dict(passed=doc['passed'], product_commit=doc['product_commit'], ci_commit=doc['ci_commit'],
                          failed_steps=doc['failed_steps'], missing_receipts=doc['missing_receipts']), indent=2))
    if not doc['passed']:
        raise SystemExit(1)


# Reviewed H b05fc6d0 credential scan (ci/mac-tui/mac-tui-job.sh), unchanged logic: env, Git config scopes,
# remote userinfo and private-key material under the checkout's .git and RUNNER_TEMP (depth 2).
SECRET_ENV = {"GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH",
              "GIT_SSH_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"}
LOCAL_BAD = re.compile(r"(credential\..*|http\.(.*\.)?extraheader|core\.sshcommand|"
                       r"url\..*\.(push)?insteadof|include\.path|includeif\..*)", re.I)
GLOBAL_BAD = re.compile(r"(http\.(.*\.)?extraheader|core\.sshcommand|url\..*\.(push)?insteadof)", re.I)
URL_USERINFO = re.compile(r"[a-z][a-z0-9+.-]*://[^/@]*:[^/@]*@", re.I)
FINDINGS = ("env_credential", "git_local_credential", "git_global_credential",
            "remote_url_credential", "key_material", "credential_check_failed")


def git_config(src, *args):
    r = subprocess.run(["git", "-C", str(src), "config"] + list(args), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if r.returncode not in (0, 1):
        raise RuntimeError("git config failed")
    return r.stdout.decode("utf-8", "replace")


def has_key_material(root, depth, skip):
    try:
        entries = list(os.scandir(root))
    except OSError:
        return False
    for e in entries:
        if os.path.realpath(e.path) in skip:
            continue
        if e.is_file(follow_symlinks=False):
            try:
                with open(e.path, "rb") as f:
                    if b"PRIVATE KEY-----" in f.read(1 << 20):
                        return True
            except OSError:
                pass
        elif depth > 0 and e.is_dir(follow_symlinks=False):
            if has_key_material(e.path, depth - 1, skip):
                return True
    return False


def find_credential(src, temp, skip, environ=os.environ):
    for k in environ:
        u = k.upper()
        if (u in SECRET_ENV or u.startswith("INPUT_") or "SSH_KEY" in u or "SSH-KEY" in u
                or "STACKBITE_SOURCE_READONLY" in u):
            return "env_credential"
    for line in git_config(src, "--list", "--show-scope", "--name-only").splitlines():
        scope, _, name = line.partition("\t")
        if scope in ("local", "worktree", "command"):
            if LOCAL_BAD.fullmatch(name):
                return "git_local_credential"
        elif GLOBAL_BAD.fullmatch(name):
            return "git_global_credential"
    for entry in git_config(src, "--local", "--list", "-z").split("\0"):
        name, _, value = entry.partition("\n")
        low = value.lower()
        if "authorization" in low or "x-access-token" in low:
            return "git_local_credential"
        if name.lower().startswith("remote.") and name.lower().endswith(".url") \
                and URL_USERINFO.match(value):
            return "remote_url_credential"
    skip = {os.path.realpath(p) for p in skip}
    if has_key_material(os.path.join(src, ".git"), 0, skip) or has_key_material(temp, 2, skip):
        return "key_material"
    return None


def mode_credscan(args, pins):
    src = pathlib.Path(args.src)
    if src.is_symlink() or not src.is_dir() or src.name != PRIVATE_CHECKOUT:
        fail('private source checkout missing', str(src))
    try:
        found = find_credential(str(src), os.environ.get('RUNNER_TEMP', ''), args.skip)
    except Exception:
        found = "credential_check_failed"
    if found:
        print(found)
        raise SystemExit(3)
    print("clean")


TUI_LIB_PACKAGE = 'stackbite-terminal-tui'
FILTER_NAME = re.compile(r'[A-Za-z0-9_]{1,128}').fullmatch


def valid_tui_lib(spec):
    """Pinned full-TUI-lib gate: the package, the exact ignored-test count and the 4 named T01 filters."""
    return (isinstance(spec, dict) and set(spec) == {'package', 'expected_ignored', 'required_filters'}
            and spec['package'] == TUI_LIB_PACKAGE and type(spec['expected_ignored']) is int
            and spec['expected_ignored'] >= 0 and isinstance(spec['required_filters'], list)
            and len(spec['required_filters']) == 4 and len(set(spec['required_filters'])) == 4
            and all(isinstance(f, str) and FILTER_NAME(f) for f in spec['required_filters']))


def tui_lib_count(list_text, ignored_text, run_text, spec):
    """The full native --lib run executed every discovered test: each non-ignored listed test ok, each
    ignored listed test ignored (exactly the pinned count), no FAILED line anywhere, and the FINAL parent
    libtest result (nested child summaries may precede it) agrees; every T01 filter is listed and ran ok."""
    listed, ignored = LIST_LINE.findall(list_text), LIST_LINE.findall(ignored_text)
    if not listed or len(listed) != len(set(listed)):
        fail('tui-lib', 'discovery listed no tests or repeated a name', len(listed))
    if len(ignored) != spec['expected_ignored'] or len(ignored) != len(set(ignored)) or not set(ignored) <= set(listed):
        fail('tui-lib', 'ignored discovery differs from the pinned count', dict(ignored=len(ignored),
                                                                             expected=spec['expected_ignored']))
    rows, results = RUN_LINE.findall(run_text), RESULT_LINE.findall(run_text)
    if not results:
        fail('tui-lib', 'no libtest result line')
    status = {}
    for name, state in rows:
        status.setdefault(name, set()).add(state)
    runnable = sorted(set(listed) - set(ignored))
    failed = sorted(n for n, s in rows if s == 'FAILED')
    not_ok = [n for n in runnable if status.get(n) != {'ok'}]
    not_ignored = [n for n in ignored if status.get(n) != {'ignored'}]
    parent = results[-1]
    if (failed or not_ok or not_ignored or parent[0] != 'ok' or int(parent[1]) != len(runnable)
            or parent[2] != '0' or int(parent[3]) != len(ignored)):
        fail('tui-lib', 'full lib run differs from the discovered tests', dict(
            listed=len(listed), runnable=len(runnable), ignored=len(ignored), failed=failed[:5],
            not_ok=not_ok[:5], not_ignored=not_ignored[:5], parent=list(parent)))
    focus = []
    for flt in spec['required_filters']:
        names = [n for n in listed if flt in n]
        ran = [n for n in names if status.get(n) == {'ok'}]
        if not names or ran != names:
            fail('tui-lib', 'T01 filter not listed or not executed ok', flt)
        focus.append(dict(filter=flt, listed=len(names), executed_ok=len(ran)))
    return dict(label='tui-lib', package=spec['package'], discovery='cargo test --lib -- --list [--ignored] --format terse',
                count_basis='final_parent_libtest_result', listed=len(listed), passed=len(runnable),
                ignored=len(ignored), failed=0, ignored_names=sorted(ignored), focus=focus,
                parent_result=dict(passed=int(parent[1]), failed=int(parent[2]), ignored=int(parent[3]),
                                   measured=int(parent[4]), filtered_out=int(parent[5])),
                result_lines=len(results),
                listed_sha256=sha256_bytes('\n'.join(sorted(listed)).encode('utf-8')))


def mode_tui_lib(args, pins):
    texts = [pathlib.Path(p).read_text(encoding='utf-8', errors='replace') for p in (args.list, args.ignored, args.run)]
    doc = tui_lib_count(*texts, pins['tui_lib'])
    doc.update(list_sha256=sha256(args.list), ignored_sha256=sha256(args.ignored), run_sha256=sha256(args.run))
    write_json(args.out, doc)
    print(json.dumps(dict(listed=doc['listed'], passed=doc['passed'], ignored=doc['ignored'])))


def mode_public(args, pins):
    """Upload-safe summary: step enums, identities and the stripped archive only. Raw logs, receipts and
    file listings stay in the private diagnostics (sealed separately). Never claims more than final did."""
    out, pub = pathlib.Path(args.out), pathlib.Path(args.pub)
    final = out / 'mac123-final.json'
    doc = json.loads(final.read_text(encoding='utf-8')) if final.is_file() else {}
    known = set(STEPS)
    steps = [dict(step=s.get('step'), exit=s.get('exit'), seconds=s.get('seconds')) for s in read_steps(out)
             if s.get('step') in known and isinstance(s.get('exit'), int) and isinstance(s.get('seconds'), int)]
    required = {r.format(platform=pins['platform']) for r in REQUIRED}
    archive, uploaded = doc.get('archive') if isinstance(doc.get('archive'), dict) else None, None
    if archive and ARCHIVE_NAME(str(archive.get('name'))) and HEX64(str(archive.get('sha256'))):
        path = out / 'archives' / archive['name']
        if path.is_file() and not path.is_symlink():
            if sha256(path) != archive['sha256'] or path.stat().st_size != archive.get('size'):
                fail('archive differs from the audited archive')
            (pub / 'archives').mkdir(mode=0o700)
            shutil.copyfile(path, pub / 'archives' / archive['name'])
            uploaded = dict(name=archive['name'], sha256=archive['sha256'], size=archive['size'],
                            path='archives/' + archive['name'])
    passed = (doc.get('passed') is True and doc.get('job_exit') == 0 and [s['step'] for s in steps] == list(STEPS)
              and all(s['exit'] == 0 for s in steps) and uploaded is not None)
    summary = dict(schema=PUBLIC_SCHEMA, passed=passed, platform=pins['platform'], target=pins['target'],
                   version=pins['version'], baseline_version=pins['baseline_version'],
                   product_repository=pins['source']['repository'], product_visibility='private',
                   frozen_source=dict(commit=pins['source']['commit'], tree=pins['source']['tree']),
                   product_commit=doc.get('product_commit'), product_tree=doc.get('product_tree'),
                   ci_repository=doc.get('ci_repository'), ci_commit=doc.get('ci_commit'),
                   ci_workflow=pins['workflow'], ci_run_id=doc.get('ci_run_id'), ci_run_attempt=doc.get('ci_run_attempt'),
                   ci_identity_equals_product=doc.get('ci_identity_equals_product'),
                   job_exit=doc.get('job_exit'), final_present=final.is_file(),
                   final_sha256=sha256(final) if final.is_file() else None,
                   steps=steps, expected_steps=list(STEPS),
                   failed_steps=[s['step'] for s in steps if s['exit'] != 0],
                   missing_receipts=sorted(r for r in (doc.get('missing_receipts') or []) if r in required),
                   archive=uploaded, private_diagnostics='seal123.sh: private-diagnostics.cms + diagnostics-envelope.json',
                   signed=False, published=False, secrets_in_summary=False)
    write_json(pub / 'public-summary.json', summary)
    print(json.dumps(dict(passed=passed, platform=pins['platform'], failed_steps=summary['failed_steps'],
                          missing_receipts=summary['missing_receipts']), indent=2))


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
    scan = sub.add_parser('credscan')
    scan.add_argument('--src', required=True)
    scan.add_argument('--skip', action='append', default=[])
    public = sub.add_parser('public')
    public.add_argument('--out', required=True)
    public.add_argument('--pub', required=True)
    tui = sub.add_parser('tui-lib')
    for option in ('--list', '--ignored', '--run', '--out'):
        tui.add_argument(option, required=True)
    args = parser.parse_args(argv)
    pins = load_pins(pins_path())
    {'plan': mode_plan, 'pin': mode_pin, 'ci': mode_ci, 'host': mode_host, 'source': mode_source, 'inputs': mode_inputs,
     'strip-probe': mode_strip_probe, 'count': mode_count, 'audit': mode_audit, 'runtime': mode_runtime, 'end-source': mode_end_source, 'final': mode_final,
     'credscan': mode_credscan, 'public': mode_public, 'tui-lib': mode_tui_lib}[args.mode](args, pins)


if __name__ == '__main__':
    main()
