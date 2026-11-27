# StackBite through npm and npx

StackBite 0.8.1 supplies Windows x64, Linux x64 with glibc 2.28 or newer,
and native Apple Silicon and Intel runtimes for macOS 13 or newer.
Node.js 20 or newer is required.
The current [Node.js LTS](https://nodejs.org/en/download) is recommended. Linux
ARM and musl/Alpine builds are not supplied. Python installation and compilation
are unnecessary. Archive extraction requires `tar` (included in macOS, current
Windows and common Linux distributions).

## Install without an account

Choose one method. For a single run:

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
`stackbite setup` downloads and fully validates its pinned runtime without
starting the app or backend, printing short stages to stderr. If setup is
omitted, the first launch prepares the runtime with the same stages. Cached
launches reuse the prepared runtime and verify the selected payload. Running both
installation methods is unnecessary. The same preparation works through npx:
`npx --yes stackbite@latest setup`.

### Updating over an earlier installer-based installation

An earlier StackBite installed with its own installer left a launcher in
`~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows). If that directory is
ahead of npm's on `PATH`, typing `stackbite` keeps starting that older version,
and npm runs no StackBite code during `npm install`. Run the npm package once,
whatever `PATH` picks:

```sh
npx --yes stackbite@latest setup
```

When this prepares a newer runtime, StackBite points its own older launcher at
it and prints one line per launcher on stderr (`Stackbite: the stackbite command
at <path> started version <old>; it now starts version <new> ...`). Only a
launcher StackBite's installer wrote, running a strictly older version of the
same installation, is changed; its state directory is kept and the previous
image is not removed. A newer or same-version launcher, another npm
installation and any file StackBite cannot identify are left unchanged and
reported with the exact next action instead. Set
`STACKBITE_NPM_KEEP_LAUNCHERS=1` to keep launchers unchanged. Running it again
changes and prints nothing.

The launcher selects the verified native entry for your platform. The runtime
contains the Rust frontend, Room management service and terminal owner; Python is
not bundled or required. Keep the complete downloaded payload intact.

Check a prepared runtime offline with `stackbite setup --check`. It checks all
pinned file hashes, identity, inventory and link boundaries without downloading,
extracting, writing cache files or starting the app. It exits 0 when valid and 1
when absent or invalid; an absent runtime needs `stackbite setup`. npx itself may
install its npm package first, so use the installed command for a fully offline
check.

Prepared runtimes live under `%LOCALAPPDATA%\Stackbite\app\<version>-<source12>`
on Windows and `${XDG_DATA_HOME:-~/.local/share}/stackbite/app/stackbite-<version>-<platform>-<source12>`
on Linux and macOS. Room/state data is separate. Downloads use owned system-temp
staging; interrupted preparation can be retried, and an invalid existing runtime
is reported and left in place.

A prepared runtime at that location that fails verification is not run.
`stackbite --version`, `stackbite --help` and `stackbite uninstall --help`
still print the pinned version or a short usage on stdout, and the reason and
repair commands on stderr: `stackbite uninstall --keep-data`, then
`stackbite setup` (first `npm install --global stackbite@<version>` if removal
also removed the npm command). They exit 1, not 0, because the installation is
unusable. Other commands fail with the verification error followed by the same
repair commands.

## Mac architecture

The launcher uses Node.js `process.arch`: `arm64` selects the Apple Silicon
runtime and `x64` the Intel runtime. Use a native Node.js installation for your
Mac architecture; an x64 Node.js process under Rosetta selects the Intel runtime,
which is not native Intel qualification. Developer ID signing and notarization are not provided for the Mac bundles.

## Remote execution hosts

The installed app can prepare a verified runtime capsule on a Linux x86_64
(glibc 2.28+) SSH host from **Menu → Connections** (Setup or Test), so that host
runs Seats without a full StackBite installation. The capsule is pinned by the
same release as this package. Authentication stays native OpenSSH; no passwords
are stored. Windows execution hosts cannot run the capsule.

## Update and remove

Update a registry installation with `npm install --global stackbite@latest`.
Each npm package pins one native release; the app's own `stackbite update` does
not change the npm package version.

Preview product removal with `stackbite uninstall --preview` (`stackbite delete`
is an alias). `stackbite uninstall` performs removal; add `--keep-data` to retain
product data and hooks. Removal uses an already cached verified runtime; with
no runtime installed, a new removal downloads nothing. When the prepared runtime
fails verification, `stackbite uninstall` and `stackbite uninstall --preview`
download a private verified copy of the pinned runtime for that command only
and run it instead of the damaged one. This needs access to GitHub release
downloads; without it the command stops and nothing is run or removed. Removal
removes the verified global StackBite npm registration,
command shims and the owned local capsule cache. npm itself, unrelated packages,
shared prefix directories and npx caches remain.

## Direct GitHub package

Open the [latest release](https://github.com/Shinick-Han/stackbite/releases/latest)
and copy its attached `stackbite-<version>.tgz` URL when an explicit version is
needed. Pass that URL to `npx --yes` for one run, or to `npm install --global` for
a persistent command; arguments such as `--version` go after the URL.

The public [Shinick-Han/stackbite](https://github.com/Shinick-Han/stackbite)
repository distributes this thin launcher and verified compiled runtime releases;
installers need no GitHub or npm login. The first-party source repository is
private. The launcher downloads the exact pinned native release on first
execution, verifies its archive, file checksums and product identity, then reuses
a persistent binary cache. There is no postinstall download or provider
installation. The first launch needs access to GitHub release downloads; later
launches can run offline.

## Existing data and processes

`STACKBITE_STATE_DIR` is the explicit state override. The native runtime owns
state discovery and migration for npm and direct launches, reuses existing
configured state, and keeps live databases, authentication and records in place.
New state uses `%LOCALAPPDATA%\Stackbite\state` or
`${XDG_STATE_HOME:-~/.local/state}/stackbite`. Installing or launching the npm
package does not stop an existing backend; check the connected server's
capabilities before using newly added runtime features.

For app commands, the launcher inherits terminal input/output and passes CLI
arguments directly to the native app. It adds no screen renderer, agent provider
or `STACKBITE_FRONTEND` value. Global npm installation creates only the
`stackbite` command.

Installing a package, activating management and moving an existing Seat to a new
owner are separate operations. Room/Seat definitions and saved history persist,
but some provider conversations require manual resume and an owner change can
replace generation/PID.

## License

StackBite 0.5.122 and later, including this launcher, use the
[StackBite License](https://github.com/Shinick-Han/stackbite/blob/main/LICENSE);
releases through 0.5.121 published under MIT stay MIT. Native runtime dependency
notices remain in each platform archive. Report problems at
[issues](https://github.com/Shinick-Han/stackbite/issues).
