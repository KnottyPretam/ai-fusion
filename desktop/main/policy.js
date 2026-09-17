// desktop/main/policy.js — popup and navigation policy for the site views (contract §5).
// Pure module: no electron import. `attachPolicy` takes the webContents and the external opener
// as arguments so it runs under node --test with fakes.
//
//   popup host ∈ SSO_HOSTS ∪ site.hosts   → 'allow'   (child window sharing the partition)
//   javascript: / data: / about: / other  → 'deny'
//   any other http(s) URL                 → 'external' (shell.openExternal + deny)
//   will-navigate to a host outside site.hosts ∪ SSO_HOSTS → preventDefault + external

import { SSO_HOSTS, hostInList } from './sites.js'

const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function parseUrl(url) {
  try {
    return new URL(String(url))
  } catch (_e) {
    return null
  }
}

function siteHosts(site) {
  return site && Array.isArray(site.hosts) ? site.hosts : []
}

/** True when `hostname` belongs to the site or to an SSO provider. */
export function isTrustedHost(hostname, site) {
  return hostInList(hostname, SSO_HOSTS) || hostInList(hostname, siteHosts(site))
}

/** Popup decision for `window.open(url)` from a site view: 'allow' | 'deny' | 'external'. */
export function popupDecision(url, site) {
  const u = parseUrl(url)
  if (!u) return 'deny'
  if (!WEB_PROTOCOLS.has(u.protocol)) return 'deny' // javascript:, data:, about:blank, blob:, file:, …
  return isTrustedHost(u.hostname, site) ? 'allow' : 'external'
}

/** True only when the popup may open as a child window (SSO or the site's own hosts). */
export function isAllowedPopup(url, site) {
  return popupDecision(url, site) === 'allow'
}

/** will-navigate decision for a main-frame navigation: 'allow' | 'external' | 'deny'. */
export function navigationDecision(url, site) {
  const u = parseUrl(url)
  if (!u) return 'deny'
  if (!WEB_PROTOCOLS.has(u.protocol)) return 'deny'
  return isTrustedHost(u.hostname, site) ? 'allow' : 'external'
}

/** True only when the view may navigate to `url` itself. */
export function isAllowedNavigation(url, site) {
  return navigationDecision(url, site) === 'allow'
}

/** True when `url` is something the system browser should receive (http(s) or mailto). */
export function isExternalUrl(url) {
  const u = parseUrl(url)
  return !!u && EXTERNAL_PROTOCOLS.has(u.protocol)
}

/**
 * Wire `setWindowOpenHandler` and `will-navigate` on a webContents-like object:
 *   - `webContents.setWindowOpenHandler(fn)` and `webContents.on('will-navigate', fn)` must exist;
 *   - `openExternal(url)` is called for 'external' decisions (http(s)/mailto only), never awaited;
 *   - `childWindowOptions` are the BrowserWindow overrides for allowed popups.
 * Returns the two handlers for tests.
 */
export function attachPolicy(webContents, site, { openExternal, childWindowOptions = { autoHideMenuBar: true }, log = null } = {}) {
  const external = (url) => {
    if (typeof openExternal !== 'function' || !isExternalUrl(url)) return
    try {
      const r = openExternal(url)
      if (r && typeof r.catch === 'function') r.catch(() => {})
    } catch (_e) {
      /* the system browser is not our problem */
    }
  }
  const onWindowOpen = ({ url }) => {
    const decision = popupDecision(url, site)
    if (decision === 'allow') return { action: 'allow', overrideBrowserWindowOptions: { ...childWindowOptions } }
    if (decision === 'external') external(url)
    else if (log && typeof log.warn === 'function') log.warn(`[policy] denied popup ${String(url).slice(0, 120)}`)
    return { action: 'deny' }
  }
  const onWillNavigate = (event, url) => {
    const decision = navigationDecision(url, site)
    if (decision === 'allow') return
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (decision === 'external') external(url)
    else if (log && typeof log.warn === 'function') log.warn(`[policy] denied navigation ${String(url).slice(0, 120)}`)
  }
  webContents.setWindowOpenHandler(onWindowOpen)
  webContents.on('will-navigate', onWillNavigate)
  return { onWindowOpen, onWillNavigate }
}
