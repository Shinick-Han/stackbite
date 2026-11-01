#!/bin/sh
# StackBite 0.5.93, source commit 7fc519e2fc309c976ada7123f7c9cd9adc9f46ee.
set -eu
run=yes
case "${1:-}" in
    '') ;;
    --no-run) run=no; shift ;;
    *) echo 'Usage: sh install.sh [--no-run]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--no-run]' >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
    Darwin:arm64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.93/stackbite-0.5.93-macos-arm64-7fc519e2fc30.tar.gz'; expected='5092e9b6d4a58f029d59284e20aeaa39a835c5b186cecccf88eb5dfe16bb41d6'; root='stackbite-0.5.93-macos-arm64-7fc519e2fc30'; hash=shasum ;;
    Linux:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.93/stackbite-0.5.93-linux-x86_64-7fc519e2fc30.tar.gz'; expected='209ad58a56e53fc9be5a10c330b9f79db2335625b9fbcc8d538fbed4b2cd9584'; root='stackbite-0.5.93-linux-x86_64-7fc519e2fc30'; hash=sha256sum ;;
    *) echo 'StackBite supports macOS arm64 and Linux x86_64.' >&2; exit 1 ;;
esac
stage=$(mktemp -d "${TMPDIR:-/tmp}/stackbite-install.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Installing StackBite 0.5.93...\n'
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
