// desktop/main/policy.js — popup and navigation policy for the site views (contract §5), the
// renderer window's same-origin guard and the process-wide backstop for stray webContents.
// Pure module: no electron import. Every `attach*` takes the webContents and the external opener
// as arguments so it runs under node --test with fakes.
//
//   popup host ∈ SSO_HOSTS ∪ site.hosts   → 'allow'   (child window sharing the partition; the
//                                                      child is policed the same way, recursively)
//   javascript: / data: / about: / other  → 'deny'
//   any other http(s) URL                 → 'external' (shell.openExternal + deny)
//   will-navigate / will-redirect (main frame) to a host outside site.hosts ∪ SSO_HOSTS
//                                         → preventDefault + external
//   renderer window: any main-frame navigation / redirect off its own origin → preventDefault +
//                    external; popups always external; IPC from a foreign document is refused
//   backstop: a webContents nobody policed (created outside views.js / main.js) gets every popup
//             denied and every navigation prevented

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

/** The origin of `url` (`scheme://host[:port]`), or null when it does not parse. */
export function originOf(url) {
  const u = parseUrl(url)
  return u ? u.origin : null
}

function siteHosts(site) {
  return site && Array.isArray(site.hosts) ? site.hosts : []
}

/** True when `hostname` belongs to the site or to an SSO provider (`ssoHosts` overrides the list; `[]` under E2E). */
export function isTrustedHost(hostname, site, ssoHosts = SSO_HOSTS) {
  return hostInList(hostname, ssoHosts) || hostInList(hostname, siteHosts(site))
}

/** Popup decision for `window.open(url)` from a site view: 'allow' | 'deny' | 'external'. */
export function popupDecision(url, site, ssoHosts = SSO_HOSTS) {
  const u = parseUrl(url)
  if (!u) return 'deny'
  if (!WEB_PROTOCOLS.has(u.protocol)) return 'deny' // javascript:, data:, about:blank, blob:, file:, …
  return isTrustedHost(u.hostname, site, ssoHosts) ? 'allow' : 'external'
}

/** True only when the popup may open as a child window (SSO or the site's own hosts). */
export function isAllowedPopup(url, site, ssoHosts = SSO_HOSTS) {
  return popupDecision(url, site, ssoHosts) === 'allow'
}

/** will-navigate decision for a main-frame navigation: 'allow' | 'external' | 'deny'. */
export function navigationDecision(url, site, ssoHosts = SSO_HOSTS) {
  const u = parseUrl(url)
  if (!u) return 'deny'
  if (!WEB_PROTOCOLS.has(u.protocol)) return 'deny'
  return isTrustedHost(u.hostname, site, ssoHosts) ? 'allow' : 'external'
}

/** True only when the view may navigate to `url` itself. */
export function isAllowedNavigation(url, site, ssoHosts = SSO_HOSTS) {
  return navigationDecision(url, site, ssoHosts) === 'allow'
}

/** True when `url` is something the system browser should receive (http(s) or mailto). */
export function isExternalUrl(url) {
  const u = parseUrl(url)
  return !!u && EXTERNAL_PROTOCOLS.has(u.protocol)
}

/**
 * True when the IPC event's sender frame lives on `origin`. Fakes and older events carry no
 * `senderFrame.url` — those pass (identity + main-frame checks still apply to them); a disposed
 * frame (the getter throws) or a document on any other origin is refused.
 */
export function frameOriginMatches(event, origin) {
  let frame = null
  try {
    frame = event ? event.senderFrame : null
  } catch (_e) {
    return false
  }
  if (frame === null) return false // navigated away / destroyed (isMainFrameOf refuses it too)
  if (frame === undefined) return true // fakes and older events carry no frame
  let url
  try {
    url = frame.url
  } catch (_e) {
    return false // the frame was disposed between send and receive
  }
  if (typeof url !== 'string') return true
  const o = originOf(url)
  return o !== null && typeof origin === 'string' && o === origin
}

// ---------------------------------------------------------------------------------------------
// Who has been policed (the backstop leaves those alone)
// ---------------------------------------------------------------------------------------------

const policed = new WeakSet()

/** True once `attachPolicy` / `attachOriginPolicy` has run on this webContents. */
export function isPoliced(webContents) {
  try {
    return !!webContents && typeof webContents === 'object' && policed.has(webContents)
  } catch (_e) {
    return false
  }
}

export function markPoliced(webContents) {
  if (webContents && typeof webContents === 'object') policed.add(webContents)
}

function warnTo(log, message) {
  if (log && typeof log.warn === 'function') log.warn(message)
}

/** The positional `url` is deprecated in Electron ≥ 30 but still passed; `details.url` is the successor. */
function navigationUrl(event, url) {
  if (typeof url === 'string') return url
  return event && typeof event.url === 'string' ? event.url : ''
}

/** will-redirect fires for sub-frames too; only the main frame's document is ours to police. */
function isMainFrameNavigation(event, isMainFrame) {
  if (typeof isMainFrame === 'boolean') return isMainFrame
  if (event && typeof event.isMainFrame === 'boolean') return event.isMainFrame
  return true
}

