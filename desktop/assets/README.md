# Icon

`icon-master.jpg` (1024 px) is the master (the artwork was a JPEG to begin with; the generated PNGs are lossless from it). Every other file here, and the two in
`frontend/public/`, are generated from it — regenerate them all with ImageMagick after replacing it:

```sh
cd desktop/assets
for sz in 16 32 48 64 128 256; do convert icon-master.jpg -resize ${sz}x${sz} -strip icon-${sz}.png; done
convert icon-master.jpg -resize 512x512 -strip icon.png
convert icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png ../../frontend/public/favicon.ico
cp icon-256.png ../../frontend/public/icon-256.png
```

`icon.png` (512 px) is what `main/branding.js` hands Electron as the window and taskbar icon;
`icon-48.png` is the mark in the printed page header (`PRINT_LOGO_PX`, embedded per page by
Chromium, so the size matters), `icon-64.png` and `icon-128.png` are what the backend embeds in
an exported Markdown and HTML document, and `frontend/src/assets/logo.png` (a copy of the 128) is
the mark in the window's bottom-left corner;
`frontend/public/favicon.ico` is the browser-tab icon for both the web app and the renderer, linked
from `frontend/index.html` (Vite rewrites the path under `VITE_BASE=/app/`).

The artwork is a generated emblem: Solomon on the throne between two machines, the name around the
rim. It came from the user on 2026-09-19; the second version, which spells "Judgment" the way the
app does.

## Dock / taskbar name

X11 takes the window-list label from `WM_CLASS`, which Electron 44 derives from `package.json`'s
`name` — `triplex-desktop`. Neither `app.setName()` nor Chromium's `--class` switch changes it
(both measured 2026-09-19), and the `name` itself must not change: Electron builds the userData path
from it, so renaming the package would point the app at an empty profile and sign the user out of
all three sites.

The supported fix is a desktop entry, which maps that WM_CLASS to a display name and this icon:

```sh
cp desktop/solomons-judgment.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

`Exec` and `Icon` in that file are absolute paths into this checkout; edit them if the repo moves.
