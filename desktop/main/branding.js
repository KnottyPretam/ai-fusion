// desktop/main/branding.js — the product name and the window/taskbar icon, in ONE place.
//
// The app is called "Solomon's Judgement": three models answer, their claims are weighed as R1/R2/R3,
// and a disagreement that will not resolve is reported standing rather than split down the middle.
//
// Renaming stopped at what a user reads. Every INTERNAL identifier keeps the `triplex` codename on
// purpose — `window.triplex`, the `TRIPLEX_*` environment variables, the `triplex.*` localStorage
// keys, the `persist:<slot>` partitions, the python package, the `data-testid`s, and above all the
// userData directory `~/.config/triplex-desktop`, which holds the three logged-in sessions: Electron
// derives that path from `app.getName()`, so adding a `productName` to package.json would silently
// point the app at an empty profile and sign the user out of all three sites.
//
// The backend has its own seam for the same string, `APP_TITLE` (backend/config.py, read at call
// time), which `backend.js` passes to the spawned backend so exported documents carry this name too.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The product name: window title, menu, and the `APP_TITLE` handed to the backend. */
export const APP_TITLE = "Solomon's Judgement"

/** Where the generated PNGs live (`assets/icon-<px>.png`, plus `icon.png` = the 512). */
export const ASSETS_DIR = path.join(HERE, '..', 'assets')

/**
 * The window/taskbar icon: an absolute path to the 512 px PNG, or null when the assets are not
 * there (a worktree checkout, a test). `buildWindowOptions` omits `icon` for null rather than
 * handing Electron a path it would only warn about.
 */
export function iconPath(dir = ASSETS_DIR, exists = fs.existsSync) {
  const file = path.join(dir, 'icon.png')
  return exists(file) ? file : null
}
