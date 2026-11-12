#!/bin/bash
# Native macOS arm64 0.5.120 fallback job body (one standard public GitHub macos-15 runner).
# Hosted in the distributor; builds the FROZEN public source commit from arm120-pins.json,
# fetched credential-free into $RUNNER_TEMP/s120 (outside every checkout). The builder reads
# that checkout's actual Git HEAD itself; nothing here sets a build identity. Unsigned.
# Every log/receipt goes to $RUNNER_TEMP/ci-out; on any exit, arm120.py final collects
# what exists (failed step logs included) and writes arm120-final.json. Never fabricates.
set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0 LANG=en_US.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASE_PY="$(command -v python)"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
OUT="$RUNNER_TEMP/ci-out"
W="$RUNNER_TEMP/w"
SRC="$RUNNER_TEMP/s120"
VENV="$RUNNER_TEMP/sb120-build-venv"
PY="$VENV/bin/python"
Q=""
helper() { "$BASE_PY" -I -B "$D/arm120.py" "$@"; }        # stdlib only: before the venv exists and in the EXIT trap
vhelper() { "$PY" -I -B "$D/arm120.py" "$@"; }             # the build venv: modes that load the source builder

test ! -e "$OUT" && test ! -e "$W" && test ! -e "$SRC" && test ! -e "$VENV"
mkdir -m 700 "$OUT" "$W"

finish() {
  code=$?
  set +e
  helper final --src "$SRC" --work "$W" --out "$OUT" --qa "$Q" --job-exit "$code" > "$OUT/final.log" 2>&1
  final=$?
  cat "$OUT/final.log"
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
    tail -n 120 "$OUT/$name.log" >&2 || true
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
OLD_TOP="$(helper pin old119.name)"; OLD_TOP="${OLD_TOP%.tar.gz}"
BINS=()
for b in $(helper pin bins); do BINS+=(--bin "$b"); done

step ci helper ci --out "$OUT/ci.json"
step host helper host --out "$OUT/host.json"

fetch_source() {
  git init -q "$SRC"
  git -C "$SRC" -c credential.helper= -c protocol.version=2 fetch --no-tags --depth=1 \
    "https://github.com/$SOURCE_REPO.git" "$SOURCE_COMMIT"
  git -C "$SRC" -c advice.detachedHead=false checkout -q --detach "$SOURCE_COMMIT"
  git -C "$SRC" rev-parse HEAD 'HEAD^{tree}'
}
step source-fetch fetch_source
step source helper source --src "$SRC" --out "$OUT/source.json"

# The source's own pinned requirements-build.txt (digest checked by `source`), one runner-local venv
# of the same setup-python arm64 interpreter; that venv runs every builder and QA step.
make_venv() {
  "$BASE_PY" -m venv "$VENV"
  "$PY" -m pip --isolated --no-cache-dir install --disable-pip-version-check --no-input --only-binary=:all: \
    -r "$SRC/requirements-build.txt"
  "$PY" -m pip --isolated --no-cache-dir check
  "$PY" -I -B -c 'import platform, sys; assert sys.prefix != sys.base_prefix and platform.machine() == "arm64", sys.executable; print(sys.executable, platform.machine())'
}
step venv make_venv

check_anchor() {
  SB120_KEY="$(helper pin update_public_key)" SB120_SCRIPTS="$SRC/scripts" "$PY" -B - <<'PY'
import importlib.metadata, os, pathlib, re, sys
pins = [re.fullmatch(r'([A-Za-z0-9_.-]+)==(\S+)', line.strip())
        for line in (pathlib.Path(os.environ['SB120_SCRIPTS']).parent / 'requirements-build.txt').read_text(encoding='utf-8').splitlines()
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
Q="$(mktemp -d /private/tmp/q120-XXXXXXXX)"
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
export RUSTUP_AUTO_INSTALL=0
cd "$SRC"

preflight() {
  RUSTC="$C/rustc" CARGO_TARGET_DIR="$W/preflight-target" "$C/cargo" test --manifest-path rust/Cargo.toml --locked \
    -p "$(helper pin "preflights.$1.package")" --lib "$(helper pin "preflights.$1.filter")" -- --test-threads=1 \
    | tee "$W/preflight-$1.out"
  grep -qF -- "$(helper pin "preflights.$1.expect")" "$W/preflight-$1.out"
}
step preflight-0 preflight 0
step preflight-1 preflight 1

step rust "$PY" scripts/build_rust_terminal.py --source "$SRC" --version "$VERSION" --toolchain "$TC" --target "$TARGET" \
  --cargo "$C/cargo" --rustc "$C/rustc" --msrv-cargo "$M/cargo" --msrv-rustc "$M/rustc" --lane-mode sequential \
  --cache-dir "$W/rust-cache" --output "$W/rust-package" --core-directory "$W/core" \
  --project-license "$SRC/rust/PROJECT-NOTICE.txt" --linker "$CLANG" --macos-sdk "$SDK" \
  --macos-deployment-target "$MINOS" --macos-reviewed-pins "$D/mac-reviewed-pins-aarch64.json" \
  --update-public-key "$W/inputs/update-public.pub" "${BINS[@]}"
step portable "$PY" scripts/build_macos_release.py --rust-package "$W/rust-package" --version "$VERSION" --target "$TARGET" \
  --deployment-target "$MINOS" --commit "$SOURCE_COMMIT" --output "$W/archives" \
  --update-public-key "$W/inputs/update-public.pub" --await-signature
step audit vhelper audit --src "$SRC" --work "$W" --out "$OUT"
BUNDLE="$(cat "$W/bundle.path")"

# Stateful QA: short private roots under $Q (/private/tmp/q120-XXXXXXXX, mode 700), each new.
step runtime-qa "$PY" -B "$SRC/ci/native120/native-runtime-qa.py" "$BUNDLE" "$SRC" "$Q/rq"
step runtime-check vhelper runtime --src "$SRC" --work "$W" --out "$OUT" --qa "$Q"
step lifecycle-single "$PY" -B "$SRC/scripts/qa/lifecycle_regression.py" --bundle "$BUNDLE" --qa-root "$Q/ls" \
  --expect-commit "$SOURCE_COMMIT" --expect-version "$VERSION"
step lifecycle-update "$PY" -B "$SRC/scripts/qa/lifecycle_regression.py" --bundle "$BUNDLE" --qa-root "$Q/lu" \
  --expect-commit "$SOURCE_COMMIT" --expect-version "$VERSION" --old-bundle "$W/old119/$OLD_TOP"
step provider-trust "$PY" -B "$D/drivers/package-native-trust-adapted.py" --source "$SRC" --package "$BUNDLE" \
  --cargo "$C/cargo" --rustc "$C/rustc" --target-dir "$W/rust-cache" --receipt "$OUT/macos-arm64-provider-trust.json"
step connect-native-tests "$PY" -B "$D/drivers/connect-native-qa.py" --source "$SRC" --package "$BUNDLE" \
  --cache "$W/rust-cache" --cargo "$C/cargo" --rustc "$C/rustc" --receipt "$OUT/macos-arm64-connect-native-tests.json"
step ordinary "$PY" -B "$D/drivers/ordinary-posix.py" "$Q/rq"
step end-source vhelper end-source --src "$SRC" --work "$W" --out "$OUT"
