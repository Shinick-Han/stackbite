#!/bin/bash
# RUNTIME-DIAGNOSTICS CANDIDATE: exact H2 de40d1ca ci/native122-macos/mac122-job.sh (blob 68268502) + only the
# capture_qa_diagnostics call in finish(); every step, flag (--test-threads=1) and helper is unchanged.
# Native macOS 0.5.122 job body (PLATFORM122, tools/derive122.py) derived from the EXECUTED 0.5.121 job
# (R121-PLATFORM-B1-REPAIR bound-3efd770c-b1, ARM CI f989ee63). Both lanes run in Shinick-Han/stackbite;
# the workflow's literal SB122_PLATFORM picks mac122-pins-<platform>.json. The PRODUCT is the PRIVATE
# shinick-dev/stackbite commit R, already checked out read-only by the workflow into
# $GITHUB_WORKSPACE/.ci-private-source (this script never fetches and never sees a key). Raw logs and
# receipts go to $RUNNER_TEMP/private-diagnostics/ci-out, NEVER to public stdout or the upload; on any exit
# mac122.py final collects what exists and mac122.py public writes $RUNNER_TEMP/public-summary (enums,
# identities, stripped archive). seal122.sh then encrypts the private diagnostics for local decryption.
# Unsigned. Never fabricates. Test counts are discovered on this runner, never constants.
set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0 LANG=en_US.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASE_PY="$(command -v python)"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
PRIV="$RUNNER_TEMP/private-diagnostics"
PUB="$RUNNER_TEMP/public-summary"
OUT="$PRIV/ci-out"
W="$RUNNER_TEMP/w"
SRC="$GITHUB_WORKSPACE/.ci-private-source"
VENV="$RUNNER_TEMP/sb122-build-venv"
PY="$VENV/bin/python"
Q=""
helper() { "$BASE_PY" -I -B "$D/mac122.py" "$@"; }        # stdlib only: before the venv exists and in the EXIT trap
vhelper() { "$PY" -I -B "$D/mac122.py" "$@"; }             # the build venv: modes that load the source builder

test ! -e "$PRIV" && test ! -e "$PUB" && test ! -e "$W" && test ! -e "$VENV"
test -d "$SRC" && test ! -L "$SRC"
mkdir -m 700 "$PRIV" "$PUB" "$OUT" "$W"

