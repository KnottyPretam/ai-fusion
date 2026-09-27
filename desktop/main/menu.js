// desktop/main/menu.js — the application menu (Stage 2 electron-bridge; contract §2 shortcuts).
//
//   Triplex  Quit
//   Panes    the shortcut table of shortcuts.js (Pane 1…5, Toggle, Focus prompt, New chat
//            everywhere, Zoom, Reload pane, Inspect pane (dev))
//   Site     Reload selectors · Save DOM snapshot of the active pane · Show analyst page (reveals
//            the hidden analyst view as the fourth tab) · Sign out of <site> for each of the three
//            sites with a Stage-1 adapter (ChatGPT / Claude / Grok)
//   Edit     the standard roles
//
// `autoHideMenuBar` keeps it hidden (Alt reveals it); the accelerators are the fallback for keys
// no view holds. The active tab may be a renderer column (a token / local council member) since
// 2026-09-27: the snapshot item is then a warned no-op, as the pane-only shortcuts are. Pure
// module: `shortcuts.menuTemplate()` and every action are injected, so node --test walks the
// template and clicks the items.

import { SLOTS } from './sites.js'
import { isCouncilSlot } from './council.js'
import { APP_TITLE } from './branding.js'

export const SITE_LABELS = Object.freeze({ chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' })

/**
 * buildMenuTemplate({shortcuts, dev, getActive, actions, log}) → template (Menu.buildFromTemplate input)
 *   shortcuts.menuTemplate()     the Stage 1 template (Triplex / Panes / Edit)
 *   getActive() → slot           the pane the snapshot item targets
 *   actions.reloadSelectors()    re-read the override now
 *   actions.saveSnapshot(slot)   → Promise<{path}>
 *   actions.showAnalyst()        reveal the hidden analyst view (Stage 3; omitted → no item)
 *   actions.signOut(slot)        → Promise
 */
export function buildMenuTemplate({ shortcuts, dev = false, getActive, actions = {}, log = console } = {}) {
  const base = shortcuts && typeof shortcuts.menuTemplate === 'function' ? shortcuts.menuTemplate() : [{ label: APP_TITLE, submenu: [{ role: 'quit' }] }]
  /** The active site pane; null for a renderer column; the first pane when unknown. */
  const active = () => {
    const slot = typeof getActive === 'function' ? getActive() : null
    if (SLOTS.includes(slot)) return slot
    return isCouncilSlot(slot) ? null : SLOTS[0]
  }
  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[menu] ${m}`)
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
      {
        label: 'Save DOM snapshot of the active pane',
        click: () => {
          const slot = active()
          if (slot === null) return warn('save DOM snapshot: the active tab is a renderer column, not a site pane; nothing to snapshot')
          return run('save DOM snapshot', actions.saveSnapshot, slot)
        },
      },
      ...(typeof actions.showAnalyst === 'function' ? [{ label: 'Show analyst page', click: () => run('show analyst page', actions.showAnalyst) }] : []),
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
