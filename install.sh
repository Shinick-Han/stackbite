#!/bin/sh
# StackBite 0.8.1, source commit 9279e6472871287405cbef80c3d79241ef5c92e9.
set -eu
run=yes
case "${1:-}" in
    '') ;;
    --no-run) run=no; shift ;;
    *) echo 'Usage: sh install.sh [--no-run]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--no-run]' >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
    Darwin:arm64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.8.1/stackbite-0.8.1-macos-arm64-9279e6472871.tar.gz'; expected='9bf9299742877cdd04ef7d871d5c470fb7c4396636a34e34c11a8839b4d62ccd'; root='stackbite-0.8.1-macos-arm64-9279e6472871'; hash=shasum ;;
    Darwin:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.8.1/stackbite-0.8.1-macos-x86_64-9279e6472871.tar.gz'; expected='4e6de4c9365c4f94965452bbb466eebb1e57bc5bcc45cc49cbb93278bf417596'; root='stackbite-0.8.1-macos-x86_64-9279e6472871'; hash=shasum ;;
    Linux:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.8.1/stackbite-0.8.1-linux-x86_64-9279e6472871.tar.gz'; expected='5f261bebef5c741c090c753c60f07013f289b208843b5d7d192cb7707a09d9e7'; root='stackbite-0.8.1-linux-x86_64-9279e6472871'; hash=sha256sum ;;
    *) echo 'StackBite supports macOS arm64/x86_64 and Linux x86_64.' >&2; exit 1 ;;
esac
[ -n "$url" ] || { echo 'This installer has no reviewed release pin for this architecture.' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/stackbite-install.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Installing StackBite 0.8.1...\n'
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
