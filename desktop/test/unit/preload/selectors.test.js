// site.cjs pure exports: SLOTS, DEFAULT_SELECTORS shape (every chatUrlPattern compiles; the v1 keys
// plus the selectors v2 keys of Stage 2, contract §4 verbatim), mergeSelectors({merged, warnings})
// incl. "a v2 merge keeps the v1 keys", siteFor, hostMatches, siteSelectors. Plain node:test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { SLOTS, DEFAULT_SELECTORS, mergeSelectors, siteFor, hostMatches, siteSelectors, SESSION_STATES, REJECT_STATES, RESULT_CODES } = require('../../../preload/site.cjs')

const LIST_KEYS = ['composer', 'send', 'loggedOut', 'loggedOutUrl', 'challenge', 'challengeTitle', 'errorText']
const MS_KEYS = ['composerWaitMs', 'sendWaitMs', 'submitVerifyMs']
/** Selectors v2 (Stage 2, contract §4), additive per site; the list keys may be empty (empty stop + done ⇒ quiet detection). */
const V2_LIST_KEYS = ['stop', 'assistant', 'assistantText', 'done']
const V2_MS_KEYS = ['quietMs', 'settleMs', 'firstTokenMs', 'captureTimeoutMs']
const V1_KEYS = ['chatUrlPattern', ...LIST_KEYS, ...MS_KEYS]
const V2_KEYS = [...V2_LIST_KEYS, ...V2_MS_KEYS]
const SAMPLE_CHAT_URL = {
  chatgpt: 'https://chatgpt.com/c/68c1a2b3-4d5e-6f70-8a9b-0c1d2e3f4a5b',
  claude: 'https://claude.ai/chat/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
  grok: 'https://grok.com/c/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d',
}
const SAMPLE_HOME_URL = { chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new', grok: 'https://grok.com/' }

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')

test('SLOTS is the frozen slot order and the states/codes match contract §1/§2', () => {
  assert.deepEqual(SLOTS, ['claude', 'chatgpt', 'grok'])
  assert.ok(Object.isFrozen(SLOTS))
  assert.deepEqual(SESSION_STATES, ['ok', 'logged_out', 'challenge', 'blocked', 'unknown'])
  assert.deepEqual(REJECT_STATES, ['logged_out', 'challenge', 'blocked'])
  assert.deepEqual(
    [...RESULT_CODES].sort(),
    ['blocked', 'busy', 'cancelled', 'challenge', 'composer_not_found', 'logged_out', 'not_submitted', 'reply_not_found', 'send_not_found', 'site_error', 'timeout'],
  )
})

test('DEFAULT_SELECTORS stays version 1 with exactly the three sites (v2 is additive per site; main\'s loader pins the version check, so an override written against v1 keeps working)', () => {
  assert.equal(DEFAULT_SELECTORS.version, 1)
  assert.deepEqual(Object.keys(DEFAULT_SELECTORS).sort(), ['chatgpt', 'claude', 'grok', 'version'])
  const { warnings } = mergeSelectors(DEFAULT_SELECTORS, { version: 1, chatgpt: { stop: ['button.x'] } })
  assert.deepEqual(warnings, [])
})

for (const site of SLOTS) {
  test(`DEFAULT_SELECTORS.${site}: composer/send cascades, wall detection lists, timeouts`, () => {
    const s = DEFAULT_SELECTORS[site]
    assert.deepEqual(Object.keys(s).sort(), [...V1_KEYS, ...V2_KEYS].sort())
    for (const k of LIST_KEYS) assert.ok(isStringList(s[k]), `${site}.${k} must be a non-empty-string list`)
    for (const k of V2_LIST_KEYS) assert.ok(Array.isArray(s[k]) && s[k].every((x) => typeof x === 'string' && x !== ''), `${site}.${k} must be a list of non-empty strings`)
    assert.ok(s.composer.length >= 1 && s.send.length >= 1, `${site}: composer and send must have entries`)
    for (const k of [...MS_KEYS, ...V2_MS_KEYS]) assert.ok(Number.isInteger(s[k]) && s[k] > 0, `${site}.${k} must be a positive integer`)
    assert.ok(s.assistant.length >= 1, `${site}: the assistant cascade must have entries (the observe baseline)`)
    assert.equal(new Set(s.composer).size, s.composer.length, `${site}.composer has duplicates`)
    assert.equal(new Set(s.send).size, s.send.length, `${site}.send has duplicates`)
  })

  test(`DEFAULT_SELECTORS.${site}.chatUrlPattern compiles, matches a chat URL and not the home URL`, () => {
    const re = new RegExp(DEFAULT_SELECTORS[site].chatUrlPattern)
    assert.ok(re.test(SAMPLE_CHAT_URL[site]), `${site}: ${re} should match ${SAMPLE_CHAT_URL[site]}`)
    assert.ok(!re.test(SAMPLE_HOME_URL[site]), `${site}: ${re} must not match ${SAMPLE_HOME_URL[site]}`)
  })
}

/**
 * chatgpt.com mounts a PLACEHOLDER chat url `/c/WEB:<uuid>` while the first reply streams and only then
 * replaces it with the real `/c/<uuid>` (MEASURED live, 2026-09-17; the placeholder 404s back to the home
 * page when revisited). The pattern therefore ends the id at the segment — `(?:[?#]|$)` — so the
 * placeholder matches nothing and main records only the real link.
 */
test('chatgpt.chatUrlPattern ends the id at the segment: it rejects the /c/WEB:<uuid> placeholder and accepts /c/<uuid> bare, with a query and with a fragment', () => {
  const re = () => new RegExp(DEFAULT_SELECTORS.chatgpt.chatUrlPattern)
  const uuid = '68c1a2b3-4d5e-6f70-8a9b-0c1d2e3f4a5b'
  assert.ok(!re().test(`https://chatgpt.com/c/WEB:${uuid}`), 'the WEB: placeholder must not match')
  assert.ok(!re().test(`https://chatgpt.com/c/WEB:${uuid}?model=auto`))
  assert.ok(!re().test('https://chatgpt.com/c/WEB:'))
  assert.ok(re().test(`https://chatgpt.com/c/${uuid}`))
  assert.ok(re().test(`https://chatgpt.com/c/${uuid}?model=auto`))
  assert.ok(re().test(`https://chatgpt.com/c/${uuid}#top`))
  assert.ok(!re().test('https://chatgpt.com/c/'))
  assert.ok(!re().test('https://chatgpt.com/'))
  // the id itself is still allowed to carry dashes only: a colon (or any other segment junk) ends the match
  assert.ok(!re().test(`https://chatgpt.com/c/${uuid}:extra`))
})

test('the placeholder shape is rejected on every site: claude through its hex-only id, grok and chatgpt through the segment-end rule', () => {
  const uuid = '8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d'
  // claude: `[0-9a-f-]+` cannot start at "W", so a placeholder of that shape could never be recorded
  assert.ok(!new RegExp(DEFAULT_SELECTORS.claude.chatUrlPattern).test(`https://claude.ai/chat/WEB:${uuid}`))
  assert.ok(new RegExp(DEFAULT_SELECTORS.claude.chatUrlPattern).test(`https://claude.ai/chat/${uuid}`))
  // grok carries the same segment-end rule as chatgpt. Nothing like the chatgpt placeholder has been
  // measured on grok.com; the rule is applied for symmetry, because a recorded link that 404s is
  // silent (the pane just opens the wrong chat) and the rule costs nothing on a real id.
  assert.ok(!new RegExp(DEFAULT_SELECTORS.grok.chatUrlPattern).test(`https://grok.com/c/WEB:${uuid}`))
  assert.ok(new RegExp(DEFAULT_SELECTORS.grok.chatUrlPattern).test(`https://grok.com/c/${uuid}`))
})

test('the chatgpt/claude/grok cascades start with the entries the fake site is built around', () => {
  assert.equal(DEFAULT_SELECTORS.chatgpt.composer[0], '#prompt-textarea')
  assert.equal(DEFAULT_SELECTORS.chatgpt.send[0], "button[data-testid='send-button']")
  assert.equal(DEFAULT_SELECTORS.claude.composer[0], "div[contenteditable='true'].ProseMirror")
  assert.equal(DEFAULT_SELECTORS.claude.send[0], "button[aria-label='Send message']")
  assert.equal(DEFAULT_SELECTORS.grok.composer[0], "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']")
  assert.equal(DEFAULT_SELECTORS.grok.send[0], "button[data-testid='chat-submit']")
})

test('DEFAULT_SELECTORS.grok is contract §4 verbatim (verified live on grok.com, 2026-09-16): TipTap composer first, chat-submit first, no bare textarea fallback', () => {
  const grok = DEFAULT_SELECTORS.grok
  // copied from docs/desktop-contract.md §4
  assert.deepEqual(grok.composer, [
    "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']",
    "div[role='textbox'][aria-label='Ask Grok anything']",
    "div.ProseMirror[contenteditable='true']",
    "textarea[aria-label='Ask Grok anything']",
    "textarea[placeholder*='Grok']",
    "div[contenteditable='true'][data-lexical-editor='true']",
  ])
  assert.deepEqual(grok.send, ["button[data-testid='chat-submit']", "button[aria-label='Submit']", "button[type='submit']"])
  // grok.com carries a hidden 14 px helper <textarea>: a bare tag entry would pick it and the prompt would vanish
  assert.ok(!grok.composer.includes('textarea'))
  assert.ok(grok.composer.every((s) => /[[.#]/.test(s)), 'every grok composer entry is qualified, never a bare tag')
  // every other key is untouched
  assert.equal(grok.chatUrlPattern, '^https://grok\\.com/(c|chat)/[A-Za-z0-9-]+(?:[?#]|$)')
  assert.deepEqual(grok.loggedOut, ["a[href*='/sign-in']", "a[href*='accounts.x.ai']"])
  assert.deepEqual(grok.loggedOutUrl, ['accounts.x.ai', '/sign-in'])
  assert.deepEqual(grok.challenge, ["iframe[src*='challenges.cloudflare.com']"])
  assert.deepEqual(grok.challengeTitle, ['Just a moment'])
  assert.deepEqual(grok.errorText, ['unusual activity'])
  assert.deepEqual([grok.composerWaitMs, grok.sendWaitMs, grok.submitVerifyMs], [15000, 18000, 5000])
  // v2 (Stage 2)
  assert.deepEqual(grok.stop, ["button[aria-label='Stop']", "button[aria-label*='Stop']"])
  assert.deepEqual(grok.assistant, ["div[id^='response-']"])
  assert.deepEqual(grok.assistantText, ['.response-content-markdown'])
  assert.deepEqual(grok.done, [])
  assert.deepEqual([grok.quietMs, grok.settleMs, grok.firstTokenMs, grok.captureTimeoutMs], [2500, 400, 90000, 300000])
})

test('DEFAULT_SELECTORS v2 entries are contract §4 verbatim for chatgpt and claude (grok above); empty stop + done ⇒ quiet detection', () => {
  const { chatgpt, claude } = DEFAULT_SELECTORS
  assert.deepEqual(chatgpt.stop, ["button[data-testid='stop-button']", "button[aria-label='Stop streaming']", "button[aria-label='Stop answering']"])
  assert.deepEqual(chatgpt.assistant, ["[data-message-author-role='assistant']"])
  // measured 2026-09-17: `.markdown` (and `.prose`) match on chatgpt.com, `.whitespace-pre-wrap` does
  // NOT any more — it stays as a last fallback because an entry that matches nothing costs nothing
  assert.deepEqual(chatgpt.assistantText, ['.markdown', '.whitespace-pre-wrap'])
  assert.deepEqual(chatgpt.done, ["button[data-testid='copy-turn-action-button']"])
  assert.deepEqual(claude.stop, ["button[aria-label='Stop response']", "button[aria-label*='Stop']"])
  assert.deepEqual(claude.assistant, ['.font-claude-response:not(#markdown-artifact)', '.font-claude-message'])
  // S8 (contract §4 change request): claude's reply BODY, not the whole turn. Measured 2026-09-17 —
  // a `.prose` element inside `.font-claude-response` holds 2717 of its 2754 innerText characters —
  // and forced by the 2026-09-18 capture, where the empty cascade made `replyText` fall back to the
  // container and claude's thinking widget contributed its summary line TWICE before the answer.
  assert.deepEqual(claude.assistantText, ['.prose'])
  assert.deepEqual(claude.done, [])
  for (const site of SLOTS) assert.deepEqual([DEFAULT_SELECTORS[site].quietMs, DEFAULT_SELECTORS[site].firstTokenMs, DEFAULT_SELECTORS[site].captureTimeoutMs], [2500, 90000, 300000])
  // S10: the settle window after an end signal is per site — chatgpt holds a long answer far longer
  // between two renders than the four throttle ticks every other site settles for.
  assert.deepEqual(SLOTS.map((s) => DEFAULT_SELECTORS[s].settleMs), [400, 1200, 400])
  // every v2 selector compiles (a bad selector would be skipped silently at runtime)
  for (const site of SLOTS) for (const k of V2_LIST_KEYS) for (const s of DEFAULT_SELECTORS[site][k]) assert.doesNotThrow(() => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('mergeSelectors: a v2 merge keeps every v1 key, a v1 merge keeps every v2 key, and a v1-shaped full config gains the v2 defaults', () => {
  const v2Only = mergeSelectors(DEFAULT_SELECTORS, { chatgpt: { stop: ['button.my-stop'], done: [], quietMs: 999 } })
  assert.deepEqual(v2Only.warnings, [])
  assert.deepEqual(v2Only.merged.chatgpt.stop, ['button.my-stop'])
  assert.deepEqual(v2Only.merged.chatgpt.done, [])
  assert.equal(v2Only.merged.chatgpt.quietMs, 999)
  for (const k of V1_KEYS) assert.deepEqual(v2Only.merged.chatgpt[k], DEFAULT_SELECTORS.chatgpt[k], `v1 key ${k} kept`)
  assert.deepEqual(v2Only.merged.chatgpt.assistant, DEFAULT_SELECTORS.chatgpt.assistant)
  assert.deepEqual(v2Only.merged.claude, DEFAULT_SELECTORS.claude)

  const v1Only = mergeSelectors(DEFAULT_SELECTORS, { claude: { composer: ['#mine'], errorText: [] } })
  assert.deepEqual(v1Only.warnings, [])
  assert.deepEqual(v1Only.merged.claude.composer, ['#mine'])
  for (const k of V2_KEYS) assert.deepEqual(v1Only.merged.claude[k], DEFAULT_SELECTORS.claude[k], `v2 key ${k} kept`)

  // a full config written against v1 (every v1 key, no v2 key) — e.g. main's last good config from an older file
  const v1Shaped = { version: 1 }
  for (const site of SLOTS) v1Shaped[site] = Object.fromEntries(V1_KEYS.map((k) => [k, DEFAULT_SELECTORS[site][k]]))
  const { merged, warnings } = mergeSelectors(DEFAULT_SELECTORS, v1Shaped)
  assert.deepEqual(warnings, [])
  assert.deepEqual(merged, DEFAULT_SELECTORS)
  for (const site of SLOTS) assert.deepEqual(Object.keys(merged[site]).sort(), [...V1_KEYS, ...V2_KEYS].sort())

  // an empty stop + done pair is a legal override (quiet detection), a non-list is not
  const quiet = mergeSelectors(DEFAULT_SELECTORS, { grok: { stop: [], done: [], assistantText: [] } })
  assert.deepEqual(quiet.warnings, [])
  assert.deepEqual([quiet.merged.grok.stop, quiet.merged.grok.done, quiet.merged.grok.assistantText], [[], [], []])
  // S10: `settleMs` is a known key, so an override of it validates and is applied
  const settle = mergeSelectors(DEFAULT_SELECTORS, { chatgpt: { settleMs: 2500 } })
  assert.deepEqual(settle.warnings, [])
  assert.equal(settle.merged.chatgpt.settleMs, 2500)
  const bad = mergeSelectors(DEFAULT_SELECTORS, { grok: { stop: 'button.stop', quietMs: '2500', settleMs: 'slow', assistant: [1] } })
  assert.deepEqual(bad.merged.grok, DEFAULT_SELECTORS.grok)
  assert.deepEqual(bad.warnings.sort(), ['grok.assistant: expected a list of strings', 'grok.quietMs: expected number, got string', 'grok.settleMs: expected number, got string', 'grok.stop: expected array, got string'])
})

test('mergeSelectors: no override → an equal deep copy, no warnings, defaults untouched', () => {
  const snapshot = JSON.stringify(DEFAULT_SELECTORS)
  for (const override of [undefined, null]) {
    const { merged, warnings } = mergeSelectors(DEFAULT_SELECTORS, override)
    assert.deepEqual(merged, DEFAULT_SELECTORS)
    assert.notEqual(merged, DEFAULT_SELECTORS)
    assert.notEqual(merged.chatgpt, DEFAULT_SELECTORS.chatgpt)
    assert.notEqual(merged.chatgpt.composer, DEFAULT_SELECTORS.chatgpt.composer)
    assert.deepEqual(warnings, [])
  }
  assert.equal(JSON.stringify(DEFAULT_SELECTORS), snapshot)
})

test('mergeSelectors: an override REPLACES per site per key (arrays and numbers), other keys and sites stay', () => {
  const snapshot = JSON.stringify(DEFAULT_SELECTORS)
  const { merged, warnings } = mergeSelectors(DEFAULT_SELECTORS, {
    version: 1,
    chatgpt: { composer: ['#mine'], sendWaitMs: 1234 },
    grok: { errorText: [] },
  })
  assert.deepEqual(warnings, [])
  assert.deepEqual(merged.chatgpt.composer, ['#mine'])
  assert.equal(merged.chatgpt.sendWaitMs, 1234)
  assert.deepEqual(merged.chatgpt.send, DEFAULT_SELECTORS.chatgpt.send)
  assert.deepEqual(merged.grok.errorText, [])
  assert.deepEqual(merged.claude, DEFAULT_SELECTORS.claude)
  assert.equal(merged.version, 1)
  assert.equal(JSON.stringify(DEFAULT_SELECTORS), snapshot)
})

test('mergeSelectors: unknown sites/keys, type mismatches, non-string lists and a wrong version warn and are skipped', () => {
  const { merged, warnings } = mergeSelectors(DEFAULT_SELECTORS, {
    version: 2,
    gemini: { composer: ['x'] },
    chatgpt: { reply: ['button.reply'], composer: '#not-a-list', sendWaitMs: '5', send: ['ok', 42] },
    claude: 'nope',
  })
  assert.deepEqual(merged, DEFAULT_SELECTORS)
  assert.deepEqual(warnings.sort(), [
    'chatgpt.composer: expected array, got string',
    'chatgpt.reply: unknown key',
    'chatgpt.send: expected a list of strings',
    'chatgpt.sendWaitMs: expected number, got string',
    'claude: expected an object',
    'gemini: unknown site',
    'version: expected 1, got 2',
  ])
})

test('mergeSelectors: a non-object override warns and keeps the defaults; merged never aliases the override', () => {
  for (const bad of [42, 'x', [1], true]) {
    const { merged, warnings } = mergeSelectors(DEFAULT_SELECTORS, bad)
    assert.deepEqual(merged, DEFAULT_SELECTORS)
    assert.deepEqual(warnings, ['override: expected a JSON object'])
  }
  const override = { grok: { composer: ['textarea#g'] } }
  const { merged } = mergeSelectors(DEFAULT_SELECTORS, override)
  override.grok.composer.push('mutated later')
  assert.deepEqual(merged.grok.composer, ['textarea#g'])
})

const SITES = {
  chatgpt: { hosts: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com', 'auth0.openai.com'] },
  claude: { hosts: ['claude.ai'] },
  grok: { hosts: ['grok.com', 'accounts.x.ai', 'x.com'] },
}

test('siteFor maps hosts and their subdomains to slots, case-insensitively, null when unknown', () => {
  assert.equal(siteFor('chatgpt.com', SITES), 'chatgpt')
  assert.equal(siteFor('www.chatgpt.com', SITES), 'chatgpt')
  assert.equal(siteFor('auth0.openai.com', SITES), 'chatgpt')
  assert.equal(siteFor('claude.ai', SITES), 'claude')
  assert.equal(siteFor('CLAUDE.AI.', SITES), 'claude')
  assert.equal(siteFor('grok.com', SITES), 'grok')
  assert.equal(siteFor('accounts.x.ai', SITES), 'grok')
  assert.equal(siteFor('x.com', SITES), 'grok')
  assert.equal(siteFor('example.com', SITES), null)
  assert.equal(siteFor('notclaude.ai', SITES), null) // suffix without a dot boundary is not a subdomain
  assert.equal(siteFor('accounts.google.com', SITES), null)
})

test('siteFor tolerates bad input and honours the fake-site table', () => {
  assert.equal(siteFor(undefined, SITES), null)
  assert.equal(siteFor('chatgpt.com', null), null)
  assert.equal(siteFor('chatgpt.com', { chatgpt: {} }), null)
  const fake = { chatgpt: { hosts: ['127.0.0.1'] }, claude: { hosts: ['127.0.0.1'] }, grok: { hosts: ['127.0.0.1'] } }
  assert.equal(siteFor('127.0.0.1', fake), 'claude') // SLOTS order decides a tie
  assert.equal(siteFor('localhost', { extra: { hosts: ['localhost'] } }), 'extra')
})

test('hostMatches: exact or subdomain, never a bare suffix, never non-strings', () => {
  assert.ok(hostMatches('a.b.example.com', 'example.com'))
  assert.ok(hostMatches('Example.COM', 'example.com'))
  assert.ok(!hostMatches('badexample.com', 'example.com'))
  assert.ok(!hostMatches(null, 'example.com'))
  assert.ok(!hostMatches('example.com', undefined))
})

test('siteSelectors picks the site block from a full config, accepts a bare block, falls back to the defaults', () => {
  assert.equal(siteSelectors(DEFAULT_SELECTORS, 'grok'), DEFAULT_SELECTORS.grok)
  const block = { composer: ['#x'], send: ['#y'] }
  assert.equal(siteSelectors(block, 'chatgpt'), block)
  assert.equal(siteSelectors(undefined, 'claude'), DEFAULT_SELECTORS.claude)
  assert.equal(siteSelectors({ version: 1 }, 'claude'), DEFAULT_SELECTORS.claude)
  assert.equal(siteSelectors(undefined, 'gemini'), null)
  assert.equal(siteSelectors(undefined, null), null)
})