function makeExternal(openExternal) {
  return (url) => {
    if (typeof openExternal !== 'function' || !isExternalUrl(url)) return
    try {
      const r = openExternal(url)
      if (r && typeof r.catch === 'function') r.catch(() => {})
    } catch (_e) {
      /* the system browser is not our problem */
    }
  }
}

/**
 * Wire `setWindowOpenHandler`, `will-navigate`, `will-redirect` and `did-create-window` on a
 * webContents-like object (a site view or one of its allowed child windows):
 *   - `openExternal(url)` is called for 'external' decisions (http(s)/mailto only), never awaited;
 *   - `childWindowOptions` are the BrowserWindow overrides for allowed popups;
 *   - `ssoHosts` replaces SSO_HOSTS (main passes `[]` under TRIPLEX_E2E_APP=1);
 *   - every window the page is allowed to open is policed with the same site, recursively, so a
 *     popup can neither open arbitrary windows nor navigate off the allow-list.
 * Returns the handlers for tests.
 */
export function attachPolicy(webContents, site, { openExternal, childWindowOptions = { autoHideMenuBar: true }, log = null, ssoHosts = SSO_HOSTS } = {}) {
  const external = makeExternal(openExternal)
  const onWindowOpen = ({ url }) => {
    const decision = popupDecision(url, site, ssoHosts)
    if (decision === 'allow') return { action: 'allow', overrideBrowserWindowOptions: { ...childWindowOptions } }
    if (decision === 'external') external(url)
    else warnTo(log, `[policy] denied popup ${String(url).slice(0, 120)}`)
    return { action: 'deny' }
  }
  const decideNavigation = (event, url, what) => {
    const decision = navigationDecision(url, site, ssoHosts)
    if (decision === 'allow') return
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (decision === 'external') external(url)
    else warnTo(log, `[policy] denied ${what} ${String(url).slice(0, 120)}`)
  }
  const onWillNavigate = (event, url) => decideNavigation(event, navigationUrl(event, url), 'navigation')
  const onWillRedirect = (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrameNavigation(event, isMainFrame)) return
    decideNavigation(event, navigationUrl(event, url), 'redirect')
  }
  const onDidCreateWindow = (child) => {
    const childContents = child && child.webContents
    if (!childContents || typeof childContents.on !== 'function') return
    attachPolicy(childContents, site, { openExternal, childWindowOptions, log, ssoHosts })
  }
  webContents.setWindowOpenHandler(onWindowOpen)
  webContents.on('will-navigate', onWillNavigate)
  webContents.on('will-redirect', onWillRedirect)
  webContents.on('did-create-window', onDidCreateWindow)
  markPoliced(webContents)
  return { onWindowOpen, onWillNavigate, onWillRedirect, onDidCreateWindow }
}

/**
 * The renderer window's policy: it never opens windows itself (every `window.open` → external +
 * deny) and its main frame never leaves `origin` (a navigation or server-side redirect to any
 * other origin is prevented and handed to the system browser). `origin` is
 * `new URL(rendererUrl).origin`; a null origin (unparseable renderer URL) prevents everything.
 * Returns the handlers for tests.
 */
export function attachOriginPolicy(webContents, origin, { openExternal, log = null } = {}) {
  const external = makeExternal(openExternal)
  const onWindowOpen = ({ url }) => {
    external(url)
    return { action: 'deny' }
  }
  const guard = (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrameNavigation(event, isMainFrame)) return
    const target = navigationUrl(event, url)
    const o = originOf(target)
    if (o !== null && typeof origin === 'string' && o === origin) return
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    warnTo(log, `[renderer] blocked navigation off ${origin}: ${String(target).slice(0, 120)}`)
    external(target)
  }
  webContents.setWindowOpenHandler(onWindowOpen)
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
  markPoliced(webContents)
  return { onWindowOpen, onWillNavigate: guard, onWillRedirect: guard }
}

/**
 * Backstop for `app.on('web-contents-created')`: installed on EVERY webContents the moment it
 * exists (before views.js / main.js get to it), it denies popups and prevents navigations only
 * while the webContents is still unpoliced — `attachPolicy` / `attachOriginPolicy` run right after
 * construction and replace the window-open handler, and the navigation listeners here become
 * no-ops once `isPoliced`. Anything created elsewhere (a window nobody attached a policy to)
 * therefore stays where it is and opens nothing. Returns the handlers for tests.
 */
export function attachDefaultDenyPolicy(webContents, { log = null } = {}) {
  if (!webContents || typeof webContents.on !== 'function') return null
  const onWindowOpen = ({ url } = {}) => {
    warnTo(log, `[policy] unpoliced webContents: denied popup ${String(url).slice(0, 120)}`)
    return { action: 'deny' }
  }
  const onWillNavigate = (event, url, _isInPlace, isMainFrame) => {
    if (isPoliced(webContents)) return
    if (!isMainFrameNavigation(event, isMainFrame)) return
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    warnTo(log, `[policy] unpoliced webContents: blocked navigation ${String(navigationUrl(event, url)).slice(0, 120)}`)
  }
  if (!isPoliced(webContents) && typeof webContents.setWindowOpenHandler === 'function') webContents.setWindowOpenHandler(onWindowOpen)
  webContents.on('will-navigate', onWillNavigate)
  webContents.on('will-redirect', onWillNavigate)
  return { onWindowOpen, onWillNavigate, onWillRedirect: onWillNavigate }
}
