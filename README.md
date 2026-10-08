# Stackbite through npm and npx

Work Stack organizes the work. Stackbite gets it moving.

Node.js 20 or newer is required. The portable runtime is available for Windows x64
and Linux x64 with glibc; macOS, ARM and musl/Alpine builds are not supplied yet.
Python installation and compilation are unnecessary. Archive extraction requires
`tar` (included in current Windows and common Linux distributions).

## Install without an account

Choose one method. For a single run, use the public npm package:

```sh
npx --yes stackbite
```

For a persistent command, install it globally and then run it:

```sh
npm install --global stackbite
stackbite
```

Both methods download the verified native runtime on first execution. Global
installation alone installs the small launcher; its first `stackbite` invocation
downloads the runtime. Running both installation methods is unnecessary.

Update a registry installation with `npm install --global stackbite@latest`.

## Direct GitHub package

Run the package attached to the verified GitHub release:

```sh
npx --yes https://github.com/Shinick-Han/stackbite/releases/download/v0.5.13/stackbite-0.5.13.tgz
```

Arguments go after the package URL, for example `--version` or `--status`. For a
persistent command, install that same package globally:

```sh
npm install --global https://github.com/Shinick-Han/stackbite/releases/download/v0.5.13/stackbite-0.5.13.tgz
stackbite
```

The core source repository remains private at `Shinick-Han/helm`. The separate
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

The launcher inherits terminal input/output and passes CLI arguments directly to
the native app. It does not insert a second screen renderer or an agent provider.
Global npm installation creates only the `stackbite` command; it does not claim an
external `helm` command or replace independent Kubernetes tooling.

## Maintainer release steps

Build and verify both native platform archives first. Prepare the pinned manifest
from their exact extracted bundles and archive bytes:

```sh
python scripts/prepare_npm_release.py --version 0.5.13
npm test
npm pack
```

Keep `package.json` and `packaging/npm/release.json` versions equal. Inspect `npm
pack --dry-run` before publishing; the package must include the launcher and pinned
manifest, and exclude native runtimes, installed state, credentials, tests and
development worktrees. Test the packed package with `npx` on both platforms.

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
