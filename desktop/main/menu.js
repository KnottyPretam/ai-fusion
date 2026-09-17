// desktop/main/menu.js — the application menu (Stage 2 electron-bridge; contract §2 shortcuts).
//
//   Triplex  Quit
//   Panes    the shortcut table of shortcuts.js (Pane 1/2/3, Toggle, Focus prompt, New chat
//            everywhere, Zoom, Reload pane, Inspect pane (dev))
//   Site     Reload selectors · Save DOM snapshot of the active pane · Sign out of ChatGPT /
//            Claude / Grok
//   Edit     the standard roles
//
// `autoHideMenuBar` keeps it hidden (Alt reveals it); the accelerators are the fallback for keys
// no view holds. Pure module: `shortcuts.menuTemplate()` and every action are injected, so
// node --test walks the template and clicks the items.

import { SLOTS } from './sites.js'

export const SITE_LABELS = Object.freeze({ chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' })

/**
 * buildMenuTemplate({shortcuts, dev, getActive, actions, log}) → template (Menu.buildFromTemplate input)
 *   shortcuts.menuTemplate()     the Stage 1 template (Triplex / Panes / Edit)
 *   getActive() → slot           the pane the snapshot item targets
 *   actions.reloadSelectors()    re-read the override now
 *   actions.saveSnapshot(slot)   → Promise<{path}>
 *   actions.signOut(slot)        → Promise
 */
export function buildMenuTemplate({ shortcuts, dev = false, getActive, actions = {}, log = console } = {}) {
  const base = shortcuts && typeof shortcuts.menuTemplate === 'function' ? shortcuts.menuTemplate() : [{ label: 'Triplex', submenu: [{ role: 'quit' }] }]
  const active = () => {
    const slot = typeof getActive === 'function' ? getActive() : null
    return SLOTS.includes(slot) ? slot : SLOTS[0]
  }
  const run = (name, fn, ...args) => {
    try {
      const r = typeof fn === 'function' ? fn(...args) : undefined
      if (r && typeof r.then === 'function') {
        r.then(
          (v) => {
            if (v && typeof v.path === 'string' && log && typeof log.log === 'function') log.log(`[menu] ${name}: ${v.path}`)
          },
          (e) => log && typeof log.warn === 'function' && log.warn(`[menu] ${name} failed: ${(e && e.message) || e}`),
        )
      }
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[menu] ${name} failed: ${(e && e.message) || e}`)
    }
  }
  const site = {
    label: 'Site',
    submenu: [
      { label: 'Reload selectors', click: () => run('reload selectors', actions.reloadSelectors) },
      { label: 'Save DOM snapshot of the active pane', click: () => run('save DOM snapshot', actions.saveSnapshot, active()) },
      { type: 'separator' },
      ...SLOTS.map((slot) => ({ label: `Sign out of ${SITE_LABELS[slot]}`, click: () => run(`sign out of ${SITE_LABELS[slot]}`, actions.signOut, slot) })),
    ],
  }
  const editAt = base.findIndex((m) => m && m.label === 'Edit')
  const out = base.slice()
  if (editAt === -1) out.push(site)
  else out.splice(editAt, 0, site)
  return out
}

/** Find a menu item by label anywhere in a template (tests and the integrator's smoke). */
export function findMenuItem(template, label) {
  for (const item of template || []) {
    if (!item) continue
    if (item.label === label) return item
    const found = findMenuItem(item.submenu, label)
    if (found) return found
  }
  return null
}
