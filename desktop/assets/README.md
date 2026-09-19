# Icon

`icon-master.jpg` (1024 px) is the master (the artwork was a JPEG to begin with; the generated PNGs are lossless from it). Every other file here, and the two in
`frontend/public/`, are generated from it — regenerate them all with ImageMagick after replacing it:

```sh
cd desktop/assets
for sz in 16 32 64 128 256; do convert icon-master.jpg -resize ${sz}x${sz} -strip icon-${sz}.png; done
convert icon-master.jpg -resize 512x512 -strip icon.png
convert icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png ../../frontend/public/favicon.ico
cp icon-256.png ../../frontend/public/icon-256.png
```

`icon.png` (512 px) is what `main/branding.js` hands Electron as the window and taskbar icon;
`frontend/public/favicon.ico` is the browser-tab icon for both the web app and the renderer, linked
from `frontend/index.html` (Vite rewrites the path under `VITE_BASE=/app/`).

The artwork is a generated emblem: Solomon on the throne between two machines, the name around the
rim. It came from the user on 2026-09-19; the second version, which spells "Judgement" the way the
app does.
