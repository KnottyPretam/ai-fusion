// sites.js — the contract §5 table, TRIPLEX_SITES_JSON deep-merge, TRIPLEX_GROK_SURFACE, the
// loopback refusal helper and the public projection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SLOTS, SITES, SSO_HOSTS, resolveSites, nonLoopbackSiteUrls, publicSites, hostInList, deepMerge } from '../../../main/sites.js'

test('SITES / SSO_HOSTS match contract §5', () => {
  assert.deepEqual([...SLOTS], ['claude', 'chatgpt', 'grok'])
  assert.deepEqual(SITES.chatgpt, { url: 'https://chatgpt.com/', newChatUrl: 'https://chatgpt.com/', partition: 'persist:chatgpt', hosts: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com', 'auth0.openai.com'] })
  assert.deepEqual(SITES.claude, { url: 'https://claude.ai/new', newChatUrl: 'https://claude.ai/new', partition: 'persist:claude', hosts: ['claude.ai'] })
  assert.deepEqual(SITES.grok, { url: 'https://grok.com/', newChatUrl: 'https://grok.com/', partition: 'persist:grok', hosts: ['grok.com', 'accounts.x.ai', 'x.com'] })
  assert.deepEqual([...SSO_HOSTS], ['accounts.google.com', 'accounts.youtube.com', 'login.live.com', 'login.microsoftonline.com', 'appleid.apple.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.x.ai', 'x.com', 'twitter.com', 'api.twitter.com', 'challenges.cloudflare.com'])
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

test('nonLoopbackSiteUrls lists every non-local url/newChatUrl (E2E refusal); publicSites drops hosts', () => {
  assert.deepEqual(nonLoopbackSiteUrls(resolveSites({})).map((e) => `${e.slot}.${e.key}`), ['claude.url', 'claude.newChatUrl', 'chatgpt.url', 'chatgpt.newChatUrl', 'grok.url', 'grok.newChatUrl'])
  const local = {}
  for (const s of SLOTS) local[s] = { url: `http://127.0.0.1:5199/?site=${s}`, newChatUrl: `http://localhost:5199/?site=${s}`, partition: `persist:${s}`, hosts: ['127.0.0.1'] }
  assert.deepEqual(nonLoopbackSiteUrls(local), [])
  local.grok.newChatUrl = 'https://grok.com/'
  assert.deepEqual(nonLoopbackSiteUrls(local), [{ slot: 'grok', key: 'newChatUrl', url: 'https://grok.com/' }])
  local.grok.newChatUrl = 'not a url'
  assert.equal(nonLoopbackSiteUrls(local).length, 1)
  assert.deepEqual(publicSites(resolveSites({})).claude, { url: 'https://claude.ai/new', newChatUrl: 'https://claude.ai/new', partition: 'persist:claude' })
  assert.deepEqual(Object.keys(publicSites(resolveSites({}))), ['claude', 'chatgpt', 'grok'])
})

test('hostInList / deepMerge helpers', () => {
  assert.equal(hostInList('www.chatgpt.com', SITES.chatgpt.hosts), true)
  assert.equal(hostInList('chatgpt.com.evil', SITES.chatgpt.hosts), false)
  assert.equal(hostInList('CHATGPT.COM.', SITES.chatgpt.hosts), true)
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } }), { a: { b: 1, c: [2], d: 3 } })
})
