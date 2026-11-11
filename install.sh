#!/bin/sh
# StackBite 0.5.119, source commit 9c72f96cedd31ba019c38fcadbf3f32e35baccec.
set -eu
run=yes
case "${1:-}" in
    '') ;;
    --no-run) run=no; shift ;;
    *) echo 'Usage: sh install.sh [--no-run]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--no-run]' >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
    Darwin:arm64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.119/stackbite-0.5.119-macos-arm64-9c72f96cedd3.tar.gz'; expected='62520885eee09930780d0151b8ebc260ebb75cc7fdd547fa4a7f6b99f76db456'; root='stackbite-0.5.119-macos-arm64-9c72f96cedd3'; hash=shasum ;;
    Darwin:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.119/stackbite-0.5.119-macos-x86_64-9c72f96cedd3.tar.gz'; expected='f58c30d2150111190879fe059412d7d859e5d803e79e7e06fc8c5f6b4b318cd7'; root='stackbite-0.5.119-macos-x86_64-9c72f96cedd3'; hash=shasum ;;
    Linux:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.119/stackbite-0.5.119-linux-x86_64-9c72f96cedd3.tar.gz'; expected='8b18cb0f59e4758222a138eb1c0102812cfb603739f36b8eae2f36810f7ff058'; root='stackbite-0.5.119-linux-x86_64-9c72f96cedd3'; hash=sha256sum ;;
    *) echo 'StackBite supports macOS arm64/x86_64 and Linux x86_64.' >&2; exit 1 ;;
esac
[ -n "$url" ] || { echo 'This installer has no reviewed release pin for this architecture.' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/stackbite-install.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Installing StackBite 0.5.119...\n'
curl -fsSL "$url" -o "$stage/archive.tar.gz"
if [ "$hash" = shasum ]; then
    actual=$(shasum -a 256 "$stage/archive.tar.gz")
else
    actual=$(sha256sum "$stage/archive.tar.gz")
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || { echo 'Archive SHA256 mismatch.' >&2; exit 1; }
tar -xzf "$stage/archive.tar.gz" -C "$stage"
if ! sh "$stage/$root/install.sh" > "$stage/install.log" 2>&1; then
    echo 'StackBite installation failed:' >&2
    tail -c 4096 "$stage/install.log" >&2
    exit 1
fi
launcher=$HOME/.local/bin/stackbite
case ":${PATH:-}:" in
    *:"$HOME/.local/bin":*) ;;
    *)
        profile=
        case "${SHELL:-}" in
            */zsh) profile=${ZDOTDIR:-$HOME}/.zshrc ;;
            */sh|*/dash) profile=$HOME/.profile ;;
            */bash)
                if [ "$hash" = shasum ]; then
                    profile=$HOME/.bash_profile
                    for candidate in .bash_profile .bash_login .profile; do
                        if [ -f "$HOME/$candidate" ] && [ -r "$HOME/$candidate" ]; then
                            profile=$HOME/$candidate
                            break
                        fi
                    done
                else profile=$HOME/.bashrc; fi ;;
        esac
        if [ -n "$profile" ]; then
            line='export PATH="$HOME/.local/bin:$PATH" # StackBite'
            if grep -Fqx "$line" "$profile" 2>/dev/null || (printf '\n%s\n' "$line" >> "$profile") 2>/dev/null; then
                printf 'StackBite is on PATH in new shells (%s).\n' "$profile"
            else
                printf 'Run %s; add %s to your shell PATH for the short command.\n' "$launcher" "$HOME/.local/bin"
            fi
        else
            printf 'Run %s (add %s to PATH if desired).\n' "$launcher" "$HOME/.local/bin"
        fi ;;
esac
printf 'Installed StackBite: %s\n' "$launcher"
cleanup
trap - EXIT HUP INT TERM
if [ "$run" = yes ] && [ -t 1 ]; then
    printf 'Starting StackBite...\n'
    if [ -t 0 ]; then
        "$launcher"
    else
        exec 3<&1
        terminal=$(tty <&3)
        exec 3<&-
        "$launcher" < "$terminal"
    fi
fi
