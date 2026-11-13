#!/bin/bash
# ci/mac-tui/mac-tui-job.sh -- native macOS (ARM or Intel) stackbite-terminal-tui --lib on the PRIVATE source.
# Modes:
#   pins      validate ci/mac-tui/mac-tui-pins.json and write commit=R to $GITHUB_OUTPUT (no secret).
#   run       use the already checked-out $GITHUB_WORKSPACE/.ci-private-source (this script never
#             fetches); refuse unless HEAD == R and no Git credential is left, then run cargo.
#   finalize  always: guarantee $RUNNER_TEMP/public-summary/summary.json (coarse reason only).
# Raw rustup/cargo/list/filter logs stay in $RUNNER_TEMP/private-diagnostics; they are never printed
# or uploaded. Public stdout carries only stage/reason enums and the whitelisted summary.
# bash 3.2 compatible; Python 3 standard library only. Never sets a build identity.
set -u -o pipefail
umask 077
export GIT_TERMINAL_PROMPT=0 LANG=en_US.UTF-8

D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PIN_FILE="${STACKBITE_MAC_TUI_PINS_FILE:-mac-tui-pins.json}"
case "$PIN_FILE" in mac-tui-pins.json|mac-tui-pins-intel.json) ;; *) echo "stage=pins status=fail reason=pins_invalid"; exit 2;; esac
PINS="$D/$PIN_FILE"
EXPECTED_REPO="shinick-dev/stackbite"
CHECKOUT_DIR=".ci-private-source"
NFILTERS=4

IFS= read -r -d '' PYHELP <<'PY' || true
import json, os, re, subprocess, sys

PINS_SCHEMA = "stability122.mac-private-tui.pins.v1"
SUMMARY_SCHEMA = "stability122.mac-private-tui.public-summary.v1"
HEX40 = r"[0-9a-f]{40}"
RESULT = re.compile(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; "
                    r"(\d+) measured; (\d+) filtered out")
STAGES = ("setup", "pins", "private_checkout", "job", "host", "source", "credentials",
          "toolchain", "discovery", "focus", "full_lib", "done")
REASONS = ("none", "output_dir_exists", "setup_failed", "pins_invalid", "pin_step_failed",
           "private_checkout_failed", "job_not_completed", "host_not_arm64", "host_not_x86_64", "host_not_macos",
           "source_missing", "source_sha_mismatch", "source_layout", "source_dirty",
           "credential_config_present", "toolchain_install_failed", "build_failed",
           "discovery_empty", "focus_not_listed", "focus_failed", "focus_zero",
           "full_lib_failed", "full_lib_zero")
FINDINGS = ("env_credential", "git_local_credential", "git_global_credential",
            "remote_url_credential", "key_material", "credential_check_failed")
SECRET_ENV = {"GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH",
              "GIT_SSH_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"}
LOCAL_BAD = re.compile(r"(credential\..*|http\.(.*\.)?extraheader|core\.sshcommand|"
                       r"url\..*\.(push)?insteadof|include\.path|includeif\..*)", re.I)
GLOBAL_BAD = re.compile(r"(http\.(.*\.)?extraheader|core\.sshcommand|url\..*\.(push)?insteadof)", re.I)
URL_USERINFO = re.compile(r"[a-z][a-z0-9+.-]*://[^/@]*:[^/@]*@", re.I)


