#!/bin/sh
# StackBite 0.5.121, source commit 3efd770c3b8048477c4bfdb9f8e54677278c6841.
set -eu
run=yes
case "${1:-}" in
    '') ;;
    --no-run) run=no; shift ;;
    *) echo 'Usage: sh install.sh [--no-run]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--no-run]' >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
    Darwin:arm64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.121/stackbite-0.5.121-macos-arm64-3efd770c3b80.tar.gz'; expected='bbb3603ffa874c5637fc17c8e301a838800b9979de62b4f43432c65c7cad4af2'; root='stackbite-0.5.121-macos-arm64-3efd770c3b80'; hash=shasum ;;
    Darwin:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.121/stackbite-0.5.121-macos-x86_64-3efd770c3b80.tar.gz'; expected='4a08c32cd44b7b5e9da58b0697ff0d06743de75b2de360d7f7cec5c78c114cbc'; root='stackbite-0.5.121-macos-x86_64-3efd770c3b80'; hash=shasum ;;
    Linux:x86_64) url='https://github.com/Shinick-Han/stackbite/releases/download/v0.5.121/stackbite-0.5.121-linux-x86_64-3efd770c3b80.tar.gz'; expected='686b61688e2af01e5c8beb66e9c8930b113c9a00f51445ebd8b3b4724f0a2bcb'; root='stackbite-0.5.121-linux-x86_64-3efd770c3b80'; hash=sha256sum ;;
    *) echo 'StackBite supports macOS arm64/x86_64 and Linux x86_64.' >&2; exit 1 ;;
esac
[ -n "$url" ] || { echo 'This installer has no reviewed release pin for this architecture.' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/stackbite-install.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Installing StackBite 0.5.121...\n'
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
