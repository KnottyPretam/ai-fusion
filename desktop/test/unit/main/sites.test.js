// sites.js — the contract §5 table, TRIPLEX_SITES_JSON deep-merge, TRIPLEX_GROK_SURFACE, the
// loopback refusal helper and the public projection; 2026-10-17: gemini.google.com as the fourth site
// (exact host, never bare google.com) and the one site vocabulary shared with protocol.js and site.cjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { SLOTS, SITES, SSO_HOSTS, resolveSites, nonLoopbackSiteUrls, publicSites, hostInList, deepMerge } from '../../../main/sites.js'
import { SLOT_IDS } from '../../../main/protocol.js'
import { WEB_SITES } from '../../../main/council.js'
import { SITE_LABELS } from '../../../main/menu.js'

const require = createRequire(import.meta.url)
// the sandboxed preload exports its pure helpers via module.exports when `module` exists (gotcha 18)
const siteAdapter = require('../../../preload/site.cjs')

test('SITES / SSO_HOSTS match contract §5', () => {
  assert.deepEqual([...SLOTS], ['claude', 'chatgpt', 'grok', 'gemini'])
  assert.ok(Object.isFrozen(SLOTS))
  assert.deepEqual(SITES.chatgpt, { url: 'https://chatgpt.com/', newChatUrl: 'https://chatgpt.com/', partition: 'persist:chatgpt', hosts: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com', 'auth0.openai.com'] })
  assert.deepEqual(SITES.claude, { url: 'https://claude.ai/new', newChatUrl: 'https://claude.ai/new', partition: 'persist:claude', hosts: ['claude.ai'] })
  assert.deepEqual(SITES.grok, { url: 'https://grok.com/', newChatUrl: 'https://grok.com/', partition: 'persist:grok', hosts: ['grok.com', 'accounts.x.ai', 'x.com', 'auth.x.ai', 'auth.grokusercontent.com', 'auth.cursor.com'] })
  assert.deepEqual(SITES.gemini, { url: 'https://gemini.google.com/app', newChatUrl: 'https://gemini.google.com/app', partition: 'persist:gemini', hosts: ['gemini.google.com'] })
  assert.deepEqual([...SSO_HOSTS], ['accounts.google.com', 'accounts.youtube.com', 'login.live.com', 'login.microsoftonline.com', 'appleid.apple.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.x.ai', 'x.com', 'twitter.com', 'api.twitter.com', 'challenges.cloudflare.com'])
})

test('one site vocabulary: sites.js SLOTS deep-equals protocol.js SLOT_IDS and site.cjs SLOTS (the JS twin of vendors.py WEB_SITES == BRIDGE_SLOTS), in catalog order', () => {
  assert.deepEqual([...SLOTS], [...SLOT_IDS], 'the bridge vocabulary (protocol.js)')
  assert.deepEqual([...SLOTS], [...siteAdapter.SLOTS], 'the site adapter (preload/site.cjs)')
  assert.equal(WEB_SITES, SLOTS, 'the council web targets are the sites themselves')
  for (const slot of SLOTS) {
    assert.ok(SITES[slot], `${slot} has a site entry`)
    assert.equal(typeof SITE_LABELS[slot], 'string', `${slot} has a menu label`)
  }
  assert.deepEqual(Object.keys(SITES).sort(), [...SLOTS].sort(), 'no site entry without a slot')
})

test('gemini hosts are exact: gemini.google.com and its subdomains stay in the pane; google.com, www.google.com and sites.google.com do not; Google sign-in rides SSO_HOSTS', () => {
  assert.equal(hostInList('gemini.google.com', SITES.gemini.hosts), true)
  for (const outside of ['google.com', 'www.google.com', 'sites.google.com', 'accounts.google.com', 'gemini.google.com.evil', 'notgemini.google.com']) {
    assert.equal(hostInList(outside, SITES.gemini.hosts), false, `${outside} is not a gemini host`)
  }
  for (const site of SLOTS) assert.ok(!SITES[site].hosts.includes('google.com'), `${site}: never bare google.com`)
  assert.ok(SSO_HOSTS.includes('accounts.google.com') && SSO_HOSTS.includes('accounts.youtube.com'), 'Google sign-in is an SSO host for every pane')
})

test('resolveSites: defaults, grok surface, TRIPLEX_SITES_JSON deep-merge (arrays replace), validation', () => {
  assert.deepEqual(resolveSites({}), SITES)
  assert.notEqual(resolveSites({}).grok, SITES.grok, 'a copy')
  const x = resolveSites({ TRIPLEX_GROK_SURFACE: 'x.com' })
  assert.equal(x.grok.url, 'https://x.com/i/grok')
  assert.equal(x.grok.newChatUrl, 'https://x.com/i/grok')
  const fake = resolveSites({ TRIPLEX_SITES_JSON: JSON.stringify({ claude: { url: 'http://127.0.0.1:5199/?site=claude', hosts: ['127.0.0.1'] } }) })
  assert.equal(fake.claude.url, 'http://127.0.0.1:5199/?site=claude')
  assert.equal(fake.claude.newChatUrl, 'https://claude.ai/new')
  assert.deepEqual(fake.claude.hosts, ['127.0.0.1'])
  assert.deepEqual(fake.chatgpt, SITES.chatgpt)
  assert.throws(() => resolveSites({ TRIPLEX_SITES_JSON: '{bad' }), /not valid JSON/)
  assert.throws(() => resolveSites({ TRIPLEX_SITES_JSON: '[]' }), /JSON object/)
  assert.throws(() => resolveSites({ TRIPLEX_SITES_JSON: JSON.stringify({ bing: {} }) }), /unknown slot/)
  assert.throws(() => resolveSites({ TRIPLEX_SITES_JSON: JSON.stringify({ grok: { url: '' } }) }), /url must be/)
  assert.throws(() => resolveSites({ TRIPLEX_SITES_JSON: JSON.stringify({ grok: { hosts: 'grok.com' } }) }), /hosts must be/)
})

test('nonLoopbackSiteUrls lists every non-local url/newChatUrl, then every non-loopback trusted host (E2E refusal); publicSites drops hosts', () => {
  const all = nonLoopbackSiteUrls(resolveSites({}))
  assert.deepEqual(all.slice(0, 8).map((e) => `${e.slot}.${e.key}`), ['claude.url', 'claude.newChatUrl', 'chatgpt.url', 'chatgpt.newChatUrl', 'grok.url', 'grok.newChatUrl', 'gemini.url', 'gemini.newChatUrl'], 'URLs first, in SLOTS order')
  assert.deepEqual(all.slice(8).map((e) => `${e.slot}.${e.key}=${e.url}`), [...SITES.claude.hosts.map((h) => `claude.hosts=${h}`), ...SITES.chatgpt.hosts.map((h) => `chatgpt.hosts=${h}`), ...SITES.grok.hosts.map((h) => `grok.hosts=${h}`), 'gemini.hosts=gemini.google.com'], 'then the trusted hosts')
  const local = {}
  for (const s of SLOTS) local[s] = { url: `http://127.0.0.1:5199/?site=${s}`, newChatUrl: `http://localhost:5199/?site=${s}`, partition: `persist:${s}`, hosts: ['127.0.0.1'] }
  assert.deepEqual(nonLoopbackSiteUrls(local), [])
  local.claude.hosts = ['127.0.0.1', 'LOCALHOST.', '[::1]', '::1']
  assert.deepEqual(nonLoopbackSiteUrls(local), [], 'every loopback spelling counts')
  local.grok.newChatUrl = 'https://grok.com/'
  assert.deepEqual(nonLoopbackSiteUrls(local), [{ slot: 'grok', key: 'newChatUrl', url: 'https://grok.com/' }])
  local.grok.newChatUrl = 'not a url'
  assert.equal(nonLoopbackSiteUrls(local).length, 1)
  local.grok.newChatUrl = 'http://127.0.0.1:5199/'
  // loopback URLs but the real hosts (a partial TRIPLEX_SITES_JSON): policy.js would trust chatgpt.com
  local.chatgpt.hosts = ['chatgpt.com']
  assert.deepEqual(nonLoopbackSiteUrls(local), [{ slot: 'chatgpt', key: 'hosts', url: 'chatgpt.com' }])
  local.claude.hosts = ['claude.ai']
  local.grok.url = 'https://grok.com/'
  assert.deepEqual(nonLoopbackSiteUrls(local).map((e) => `${e.slot}.${e.key}`), ['grok.url', 'claude.hosts', 'chatgpt.hosts'], 'a bad URL is always reported before a bad host')
  local.claude.hosts = ['127.0.0.1']
  local.chatgpt.hosts = ['127.0.0.1']
  local.grok.url = 'http://127.0.0.1:5199/'
  assert.deepEqual(publicSites(resolveSites({})).claude, { url: 'https://claude.ai/new', newChatUrl: 'https://claude.ai/new', partition: 'persist:claude' })
  assert.deepEqual(Object.keys(publicSites(resolveSites({}))), ['claude', 'chatgpt', 'grok', 'gemini'])
  // an E2E run that points only three sites at the fake site is refused on the fourth (app.spec.js lists gemini too)
  const three = resolveSites({ TRIPLEX_SITES_JSON: JSON.stringify(Object.fromEntries(['claude', 'chatgpt', 'grok'].map((s) => [s, { url: `http://127.0.0.1:5199/?site=${s}`, newChatUrl: `http://127.0.0.1:5199/?site=${s}`, hosts: ['127.0.0.1'] }]))) })
  assert.deepEqual(nonLoopbackSiteUrls(three).map((e) => `${e.slot}.${e.key}`), ['gemini.url', 'gemini.newChatUrl', 'gemini.hosts'])
})

test('hostInList / deepMerge helpers', () => {
  assert.equal(hostInList('www.chatgpt.com', SITES.chatgpt.hosts), true)
  assert.equal(hostInList('chatgpt.com.evil', SITES.chatgpt.hosts), false)
  assert.equal(hostInList('CHATGPT.COM.', SITES.chatgpt.hosts), true)
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } }), { a: { b: 1, c: [2], d: 3 } })
})