def full(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def load_pins(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pins_check(path, repo, checkout_dir, nfilters):
    d = load_pins(path)
    s = d.get("source", {})
    fl = d.get("required_filters")
    n = int(nfilters)
    ok = (d.get("schema") == PINS_SCHEMA and s.get("repository") == repo
          and s.get("visibility") == "private" and s.get("checkout_path") == checkout_dir
          and full(HEX40, s.get("commit")) and full(r"\d+\.\d+\.\d+", d.get("toolchain"))
          and full(r"[a-z0-9-]{1,64}", d.get("package")) and d.get("expected_machine") in ("arm64", "x86_64")
          and full(r"\d{1,3}", d.get("support_floor_macos")) and isinstance(fl, list)
          and len(fl) == n and len(set(fl)) == n
          and all(full(r"[A-Za-z0-9_]{1,128}", f) for f in fl))
    if not ok:
        sys.exit(2)
    print(s["commit"])


def pin(path, key):
    d = load_pins(path)
    for k in key.split("."):
        d = d[k]
    print(d if isinstance(d, str) else "\n".join(d))


def result_counts(path):
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = bad = 0
    s = [0, 0, 0, 0, 0]
    with f:
        for line in f:
            m = RESULT.match(line.rstrip("\r\n"))
            if m:
                lines += 1
                bad += m.group(1) != "ok"
                for i in range(5):
                    s[i] += int(m.group(i + 2))
    return [lines, bad] + s


def results(path):
    c = result_counts(path) or [0, 0, 0, 0, 0, 0, 0]
    print(" ".join(str(x) for x in c))


def listed_count(path, flt=None):
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    n = 0
    with f:
        for line in f:
            line = line.rstrip("\r\n")
            if line.endswith(": test") and (flt is None or flt in line[:-6]):
                n += 1
    return n


def listed(path, flt=None):
    n = listed_count(path, flt)
    if n is None:
        sys.exit(1)
    print(n)


def git_config(src, *args):
    r = subprocess.run(["git", "-C", src, "config"] + list(args), stdin=subprocess.DEVNULL,
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


def find_credential(src, temp, skip):
    for k in os.environ:
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


def credscan(src, temp, *skip):
    try:
        found = find_credential(src, temp, skip)
    except Exception:
        found = "credential_check_failed"
    if found:
        print(found)
        sys.exit(3)
    print("clean")


def read_state(path):
    st = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                k, sep, v = line.rstrip("\r\n").partition("=")
                if sep:
                    st[k] = v
    except OSError:
        pass
    return st


def counts_obj(path):
    c = result_counts(path)
    if c is None:
        return None
    keys = ("result_lines", "failed_result_lines", "passed", "failed", "ignored", "measured",
            "filtered_out")
    return dict(zip(keys, c))


def summary(pins_path, state_path, priv, pub):
    st = read_state(state_path)
    pick = lambda k, p: st.get(k) if full(p, st.get(k)) else None
    num = lambda k: int(st[k]) if full(r"\d{1,9}", st.get(k)) else None
    try:
        p = load_pins(pins_path)
        filters = [f for f in p["required_filters"] if full(r"[A-Za-z0-9_]{1,128}", f)]
        repo = p["source"]["repository"] if full(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
                                                 p["source"]["repository"]) else None
    except Exception:
        filters, repo = [], None
    stage = st.get("stage") if st.get("stage") in STAGES else "setup"
    reason = st.get("reason") if st.get("reason") in REASONS else "job_not_completed"
    rc = int(st["rc"]) if full(r"-?\d{1,4}", st.get("rc")) else None
    status = "pass" if (st.get("status") == "pass" and stage == "done" and reason == "none"
                        and rc == 0) else "fail"
    if status == "fail" and reason == "none":
        reason = "job_not_completed"
    machine = pick("machine", r"[a-z0-9_]{1,16}")
    env = os.environ
    focus = []
    for i, name in enumerate(filters, 1):
        focus.append({"filter": name, "listed": num("focus_listed_%d" % i),
                      "result": counts_obj(os.path.join(priv, "focus-%d.log" % i))})
    out = {
        "schema": SUMMARY_SCHEMA,
        "status": status,
        "stage": stage,
        "reason": reason,
        "credential_finding": st.get("credential_finding")
        if st.get("credential_finding") in FINDINGS else None,
        "exit_code": rc,
        "harness_commit": env.get("GITHUB_SHA") if full(HEX40, env.get("GITHUB_SHA")) else None,
        "run_id": env.get("GITHUB_RUN_ID") if full(r"\d{1,20}", env.get("GITHUB_RUN_ID")) else None,
        "host": {
            "machine": machine,
            "runner_arch": env.get("RUNNER_ARCH") if full(r"[A-Z0-9]{1,8}", env.get("RUNNER_ARCH"))
            else None,
            "macos": pick("macos", r"\d{1,3}(\.\d{1,3}){0,2}"),
            "macos_build": pick("macos_build", r"[0-9A-Za-z]{1,16}"),
            "support_floor_macos": pick("support_floor", r"\d{1,3}"),
        },
        "source": {
            "repository": repo,
            "visibility": "private",
            "pinned_commit": pick("commit", HEX40),
            "head_matches_pin": {"yes": True, "no": False}.get(st.get("head_match")),
            "tree": pick("tree", HEX40),
        },
        "toolchain": pick("toolchain", r"\d+\.\d+\.\d+"),
        "package": pick("package", r"[a-z0-9-]{1,64}"),
        "discovery": {"listed": listed_count(os.path.join(priv, "list.txt")),
                      "listed_ignored": listed_count(os.path.join(priv, "ignored.txt"))},
        "focus": focus,
        "full_lib": counts_obj(os.path.join(priv, "full-lib.log")),
        "claims": {"native_arm64_tui_lib": status == "pass" and machine == "arm64",
                   "native_intel_tui_lib": status == "pass" and machine == "x86_64",
                   "macos_13": False, "intel": status == "pass" and machine == "x86_64",
                   "release_qualification": False},
        "private_diagnostics": "kept_on_runner_not_uploaded",
    }
    os.makedirs(pub, mode=0o700, exist_ok=True)
    tmp = os.path.join(pub, ".summary.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, os.path.join(pub, "summary.json"))


CMDS = {"pins-check": pins_check, "pin": pin, "results": results, "listed": listed,
        "credscan": credscan, "summary": summary}
CMDS[sys.argv[1]](*sys.argv[2:])
PY

py() { python3 -I -c "$PYHELP" "$@"; }

mode_pins() {
  : "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  local commit
  if commit="$(py pins-check "$PINS" "$EXPECTED_REPO" "$CHECKOUT_DIR" "$NFILTERS" 2>/dev/null)"; then
    printf 'commit=%s\n' "$commit" >> "$GITHUB_OUTPUT"
    echo "stage=pins status=ok commit=$commit"
  else
    echo "stage=pins status=fail reason=pins_invalid"
    exit 2
  fi
}

st() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r\n')" >> "$STATE"; }

enter() { STAGE="$1"; st stage "$STAGE"; echo "stage=$STAGE"; }

fail() { REASON="$1"; echo "stage=$STAGE status=fail reason=$REASON"; exit 1; }

write_summary() {
  # $1 = state file, $2 = private diagnostics dir (may be absent). Prints only the summary.
  if py summary "$PINS" "$1" "$2" "$PUB" > /dev/null 2>&1 && test -f "$PUB/summary.json"; then
    cat "$PUB/summary.json"
  else
    printf '{"schema":"stability122.mac-private-tui.public-summary.v1","status":"fail","stage":"%s","reason":"summary_failed"}\n' \
      "$STAGE" > "$PUB/summary.json"
    cat "$PUB/summary.json"
  fi
}

on_exit() {
  local rc="$1"
  trap - EXIT
  st stage "$STAGE"; st reason "$REASON"; st status "$STATUS"; st rc "$rc"
  write_summary "$STATE" "$PRIV"
  exit "$rc"
}

mode_run() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
  : "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
  PRIV="$RUNNER_TEMP/private-diagnostics"
  PUB="$RUNNER_TEMP/public-summary"
  W="$RUNNER_TEMP/w"
  SRC="$GITHUB_WORKSPACE/$CHECKOUT_DIR"
  if test -e "$PRIV" || test -e "$PUB" || test -e "$W"; then
    echo "stage=setup status=fail reason=output_dir_exists"
    exit 2
  fi
  mkdir -m 700 "$PRIV" "$PUB" "$W" || { echo "stage=setup status=fail reason=setup_failed"; exit 2; }
  exec 2>> "$PRIV/job.stderr"
  STATE="$PRIV/state.txt"
  STAGE=setup; REASON=none; STATUS=fail
  trap 'on_exit $?' EXIT

  # 1. Pins (public, fixed in the harness commit H): R, toolchain, package, the 4 focus filters.
  enter pins
  COMMIT="$(py pins-check "$PINS" "$EXPECTED_REPO" "$CHECKOUT_DIR" "$NFILTERS")" || fail pins_invalid
  TC="$(py pin "$PINS" toolchain)" || fail pins_invalid
  PKG="$(py pin "$PINS" package)" || fail pins_invalid
  MACHINE_PIN="$(py pin "$PINS" expected_machine)" || fail pins_invalid
  FLOOR="$(py pin "$PINS" support_floor_macos)" || fail pins_invalid
  FILTERS="$(py pin "$PINS" required_filters)" || fail pins_invalid
  st commit "$COMMIT"; st toolchain "$TC"; st package "$PKG"; st support_floor "$FLOOR"

  # 2. Native host proof: the pinned architecture only; the macOS version is recorded
  #    against the 13 floor, never claimed as an actual macOS 13 execution.
  enter host
  MACHINE="$(uname -m)"
  MACOS="$(sw_vers -productVersion)"
  MACOS_BUILD="$(sw_vers -buildVersion)"
  st machine "$MACHINE"; st macos "$MACOS"; st macos_build "$MACOS_BUILD"
  if test "$MACHINE" != "$MACHINE_PIN"; then
    case "$MACHINE_PIN" in arm64) fail host_not_arm64;; x86_64) fail host_not_x86_64;; esac
  fi
  test -n "$MACOS" || fail host_not_macos

  # 3. The private source checked out by actions/checkout; HEAD must be exactly R.
  enter source
  { test -d "$SRC" && test ! -L "$SRC"; } || fail source_missing
  TOP="$(git -C "$SRC" rev-parse --show-toplevel)" || fail source_missing
  test "$(cd "$TOP" && pwd -P)" = "$(cd "$SRC" && pwd -P)" || fail source_missing
  HEAD_SHA="$(git -C "$SRC" rev-parse --verify HEAD)" || fail source_missing
  if test "$HEAD_SHA" != "$COMMIT"; then st head_match no; fail source_sha_mismatch; fi
  st head_match yes
  st tree "$(git -C "$SRC" rev-parse --verify 'HEAD^{tree}')"
  test -f "$SRC/rust/Cargo.toml" || fail source_layout
  STATUS_OUT="$(git -C "$SRC" status --porcelain)" || fail source_dirty
  test -z "$STATUS_OUT" || fail source_dirty

  # 4. No credential may survive the checkout step: env, Git config, remote URL or key files.
  enter credentials
  FINDING="$(py credscan "$SRC" "$RUNNER_TEMP" "$PRIV" "$PUB" "$W")"
  if test $? -ne 0; then
    case "$FINDING" in
      env_credential|git_local_credential|git_global_credential|remote_url_credential|key_material) ;;
      *) FINDING=credential_check_failed ;;
    esac
    st credential_finding "$FINDING"
    fail credential_config_present
  fi
  unset SSH_AUTH_SOCK SSH_AGENT_PID GIT_ASKPASS SSH_ASKPASS

  # 5. Isolated cargo/rustup/build outputs under RUNNER_TEMP; HOME and the runner stay unchanged.
  enter toolchain
  export CARGO_HOME="$W/cargo" RUSTUP_HOME="$W/rustup" CARGO_BUILD_JOBS=2 \
    CARGO_TARGET_DIR="$W/target" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
  mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" || fail toolchain_install_failed
  rustup toolchain install "$TC" --profile minimal < /dev/null > "$PRIV/toolchain.log" 2>&1 \
    || fail toolchain_install_failed
  cd "$SRC" || fail source_missing
  C=(cargo "+$TC" test --locked --manifest-path "$SRC/rust/Cargo.toml" -p "$PKG" --lib)

  # 6. Discovery: tests and ignored tests are counted separately; ignored tests are never run.
  enter discovery
  "${C[@]}" -- --list --format=terse < /dev/null > "$PRIV/list.txt" 2> "$PRIV/build.log" \
    || fail build_failed
  "${C[@]}" -- --list --ignored --format=terse < /dev/null > "$PRIV/ignored.txt" \
    2>> "$PRIV/build.log" || fail build_failed
  N="$(py listed "$PRIV/list.txt")" || fail discovery_empty
  test "$N" -gt 0 || fail discovery_empty

  # 7. Focused T01 fixture filters: each must be listed and pass >= 1 test (zero = failure).
  enter focus
  I=0
  while IFS= read -r F; do
    I=$((I + 1))
    N="$(py listed "$PRIV/list.txt" "$F")" || N=0
    st "focus_listed_$I" "$N"
    test "$N" -gt 0 || fail focus_not_listed
    "${C[@]}" -- "$F" < /dev/null > "$PRIV/focus-$I.log" 2>&1
    FRC=$?
    read -r RL RB RP RF RI RM RFO <<< "$(py results "$PRIV/focus-$I.log")"
    { test "$FRC" -eq 0 && test "$RB" -eq 0 && test "$RF" -eq 0; } || fail focus_failed
    { test "$RL" -ge 1 && test "$RP" -ge 1; } || fail focus_zero
  done <<< "$FILTERS"
  test "$I" -eq "$NFILTERS" || fail pins_invalid

  # 8. The full lib (default selection; ignored tests stay skipped and are counted separately).
  enter full_lib
  "${C[@]}" < /dev/null > "$PRIV/full-lib.log" 2>&1
  FRC=$?
  read -r RL RB RP RF RI RM RFO <<< "$(py results "$PRIV/full-lib.log")"
  { test "$FRC" -eq 0 && test "$RB" -eq 0 && test "$RF" -eq 0; } || fail full_lib_failed
  { test "$RL" -ge 1 && test "$RP" -ge 1; } || fail full_lib_zero

  STAGE=done; STATUS=pass
  echo "stage=done status=pass"
  exit 0
}

