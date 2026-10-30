# StackBite

Work Stack organizes the work. Stackbite gets it moving.

## Install StackBite

Open [bitefoundry.dev/stackbite](https://bitefoundry.dev/stackbite) to copy the command for your OS.

Windows PowerShell:

```powershell
irm https://bitefoundry.dev/stackbite/w | iex
```

macOS and Linux:

```sh
curl -fsSL https://bitefoundry.dev/stackbite | sh
```

Node.js and Python are not required. The installer verifies the pinned native archive, retains existing data and running processes, and installs for your user. In an interactive terminal it opens StackBite. Run `stackbite` from a new terminal afterward. Provider CLI installation and login are separate.

Supported: Windows x64, Apple Silicon macOS 13+, and Linux x64 with glibc 2.28+.

<details>
<summary>Shared command for Windows PowerShell, macOS and Linux</summary>

```sh
curl https://raw.githubusercontent.com/Shinick-Han/stackbite/main/install.cmd -o "$HOME/.stackbite-install.cmd"; . "$HOME/.stackbite-install.cmd" $?
```

</details>

## Install through npm or npx

Node.js 20 or newer is required. The portable runtime is available for Windows x64
Linux x64 with glibc 2.28 or newer, and Apple Silicon macOS (M1 or later, macOS 13 or newer).
Intel Mac, Linux ARM and musl/Alpine builds are not supplied.
The GNU Linux x86_64 runtime is built to target AlmaLinux 8 (glibc 2.28), so a
newer host system glibc is not required. Node.js 20 or newer remains a separate
prerequisite of the launcher itself.
Python installation and compilation are unnecessary. Archive extraction requires
`tar` (included in macOS, current Windows and common Linux distributions).

## Install without an account

Choose one method. For a single run, use the public npm package:

```sh
npx --yes stackbite
```

For a persistent command, install it globally, prepare the runtime, then launch:

```sh
npm install --global stackbite
stackbite setup
stackbite
```

Global installation installs the small launcher without a postinstall download.
`stackbite setup` downloads and fully validates its pinned runtime without starting
the app or backend. It prints short stages to stderr. If setup is omitted, the
first launch prepares the runtime with the same stages. Cached launches remain
quiet and fully validate the runtime every time. Running both installation methods
is unnecessary.

The same preparation command works through npx:

```sh
npx --yes stackbite setup
```

Check a prepared runtime offline with `stackbite setup --check`. The launcher
checks all pinned file hashes, identity, inventory and link boundaries, without
downloading, extracting, writing cache files, or starting the app/backend. It exits
with status 0 when valid and status 1 when absent or invalid; an absent cache needs
`stackbite setup`. Only `setup` and `setup --check` are accepted setup forms.
The launcher check is read-only; npx itself may install its npm package before
invoking it, so use the installed command for an entirely offline check.

Binary caches use `%LOCALAPPDATA%\Stackbite\cache` on Windows and
`${XDG_CACHE_HOME:-~/.cache}/stackbite` on Linux and macOS. `LOCALAPPDATA`, `XDG_CACHE_HOME`
and `HOME` overrides retain their normal behavior. These caches are separate from
application state. Interrupted preparation removes only its own temporary staging
directory and can be retried. An invalid existing runtime is reported and left in
place; setup does not delete or overwrite it.

Update a registry installation with `npm install --global stackbite@latest`.

On Mac, use native Apple Silicon Node.js (`node -p process.arch` prints `arm64`).
Provider CLI installation and login are separate. Mac binaries are ad-hoc signed,
without Developer ID signing or notarization. Mac updates use the shared installer or npm.

## Direct GitHub package

Run the package attached to the verified GitHub release:

```sh
npx --yes https://github.com/Shinick-Han/stackbite/releases/download/v0.5.85/stackbite-0.5.85.tgz
```

Arguments go after the package URL, for example `--version` or `--status`. For a
persistent command, install that same package globally:

```sh
npm install --global https://github.com/Shinick-Han/stackbite/releases/download/v0.5.85/stackbite-0.5.85.tgz
stackbite setup
stackbite
```

The core source repository remains private at `shinick-dev/stackbite`. The separate
public `Shinick-Han/stackbite` repository distributes only this thin launcher and
verified compiled runtime releases; installers need no GitHub or npm login.
Registry-free distribution does not require publishing rights on npm.
The small JavaScript package downloads the
exact pinned native release on first execution, verifies its archive and file
checksums and product identity, then reuses a persistent binary cache. There is no
postinstall download or provider installation. An offline cached launch is possible;
the first launch needs access to GitHub release downloads.

For a GitHub URL installation, install the package URL from the newer release.
Each npm package pins one native release; the portable app's own `stackbite update`
does not change the npm package version.

## Existing data and processes

`STACKBITE_STATE_DIR` is the explicit state override. The bundled native runtime
owns state discovery and migration for both npm and direct launches. It reuses
existing configured state and keeps live databases, authentication and records
in place. New state uses `%LOCALAPPDATA%\Stackbite\state` or
`${XDG_STATE_HOME:-~/.local/state}/stackbite`.
Rooms, Seats, authentication, provider configuration, journals and Work Stack
contracts are not renamed or migrated. Binary cache data is separate from this
state. Installing or launching the npm package does not stop an existing backend.
Check the connected server's capabilities before using newly added runtime features.

For app commands, the launcher inherits terminal input/output and passes CLI
arguments directly to the native app. Its `setup` command only prepares/checks the
runtime. It does not insert a second screen renderer or an agent provider.
Global npm installation creates only the `stackbite` command; it does not claim an
external `helm` command or replace independent Kubernetes tooling.

## Maintainer release steps

Measure bounded fake runtime preparation and warm verification without network or
app processes:

```sh
node packaging/npm/test/measure-setup.js
```

The measurement reports fixture sizes and each preparation stage plus warm check
and launch validation costs. It uses disposable cache data and an inert child
stub; its timings are not measurements of released native bundles or providers.

Build and verify all three native platform archives first. Prepare the pinned manifest
from their exact extracted bundles and archive bytes:

```sh
python scripts/prepare_npm_release.py --version 0.5.85
npm test
npm pack
```

Keep `package.json` and `packaging/npm/release.json` versions equal. Inspect `npm
pack --dry-run` before publishing; the package must include the launcher and pinned
manifest, and exclude native runtimes, installed state, credentials, tests and
development worktrees. Test the packed package with `npx` on each supported platform.

Attach `stackbite-<version>.tgz` and its SHA-256 sidecar to the corresponding GitHub
release in the public distribution repository. Copy only the npm file allowlist to
that repository; never push the private core history, state, personal notes or
credentials. Native archives must retain dependency license notices. Publishing
the short name requires an authenticated owner account:

```sh
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
```

Complete any registry-required authentication interactively; do not put credentials
in this repository, prompts or package files. The repository currently specifies
`UNLICENSED` for the JavaScript wrapper instead of inventing a license for the app;
native runtime dependency notices remain in each platform archive.

## Keyboard shortcuts

Press `Ctrl+B`, then `?` for Help. Use `w` for a new Room, `c` for a new Seat, `f` to focus the list, and `q` to close the window while keeping Seats running. These letters follow `Ctrl+B`. Change direct bindings in Settings → Keyboard shortcuts.
