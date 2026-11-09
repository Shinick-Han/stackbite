# Stackbite

A local workspace for shells and agent CLIs, organized into Rooms and Seats.
The app uses a Rust-native launcher, Room service, terminal owners and TUI.

## Install

macOS / Linux:

```sh
curl -fsSL https://bitefoundry.dev/stackbite | sh
```

Windows PowerShell:

```powershell
irm https://bitefoundry.dev/stackbite/w | iex
```

Open a new terminal in your working folder and run `stackbite`.
Native installation needs no Node.js, Python or WSL. Install and sign in to your
chosen provider CLI separately.

For Node.js 20+ users:

```sh
npm install --global stackbite@latest
stackbite setup
stackbite
```

The npm package is a small launcher. `setup` downloads and verifies its pinned
native bundle without opening the app; first launch also prepares it if needed.
Later launches reuse the verified cache. `npx --yes stackbite@latest` also works.

Native bundles: Windows x64, Linux x86_64 with GLIBC 2.28+, and Apple Silicon / Intel
macOS 13+. Linux ARM and musl/Alpine bundles are not provided.
Download and extract the **entire** archive from
[latest release](https://github.com/Shinick-Han/stackbite/releases/latest).

## Use

The sidebar manages Rooms and Seats. Menu opens actions and settings; Rooms and
Files switch sidebar content. Files provides browsing and read-only Preview.
Closing the window leaves daemon-owned work running. Room and Seat definitions
and saved records persist; conversation resume depends on the provider and the
recorded conversation identity.

## Update and maintenance

```sh
stackbite --version
stackbite --status
stackbite update --check
stackbite update --apply
stackbite restart
stackbite stop --apply
```

`update --apply` installs the released runtime and coordinates engine transition.
Active Seats and older owners can finish transition separately; a client version
alone does not prove every running engine has changed. `restart` recovers the
local Room service while retaining definitions and records; it does not guarantee
that every interrupted CLI resumes its prior conversation.

`stackbite --help` and `stackbite agent --help` describe the available commands.
`stackbite uninstall --preview` shows removal scope before an explicit uninstall.

## Distribution

This repository distributes installers, signed native release artifacts and the
npm launcher. The core source repository is private. See release notes for the
actual platform validation and known limitations of each version. Published
release: **0.5.115**.

## Keyboard shortcuts

Press `Ctrl+B`, then `?` for Help. Use `w` for a new Room, `c` for a new Seat, `f` to focus the list, and `q` to close the window while keeping Seats running. These letters follow `Ctrl+B`. Change direct bindings in Settings → Keyboard shortcuts.
