# Stackbite through npm and npx

Node.js 20 or newer is required. Release 0.5.118 supplies Windows x64,
Linux x64 with glibc 2.28 or newer, and Apple Silicon macOS 13 or newer.
Intel is excluded from 0.5.118; use `npm install --global stackbite@0.5.116`
on Intel Macs. The 0.5.118 npm package has no Intel runtime pin; its current
missing-pin error is generic, and automatic selection of an older qualified
platform version is not implemented. Linux ARM and musl/Alpine builds are not supplied.
Python installation and compilation are unnecessary. Archive extraction requires
`tar` (included in macOS, current Windows and common Linux distributions).

## Install without an account

Choose one method. For a single run, use the public npm package:

```sh
npx --yes stackbite@latest
```

For a persistent command, install it globally, prepare the runtime, then launch:

```sh
npm install --global stackbite@latest
stackbite setup
stackbite
```

Global installation installs the small launcher without a postinstall download.
`stackbite setup` downloads and fully validates its pinned runtime without starting
the app or backend. It prints short stages to stderr. If setup is omitted, the
first launch prepares the runtime with the same stages. Cached launches reuse the
prepared runtime and verify the selected payload; setup checks the full pinned
bundle, including optional components. Running both installation methods
is unnecessary.

The launcher selects the verified native `stackbite.exe` entry on Windows and
the verified native entry on Linux and macOS: `stackbite` itself in a one-file
package, or `stackbite-launcher` in an older package that pins it. The runtime contains the Rust frontend,
Room management service and terminal owner; Python is not bundled or required.
Keep the complete downloaded payload intact.

The same preparation command works through npx:

```sh
npx --yes stackbite@latest setup
```

Check a prepared runtime offline with `stackbite setup --check`. The launcher
checks all pinned file hashes, identity, inventory and link boundaries, without
downloading, extracting, writing cache files, or starting the app/backend. It exits
with status 0 when valid and status 1 when absent or invalid; an absent cache needs
`stackbite setup`. Only `setup` and `setup --check` are accepted setup forms.
The launcher check is read-only; npx itself may install its npm package before
invoking it, so use the installed command for an entirely offline check.

Prepared runtimes live under `%LOCALAPPDATA%\Stackbite\app\<version>-<source12>`
on Windows and `${XDG_DATA_HOME:-~/.local/share}/stackbite/app/stackbite-<version>-<platform>-<source12>`
on Linux and macOS, with an archive-pin suffix when needed. The selected installation
root determines this location; changing `XDG_CACHE_HOME` does not move it.
Legacy images under `%LOCALAPPDATA%\Stackbite\cache` or
`${XDG_CACHE_HOME:-~/.cache}/stackbite` can be verified and adopted into the installation.
Room/state data is separate. Downloads use owned system-temp staging. Interrupted
preparation can be retried; an invalid existing runtime is reported and left in place.

Update a registry installation with `npm install --global stackbite@latest`.

The launcher uses Node.js `process.arch`: `arm64` selects the Apple Silicon pin;
`x64` requires an Intel pin, which 0.5.118 does not contain. An x64 Node.js process
under Rosetta also needs that Intel pin: use native arm64 Node.js for 0.5.118 on
Apple Silicon. Rosetta execution is not native Intel hardware qualification.

Use a native Node.js installation for your Mac architecture. Install and sign in to provider CLIs such
as Codex or Claude separately. Stackbite can open without a provider login.
The Mac binaries use ad-hoc signing; they are not Developer ID signed or notarized.

Preview product removal with `stackbite uninstall --preview` (`stackbite delete`
is an alias). `stackbite uninstall` performs removal; add `--keep-data` to retain
product data and hooks. Removal uses only an already cached
verified runtime and never downloads one. The verified global Stackbite npm
registration and command shims are removed. npm itself, unrelated packages, shared
prefix directories and npx caches remain. Shared legacy and custom state is preserved.
See [removal and recovery](../../docs/uninstall.md).

## Direct GitHub package

Open the [public release](https://github.com/Shinick-Han/stackbite/releases/latest)
and copy its exact attached `stackbite-VERSION.tgz` URL when an explicit version
is needed. Pass that URL to `npx --yes` for one run, or to
`npm install --global` for a persistent command. Arguments such as `--version`
go after the URL. Use a published asset; a candidate version in documentation
does not establish that a package is available.

MIT-licensed source is public at `shinick-dev/stackbite`. The separate
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
Rooms, Seats, authentication, provider configuration, journals and integration
contracts retain their existing identities. Binary cache data is separate from this
state. Installing or launching the npm package does not stop an existing backend.
Check the connected server's capabilities before using newly added runtime features.

For app commands, the launcher inherits terminal input/output and passes CLI
arguments directly to the native app. Its `setup` command only prepares/checks the
runtime. It does not insert a second screen renderer or an agent provider.
Frontend selection belongs to the native runtime: the launcher adds no
`STACKBITE_FRONTEND` value and passes the caller's value unchanged. Installed
native runtimes open the Rust screen and native owner. Legacy `python` frontend,
owner and core selectors remain accepted as aliases for native execution;
`config show` reports requested and effective values. There is no Python runtime
fallback. The release pinned in `release.json` determines the behavior delivered
by that npm package.

Installing a package, activating management, and moving an existing Seat to a
new owner are separate operations. Room/Seat definitions and saved history
persist, but some provider conversations require manual resume and an owner
change can replace generation/PID. See [updates and restart](../../docs/update.md)
and [first use](../../docs/first-use.md).
Global npm installation creates only the `stackbite` command.

## Maintainer release steps

Measure bounded fake runtime preparation and warm verification without network or
app processes:

```sh
node packaging/npm/test/measure-setup.js
```

The measurement reports fixture sizes and each preparation stage plus warm check
and launch validation costs. It uses disposable cache data and an inert child
stub; its timings are not measurements of released native bundles or providers.

Build and verify Windows x64, Linux x64, macOS ARM64 and macOS x64 archives from the same
immutable source first, following [platform policy](../../docs/platform-release-policy.md).
Prepare the pinned manifest
from their exact extracted bundles and archive bytes:

```sh
python scripts/prepare_npm_release.py --version X.Y.Z
npm test
npm pack
```

Keep `package.json` and `packaging/npm/release.json` versions equal. Inspect `npm
pack --dry-run` before publishing; the package must include the launcher and pinned
manifest, and exclude native runtimes, installed state, credentials, tests and
development worktrees. Test the packed package on each supported platform.
Record native runtime acceptance separately from source checks and cross-compilation.

Attach `stackbite-<version>.tgz` and its SHA-256 sidecar to the corresponding GitHub
release in the public distribution repository. Copy only the npm file allowlist to
that repository; keep full source in the source repository and exclude state, personal notes and
credentials from release payloads. Native archives must retain dependency license notices. Publishing
the short name requires an authenticated owner account:

```sh
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
```

Complete any registry-required authentication interactively; do not put credentials
in this repository, prompts or package files. StackBite first-party source and this wrapper use the
[MIT License](../../LICENSE). Native runtime dependency notices remain in each
platform archive. Existing registry tarballs are not changed by this source update.

Archive hashes are checked during preparation; cached launches verify the selected
native payload. `setup --check` verifies the full pinned runtime without downloading
or writing it. The compact SHA-256 `v1-...` names belong to legacy cache lookup,
not the current durable installation layout described above.
