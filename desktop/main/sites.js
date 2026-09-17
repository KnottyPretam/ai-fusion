// desktop/main/sites.js — the three embedded sites and the SSO host allow-list.
// Contract §5 of docs/desktop-contract.md. Pure module: no electron import, no I/O.

/** Slot order used everywhere in the desktop app (matches `window.triplex.slots`). */
export const SLOTS = Object.freeze(['claude', 'chatgpt', 'grok'])

/** Site table exactly as in contract §5. `hosts` also covers every subdomain of each entry. */
export const SITES = Object.freeze({
  chatgpt: {
    url: 'https://chatgpt.com/',
    newChatUrl: 'https://chatgpt.com/',
    partition: 'persist:chatgpt',
    hosts: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com', 'auth0.openai.com'],
  },
  claude: {
    url: 'https://claude.ai/new',
    newChatUrl: 'https://claude.ai/new',
    partition: 'persist:claude',
    hosts: ['claude.ai'],
  },
  grok: {
    url: 'https://grok.com/',
    newChatUrl: 'https://grok.com/',
    partition: 'persist:grok',
    hosts: ['grok.com', 'accounts.x.ai', 'x.com'],
  },
})

/** Hosts that may open as real child windows (SSO popups) from any site view. */
export const SSO_HOSTS = Object.freeze([
  'accounts.google.com',
  'accounts.youtube.com',
  'login.live.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.x.ai',
  'x.com',
  'twitter.com',
  'api.twitter.com',
  'challenges.cloudflare.com',
])

/** `TRIPLEX_GROK_SURFACE=x.com` switches the Grok pane to the X-hosted surface (escape hatch, unverified). */
export const GROK_X_SURFACE_URL = 'https://x.com/i/grok'

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlainObject(v)) {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = clone(val)
    return out
  }
  return v
}

/** Deep merge: objects recurse, arrays and scalars in `override` REPLACE. Returns a new object. */
export function deepMerge(base, override) {
  const out = clone(base)
  if (!isPlainObject(override)) return out
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = clone(v)
  }
  return out
}

/** True when `hostname` equals `host` or is a subdomain of it (case-insensitive). */
export function hostMatches(hostname, host) {
  if (typeof hostname !== 'string' || typeof host !== 'string') return false
  const a = hostname.toLowerCase().replace(/\.$/, '')
  const b = host.toLowerCase().replace(/\.$/, '')
  return a === b || a.endsWith('.' + b)
}

/** True when `hostname` matches any entry of `hosts`. */
export function hostInList(hostname, hosts) {
  return Array.isArray(hosts) && hosts.some((h) => hostMatches(hostname, h))
}

/**
 * Resolve the effective site table from the environment:
 *   1. a deep copy of SITES;
 *   2. `TRIPLEX_GROK_SURFACE=x.com` → grok url/newChatUrl = https://x.com/i/grok;
 *   3. `TRIPLEX_SITES_JSON` (a JSON object string) deep-merged on top (tests point every site
 *      at the fake site). Invalid JSON / a non-object throws an Error naming the variable;
 *      main.js turns that into a config error (exit 2).
 */
export function resolveSites(env = process.env) {
  let sites = clone(SITES)
  if (env && env.TRIPLEX_GROK_SURFACE === 'x.com') {
    sites.grok.url = GROK_X_SURFACE_URL
    sites.grok.newChatUrl = GROK_X_SURFACE_URL
  }
  const raw = env && env.TRIPLEX_SITES_JSON
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(`TRIPLEX_SITES_JSON is not valid JSON: ${e.message}`)
    }
    if (!isPlainObject(parsed)) throw new Error('TRIPLEX_SITES_JSON must be a JSON object keyed by slot')
    for (const key of Object.keys(parsed)) {
      if (!SLOTS.includes(key)) throw new Error(`TRIPLEX_SITES_JSON: unknown slot "${key}"`)
    }
    sites = deepMerge(sites, parsed)
  }
  for (const slot of SLOTS) {
    const s = sites[slot]
    for (const key of ['url', 'newChatUrl', 'partition']) {
      if (typeof s[key] !== 'string' || s[key] === '') throw new Error(`site ${slot}: ${key} must be a non-empty string`)
    }
    if (!Array.isArray(s.hosts) || !s.hosts.every((h) => typeof h === 'string' && h !== '')) {
      throw new Error(`site ${slot}: hosts must be a list of hostnames`)
    }
  }
  return sites
}

/** Hosts a site URL may use under `TRIPLEX_E2E_APP=1` (contract §5: the app refuses anything else). */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The `url` / `newChatUrl` entries of `sites` whose host is not loopback, as `{slot, key, url}`
 * (empty when every site URL is local). An unparseable URL counts as non-loopback.
 */
export function nonLoopbackSiteUrls(sites) {
  const out = []
  for (const slot of SLOTS) {
    const s = sites && sites[slot]
    if (!s) continue
    for (const key of ['url', 'newChatUrl']) {
      let host = null
      try {
        host = new URL(String(s[key])).hostname
      } catch (_e) {
        host = null
      }
      if (!LOOPBACK_HOSTS.includes(host)) out.push({ slot, key, url: s[key] })
    }
  }
  return out
}

/** The site table as `panes:getInfo` reports it: `{[slot]: {url, newChatUrl, partition}}` (hosts stay private). */
export function publicSites(sites) {
  const out = {}
  for (const slot of SLOTS) {
    const s = sites && sites[slot]
    if (!s) continue
    out[slot] = { url: s.url, newChatUrl: s.newChatUrl, partition: s.partition }
  }
  return out
}