mode_finalize() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
  PUB="$RUNNER_TEMP/public-summary"
  PRIV="$RUNNER_TEMP/private-diagnostics"
  if test -f "$PUB/summary.json"; then
    echo "summary=present"
    exit 0
  fi
  mkdir -p "$PUB" && chmod 700 "$PUB" || exit 1
  STATE="$(mktemp "$RUNNER_TEMP/finalize-state.XXXXXX")" || exit 1
  if test -f "$PRIV/state.txt"; then cat "$PRIV/state.txt" > "$STATE"; fi
  STAGE=job; REASON=job_not_completed
  if test "${PIN_OUTCOME:-}" != success; then
    STAGE=pins; REASON=pin_step_failed
  elif test "${CHECKOUT_OUTCOME:-}" != success; then
    STAGE=private_checkout; REASON=private_checkout_failed
  fi
  if test -f "$PRIV/state.txt" && test "$REASON" = job_not_completed; then
    STAGE="$(sed -n 's/^stage=//p' "$PRIV/state.txt" | tail -n 1)"
    test -n "$STAGE" || STAGE=job
  fi
  st stage "$STAGE"; st reason "$REASON"; st status fail; st rc 1
  write_summary "$STATE" "$PRIV"
  rm -f "$STATE"
  exit 0
}

case "${1:-}" in
  pins) mode_pins ;;
  run) mode_run ;;
  finalize) mode_finalize ;;
  *) echo "usage: mac-tui-job.sh pins|run|finalize"; exit 64 ;;
esac
