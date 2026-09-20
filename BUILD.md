# Building and installing Solomon's Judgment

The app is three pieces in one package: the **Electron shell** (`desktop/`), the **renderer**
(`frontend/`, built to static files) and the **Python backend** (`backend/`, frozen by PyInstaller
into a directory that carries its own interpreter). An installed build needs **no Python, no uv,
no Node and no checkout** on the machine it runs on.

```
scripts/package.sh            # renderer → frozen backend → installer, for this platform
scripts/install-local.sh      # put the AppImage in your own launcher, no root
```

Artifacts land in `build/dist/`. Nothing under `build/` is committed.

## What you need

| | to run a build | notes |
|---|---|---|
| Node | 22+ | `node -v`; `npm ci` in both `frontend/` and `desktop/` |
| Python | 3.12+ | via [uv](https://docs.astral.sh/uv/); `uv sync --frozen` |
| uv | any recent | the backend freeze runs `uv run --group packaging pyinstaller` |

Electron itself is downloaded by `npm ci` in `desktop/`.

## Ubuntu / Debian

```sh
sudo apt-get install -y libarchive-tools fakeroot dpkg   # bsdtar is only needed for the Arch target
uv sync --frozen
(cd frontend && npm ci) && (cd desktop && npm ci)
scripts/package.sh --linux                                # AppImage + deb + pacman
```

Install it system-wide, or just for yourself:

```sh
sudo dpkg -i build/dist/solomons-judgment-*.deb   # /opt, entry in /usr/share/applications
scripts/install-local.sh                          # ~/.local, no root  (--uninstall to remove)
```

Either way it appears in the launcher as **Solomon's Judgment** with its icon. The window is matched
back to the entry by `StartupWMClass=triplex-desktop`, which is Electron's own window class and is
derived from the package name — see the note at the end.

**Verified on Ubuntu 20.04 (glibc 2.31)**: AppImage and deb build and run, the packaged app starts
its bundled backend (`[backend] spawned … via bundled`) and loads all three sites.

## Arch

Same build; the `pacman` target needs `bsdtar`:

```sh
sudo pacman -S --needed libarchive fakeroot nodejs npm uv
uv sync --frozen
(cd frontend && npm ci) && (cd desktop && npm ci)
scripts/package.sh --linux pacman
sudo pacman -U build/dist/solomons-judgment-*.pacman
```

The AppImage from any Linux build also runs on Arch as-is.

> On Ubuntu 20.04 the `pacman` target fails with `bsdtar … exit code 127` until
> `libarchive-tools` is installed. The AppImage and deb are unaffected. CI installs it.

## NixOS

`flake.nix` wraps the released AppImage with `appimageTools` (NixOS has no FHS loader, so a stock
AppImage cannot run unwrapped) and provides a dev shell with everything a source build needs.

```sh
nix run github:KnottyPretam/ai-fusion          # run it
nix profile install github:KnottyPretam/ai-fusion   # and keep it in the menu
nix develop                                     # a shell to build from source in
```

The flake expects an AppImage at `build/dist/solomons-judgment-<version>-x86_64.AppImage`, so build
that first (or point `src` at a release asset). The quick alternative, no flake at all:

```sh
nix-shell -p appimage-run --run 'appimage-run build/dist/solomons-judgment-*.AppImage'
```

> **Not verified**: there is no Nix on the machine this was written on. The flake is written to the
> documented `appimageTools.wrapType2` interface and evaluated only for syntax. Treat the first
> `nix build` as the real test.

## Windows

PyInstaller freezes the interpreter it is *running on* and never cross-builds, and NSIS on Linux
needs Wine — so Windows installers are built on Windows:

```powershell
uv sync --frozen
cd frontend; npm ci; $env:VITE_BASE='/app/'; npm run build; cd ..
uv run --group packaging pyinstaller --noconfirm --distpath build/pyinstaller --workpath build/pyinstaller-work packaging/backend.spec
cd desktop; npm ci; npx electron-builder --win
```

`build/dist/solomons-judgment-<version>-x64.exe` is an NSIS installer: per-user by default, with a
Start Menu and desktop shortcut.

> **Not verified**: built by CI on `windows-latest`, never on this machine. The one piece most
> likely to need a nudge is the PyInstaller hidden-import list in `packaging/backend.spec` if a
> dependency resolves differently on Windows.

## CI

`.github/workflows/build.yml` builds Linux and Windows on their own runners for every push to
`main`, runs the full offline gates first, and asserts the frozen backend answers `/` **with no
Python on PATH** before packaging. Pushing a `v*` tag attaches every artifact to a GitHub release.

## How it fits together

```
scripts/package.sh
 ├─ 1  frontend  VITE_BASE=/app/ npm run build   → frontend/dist
 ├─ 2  backend   pyinstaller packaging/backend.spec → build/pyinstaller/backend/triplex-backend
 └─ 3  app       electron-builder                → build/dist/*
                   extraResources: backend/ ← the frozen backend
                                   app/     ← the renderer, served by it at /app/
```

At startup `desktop/main/backend.js` looks for its backend in three places, in order: the **bundled**
one beside the executable (an installed app), the repo **venv** (a checkout), then **uv**. That is
why the same code runs from source and from an installer.

## Two names, on purpose

The product is **Solomon's Judgment**. The package is still called `triplex-desktop`, and must stay
that way: Electron derives the userData directory — which holds the three logged-in sessions — from
`package.json`'s `name`. Renaming it would point the app at an empty profile and sign you out of all
three sites. It also means an installed build and a checkout **share one profile**, so your logins
carry over the first time you run the packaged app.