# Bounded private QA command-log capture (runtime diagnostics): BEFORE helper final inventories ci-out, copy the
# QA helpers' own per-command logs (scripts/qa/lifecycle_regression.py Layout.logs = <qa-root>/logs/NNN-<label>
# [.stderr].private.log, used by ci/native120/native-runtime-qa.py for $Q/rq and by the lifecycle steps for
# $Q/ls and $Q/lu) and their result JSON into ci-out as qa-<lane>-<name>. Only regular, non-symlink, single-link
# direct children of an exact $Q/<lane>/logs under the job's own /private/tmp/q122-XXXXXXXX root; <= 4 MiB each,
# <= 32 MiB total; files 0600; nothing else under $Q (profile/state/auth) is read. Output stays in ci-out (CMS
# sealed allowlist), never stdout or the public upload. A capture error never changes a failing exit; it fails
# closed (exit 97) only a job that was otherwise passing.
capture_qa_diagnostics() {
  "$BASE_PY" -I -B - "$Q" "$OUT" "$1" '/private/tmp/q122-' > /dev/null 2>> "$OUT/qa-diagnostics.private.log" <<'PYCAP'
import hashlib, json, os, re, stat, sys
q, out, job_exit, prefix = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
LANES = ('rq', 'ls', 'lu')
JSONS = ('qualification.json', 'failure.json', 'result.json')
LOG = re.compile(r'[0-9]{3}-[A-Za-z0-9._-]{1,80}\.private\.log').fullmatch
EACH, TOTAL = 4 << 20, 32 << 20
SECRET_ENV = ('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_CACHE_URL')
secrets = [os.environ[k].encode() for k in SECRET_ENV if len(os.environ.get(k, '')) >= 8]
record = dict(schema='stackbite.platform122.qa-diagnostics-capture.v1', job_exit=job_exit, qa_root_present=bool(q),
              bounds=dict(each_bytes=EACH, total_bytes=TOTAL), copied=[], missing=[], errors=[], ignored=0)
total = 0
def err(lane, name, reason):
    record['errors'].append(dict(lane=lane, name=name, reason=reason))
def read_bounded(path):
    st0 = os.lstat(path)   # type-check before any open: a FIFO/device/socket is never opened
    if stat.S_ISLNK(st0.st_mode): return None, 'symlink'
    if not stat.S_ISREG(st0.st_mode): return None, 'not_regular'
    if st0.st_nlink != 1: return None, 'hard_linked'
    if st0.st_size > EACH: return None, 'oversize'
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        st = os.fstat(fd)
        if (st.st_dev, st.st_ino) != (st0.st_dev, st0.st_ino): return None, 'changed'
        if not stat.S_ISREG(st.st_mode): return None, 'not_regular'
        if st.st_nlink != 1: return None, 'hard_linked'
        if st.st_size > EACH: return None, 'oversize'
        data = b''
        while len(data) <= EACH:
            chunk = os.read(fd, EACH + 1 - len(data))
            if not chunk: break
            data += chunk
        return (None, 'oversize') if len(data) > EACH else (data, None)
    finally:
        os.close(fd)
def copy(lane, path, name):
    global total
    target = os.path.join(out, f'qa-{lane}-{name}')
    try:
        if os.path.lexists(target): return err(lane, name, 'target_exists')
        data, why = read_bounded(path)
        if why: return err(lane, name, why)
        if total + len(data) > TOTAL: return err(lane, name, 'total_bound')
        if any(s in data for s in secrets): return err(lane, name, 'credential_value')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(data)
        os.chmod(target, 0o600)
        total += len(data)
        record['copied'].append(dict(lane=lane, source=f'{lane}/{os.path.relpath(path, os.path.join(q, lane))}'.replace(os.sep, '/'),
                                     name=f'qa-{lane}-{name}', bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    except OSError as e:
        err(lane, name, f'os_error:{e.errno}')
def real_dir(path):
    return os.path.isdir(path) and not os.path.islink(path)
if not q:
    record['missing'].append('qa_root')
elif not (re.fullmatch(re.escape(prefix) + r'[A-Za-z0-9]{8}', q) and real_dir(q) and os.path.realpath(q) == q
          and os.path.realpath(os.path.dirname(q)) == os.path.dirname(q)):
    err('-', '-', 'unsafe_qa_root')
else:
    for lane in LANES:
        root = os.path.join(q, lane)
        if not os.path.lexists(root):
            record['missing'].append(lane); continue
        if not real_dir(root):
            err(lane, '-', 'lane_not_real_dir'); continue
        for name in JSONS:
            p = os.path.join(root, name)
            if os.path.lexists(p): copy(lane, p, name)
        logs = os.path.join(root, 'logs')
        if not os.path.lexists(logs):
            record['missing'].append(lane + '/logs'); continue
        if not real_dir(logs):
            err(lane, 'logs', 'logs_not_real_dir'); continue
        for name in sorted(os.listdir(logs)):   # only NNN-label.private.log is selected; any other name is ignored (counted, never read)
            if LOG(name): copy(lane, os.path.join(logs, name), name)
            else: record['ignored'] += 1
if job_exit == 0 and record['missing']:
    for m in record['missing']: err(m, '-', 'missing_on_pass')
record['total_bytes'] = total
fd = os.open(os.path.join(out, 'qa-diagnostics-capture.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f: json.dump(record, f, indent=2, sort_keys=True); f.write('\n')
sys.exit(1 if record['errors'] else 0)
PYCAP
}

finish() {
  code=$?
  set +e
  capture_qa_diagnostics "$code"
  capture=$?
  if [ "$code" = 0 ] && [ "$capture" != 0 ]; then code=97; fi
  helper final --src "$SRC" --work "$W" --out "$OUT" --qa "$Q" --job-exit "$code" > "$OUT/final.log" 2>&1
  final=$?
  # Public stdout: only the enum summary printed by `public`; final.log stays private.
  helper public --out "$OUT" --pub "$PUB" 2>> "$OUT/final.log"
  public=$?
  if [ "$final" = 0 ]; then final=$public; fi
  if [ "$code" = 0 ]; then code=$final; fi
  exit "$code"
}
trap finish EXIT

step() {
  local name="$1" started=$SECONDS code=0
  shift
  printf 'Starting %s\n' "$name"
  # A plain subshell (not inside ||/&&/if) keeps errexit effective inside step functions.
  set +e
  ( set -euo pipefail; "$@" ) > "$OUT/$name.log" 2>&1
  code=$?
  set -e
  printf '{"step":"%s","exit":%d,"seconds":%d}\n' "$name" "$code" "$((SECONDS - started))" >> "$OUT/steps.jsonl"
  printf 'Finished %s: exit %d in %ds\n' "$name" "$code" "$((SECONDS - started))"
  if [ "$code" != 0 ]; then
    printf 'stage=%s status=fail log=sealed-private-diagnostics\n' "$name" >&2
    exit "$code"
  fi
}

SOURCE_REPO="$(helper pin source.repository)"
SOURCE_COMMIT="$(helper pin source.commit)"
VERSION="$(helper pin version)"
TARGET="$(helper pin target)"
TC="$(helper pin toolchain)"
MS="$(helper pin msrv)"
MINOS="$(helper pin deployment_target)"
OLD_TOP="$(helper pin old121.name)"; OLD_TOP="${OLD_TOP%.tar.gz}"
PLATFORM="$(helper pin platform)"
REVIEWED="$D/$(helper pin macos_reviewed_pins_file.path)"
REQUIREMENTS="$(helper pin build_requirements)"
BINS=()
for b in $(helper pin bins); do BINS+=(--bin "$b"); done

step ci helper ci --out "$OUT/ci.json"
step host helper host --out "$OUT/host.json"

# The private checkout made by the workflow: no credential may survive (env, Git config, remote URL, keys).
step credentials helper credscan --src "$SRC" --skip "$PRIV" --skip "$PUB" --skip "$W"
unset SSH_AUTH_SOCK SSH_AGENT_PID GIT_ASKPASS SSH_ASKPASS
step source helper source --src "$SRC" --out "$OUT/source.json"

# The source's own pinned lane requirements (requirements-build.txt on arm64, the reviewed
# ci/native120/requirements-intel-build.txt on x86_64; digests checked by `source`), one runner-local
# venv of the native setup-python interpreter; that venv runs every builder and QA step.
make_venv() {
  "$BASE_PY" -m venv "$VENV"
  "$PY" -m pip --isolated --no-cache-dir install --disable-pip-version-check --no-input --only-binary=:all: \
    -r "$SRC/$REQUIREMENTS"
  "$PY" -m pip --isolated --no-cache-dir check
  "$PY" -I -B -c 'import platform, sys; assert sys.prefix != sys.base_prefix and platform.machine() == sys.argv[1], sys.executable; print(sys.executable, platform.machine())' "$(uname -m)"
}
step venv make_venv

# The installed pins must equal the same lane requirements file make_venv installed ($SRC/$REQUIREMENTS).
check_anchor() {
  SB120_KEY="$(helper pin update_public_key)" SB120_SCRIPTS="$SRC/scripts" SB121_REQUIREMENTS="$SRC/$REQUIREMENTS" \
    "$PY" -B - <<'PY'
import importlib.metadata, os, pathlib, re, sys
pins = [re.fullmatch(r'([A-Za-z0-9_.-]+)==(\S+)', line.strip())
        for line in pathlib.Path(os.environ['SB121_REQUIREMENTS']).read_text(encoding='utf-8').splitlines()
        if line.strip() and not line.lstrip().startswith('#')]
if not pins or not all(pins):
    sys.exit('the build requirements must hold exact name==version pins')
for pin in pins:
    if importlib.metadata.version(pin[1]) != pin[2]:
        sys.exit(f'{pin[1]} is not the pinned {pin[2]}')
sys.path.insert(0, os.environ['SB120_SCRIPTS'])
import build_release
anchor = pathlib.Path(os.environ['RUNNER_TEMP']) / 'sb120-anchor-check.pub'
anchor.write_text(os.environ['SB120_KEY'] + '\n', encoding='ascii')
if build_release.read_update_public_key(anchor) != os.environ['SB120_KEY']:
    sys.exit('the pinned update public key does not validate')
print('build dependencies and public update anchor validated:', sys.executable)
PY
}
step anchor check_anchor
step inputs vhelper inputs --src "$SRC" --work "$W" --out "$OUT"

# Private build environment: no runner HOME/cargo/rustup state is read or written.
RUSTUP="$(command -v rustup)"
RUSTUP_BIN="$(dirname "$RUSTUP")"
Q="$(mktemp -d /private/tmp/q122-XXXXXXXX)"
chmod 700 "$Q"
mkdir -m 700 "$W/home" "$W/state" "$Q/t"
export HOME="$W/home" TMPDIR="$Q/t" CARGO_HOME="$W/cargo" RUSTUP_HOME="$W/rustup" CARGO_INCREMENTAL=0 \
  CARGO_BUILD_JOBS=3 STACKBITE_UPDATE_CHECK=0 STACKBITE_STATE_DIR="$W/state"
export PATH="$VENV/bin:$RUSTUP_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
CLANG="$(xcrun --find clang)"
export SDKROOT="$SDK" MACOSX_DEPLOYMENT_TARGET="$MINOS"
C="$RUSTUP_HOME/toolchains/$TC-$TARGET/bin"
M="$RUSTUP_HOME/toolchains/$MS-$TARGET/bin"
step "toolchain-$TC" rustup toolchain install "$TC" --profile minimal
step "toolchain-$MS" rustup toolchain install "$MS" --profile minimal
# The minimal $TC profile's rust-objcopy loads LLVM via an RPATH into the host lib directory, which only the
# official llvm-tools component provides (rust-lang/rust#164063, fix rust-lang/rust#164134). strip-probe then
# checks that library path itself and runs rust-objcopy plus a tiny strip=symbols release build in the
# builder's own environment, failing here, before any expensive build, on a missing library or any warning.
step "llvm-tools-$TC" rustup component add --toolchain "$TC" llvm-tools
export RUSTUP_AUTO_INSTALL=0
cd "$SRC"
step strip-probe vhelper strip-probe --src "$SRC" --work "$W" --out "$OUT" --cargo "$C/cargo" --rustc "$C/rustc" \
  --linker "$CLANG" --sdk "$SDK"

# Real-count discovery: list exactly what the filter selects on this runner, then run it and require
# that the run executed that same set (no copied 0.5.120 count constant).
preflight() {
  local pkg filter
  pkg="$(helper pin "preflights.$1.package")"
  filter="$(helper pin "preflights.$1.filter")"
  RUSTC="$C/rustc" CARGO_TARGET_DIR="$W/preflight-target" "$C/cargo" test --manifest-path rust/Cargo.toml --locked \
    -p "$pkg" --lib "$filter" -- --list --format terse > "$W/preflight-$1.list"
  RUSTC="$C/rustc" CARGO_TARGET_DIR="$W/preflight-target" "$C/cargo" test --manifest-path rust/Cargo.toml --locked \
    -p "$pkg" --lib "$filter" -- --test-threads=1 | tee "$W/preflight-$1.out"
  helper count --label "preflight-$1" --list "$W/preflight-$1.list" --run "$W/preflight-$1.out" \
    --out "$OUT/preflight-$1.json" --allow-ignored
}
step preflight-0 preflight 0
macos_process_preflight() {
  preflight 1
  # Source-reviewed R3 native host regression, discovered and executed on this unprivileged Mac.
  local T=(env RUSTC="$C/rustc" CARGO_TARGET_DIR="$W/preflight-target" "$C/cargo" test
    --manifest-path rust/Cargo.toml --locked -p stackbite-launcher --lib native_lifecycle::host::tests)
  "${T[@]}" -- --list --format terse > "$W/macos-process-host.list"
  grep -F 'darwin_table_keeps_this_process_and_its_root_owned_ancestors: test' "$W/macos-process-host.list" > /dev/null
  "${T[@]}" -- --test-threads=1 | tee "$W/macos-process-host.out"
  helper count --label macos-process-host --list "$W/macos-process-host.list" --run "$W/macos-process-host.out" --out "$OUT/macos-process-host.json"
  "$BASE_PY" -I -B - "$OUT/macos-process-api.json" <<'PYHOST'
import ctypes as c, errno, json, os, pathlib, struct, sys
assert os.geteuid() != 0, 'unprivileged native proof required'
p=c.CDLL(None, use_errno=True)
p.proc_pidinfo.argtypes=[c.c_int,c.c_int,c.c_uint64,c.c_void_p,c.c_int]; p.proc_pidinfo.restype=c.c_int
b=c.create_string_buffer(4096); c.set_errno(0)
n=p.proc_pidinfo(1,3,0,b,len(b)); pe=c.get_errno()
k=c.CDLL(None,use_errno=True)
k.sysctl.argtypes=[c.POINTER(c.c_int),c.c_uint,c.c_void_p,c.POINTER(c.c_size_t),c.c_void_p,c.c_size_t]; k.sysctl.restype=c.c_int
mib=(c.c_int*4)(1,14,1,1); raw=c.create_string_buffer(648); size=c.c_size_t(648)
c.set_errno(0); rc=k.sysctl(mib,4,raw,c.byref(size),None,0); se=c.get_errno()
assert rc==0 and size.value==648, (rc,se,size.value)
pid=struct.unpack_from('=i',raw.raw,40)[0]; parent=struct.unpack_from('=i',raw.raw,560)[0]
assert (pid,parent)==(1,0), (pid,parent)
r=dict(schema='stackbite.native122.macos-process-api.v1',unprivileged=True,pid1_tbsdinfo_bytes=n,pid1_tbsdinfo_errno=errno.errorcode.get(pe,str(pe)),pid1_sysctl_bytes=size.value,pid1_parent=parent)
pathlib.Path(sys.argv[1]).write_text(json.dumps(r,sort_keys=True)+'\n')
PYHOST
}
step preflight-1 macos_process_preflight

# Full native stackbite-terminal-tui --lib (closes T01). Same toolchain, RUSTC and preflight-target as the
# preflights, so the shared debug test graph is not compiled twice; the release lanes build separately.
# Discovery lists all and ignored tests; the default selection runs once (ignored stay skipped and are
# counted against the pin); raw output stays in the sealed step log.
tui_lib() {
  local pkg
  pkg="$(helper pin tui_lib.package)"
  local T=(env RUSTC="$C/rustc" CARGO_TARGET_DIR="$W/preflight-target" "$C/cargo" test
    --manifest-path rust/Cargo.toml --locked -p "$pkg" --lib)
  "${T[@]}" -- --list --format terse < /dev/null > "$W/tui-lib.list"
  "${T[@]}" -- --list --ignored --format terse < /dev/null > "$W/tui-lib.ignored"
  "${T[@]}" -- --test-threads=1 < /dev/null | tee "$W/tui-lib.out"
  helper tui-lib --list "$W/tui-lib.list" --ignored "$W/tui-lib.ignored" --run "$W/tui-lib.out" \
    --out "$OUT/tui-lib.json"
}
step tui-lib tui_lib

step rust "$PY" scripts/build_rust_terminal.py --source "$SRC" --version "$VERSION" --toolchain "$TC" --target "$TARGET" \
  --cargo "$C/cargo" --rustc "$C/rustc" --msrv-cargo "$M/cargo" --msrv-rustc "$M/rustc" --lane-mode sequential \
  --cache-dir "$W/rust-cache" --output "$W/rust-package" --core-directory "$W/core" \
  --project-license "$SRC/rust/PROJECT-NOTICE.txt" --linker "$CLANG" --macos-sdk "$SDK" \
  --macos-deployment-target "$MINOS" --macos-reviewed-pins "$REVIEWED" \
  --update-public-key "$W/inputs/update-public.pub" "${BINS[@]}"
step portable "$PY" scripts/build_macos_release.py --rust-package "$W/rust-package" --version "$VERSION" --target "$TARGET" \
  --deployment-target "$MINOS" --commit "$SOURCE_COMMIT" --output "$W/archives" \
  --update-public-key "$W/inputs/update-public.pub" --await-signature
step audit vhelper audit --src "$SRC" --work "$W" --out "$OUT"
BUNDLE="$(cat "$W/bundle.path")"

# Stateful QA: short private roots under $Q (/private/tmp/q122-XXXXXXXX, mode 700), each new.
step runtime-qa "$PY" -B "$SRC/ci/native120/native-runtime-qa.py" "$BUNDLE" "$SRC" "$Q/rq"
step runtime-check vhelper runtime --src "$SRC" --work "$W" --out "$OUT" --qa "$Q"
step lifecycle-single "$PY" -B "$SRC/scripts/qa/lifecycle_regression.py" --bundle "$BUNDLE" --qa-root "$Q/ls" \
  --expect-commit "$SOURCE_COMMIT" --expect-version "$VERSION"
step lifecycle-update "$PY" -B "$SRC/scripts/qa/lifecycle_regression.py" --bundle "$BUNDLE" --qa-root "$Q/lu" \
  --expect-commit "$SOURCE_COMMIT" --expect-version "$VERSION" --old-bundle "$W/old121/$OLD_TOP"
step provider-trust "$PY" -B "$D/drivers/package-native-trust-adapted.py" --source "$SRC" --package "$BUNDLE" \
  --cargo "$C/cargo" --rustc "$C/rustc" --target-dir "$W/rust-cache" --receipt "$OUT/$PLATFORM-provider-trust.json"
step connect-native-tests "$PY" -B "$D/drivers/connect-native-qa121.py" --source "$SRC" --package "$BUNDLE" \
  --cache "$W/rust-cache" --cargo "$C/cargo" --rustc "$C/rustc" --receipt "$OUT/$PLATFORM-connect-native-tests.json"
step ordinary "$PY" -B "$D/drivers/ordinary-posix121.py" "$Q/rq"
step end-source vhelper end-source --src "$SRC" --work "$W" --out "$OUT"
