// policy.js — the popup / will-navigate matrix of contract §5.
import test from 'node:test'
import assert from 'node:assert/strict'
import { popupDecision, isAllowedPopup, navigationDecision, isAllowedNavigation, isExternalUrl, attachPolicy } from '../../../main/policy.js'
import { SITES } from '../../../main/sites.js'
import { fakeWebContents } from './_fakes.js'

const chatgpt = SITES.chatgpt
const claude = SITES.claude

test('popup matrix: SSO host allow, evil.example external, site host allow, javascript:/data: deny', () => {
  assert.equal(popupDecision('https://accounts.google.com/o/oauth2/v2/auth?x=1', claude), 'allow')
  assert.equal(popupDecision('https://evil.example/phish', claude), 'external')
  assert.equal(popupDecision('https://chatgpt.com/share/abc', chatgpt), 'allow')
  assert.equal(popupDecision('https://chat.openai.com/auth', chatgpt), 'allow')
  assert.equal(popupDecision('javascript:alert(1)', chatgpt), 'deny')
  assert.equal(popupDecision('data:text/html,<script>1</script>', chatgpt), 'deny')
  assert.equal(popupDecision('about:blank', chatgpt), 'deny')
  assert.equal(popupDecision('not a url', chatgpt), 'deny')
  assert.equal(isAllowedPopup('https://accounts.google.com/', chatgpt), true)
  assert.equal(isAllowedPopup('https://evil.example/', chatgpt), false)
})

test('popup: subdomains of listed hosts count, look-alikes do not', () => {
  assert.equal(popupDecision('https://www.chatgpt.com/', chatgpt), 'allow')
  assert.equal(popupDecision('https://chatgpt.com.evil.example/', chatgpt), 'external')
  assert.equal(popupDecision('https://notchatgpt.com/', chatgpt), 'external')
  assert.equal(popupDecision('https://challenges.cloudflare.com/turnstile', claude), 'allow')
})

test('popup: another site\'s hosts are not this site\'s hosts', () => {
  assert.equal(popupDecision('https://claude.ai/login', chatgpt), 'external')
  assert.equal(popupDecision('https://grok.com/', claude), 'external')
})

test('will-navigate: site and SSO hosts allowed, off-site external, non-http denied', () => {
  assert.equal(navigationDecision('https://claude.ai/chat/123', claude), 'allow')
  assert.equal(navigationDecision('https://accounts.google.com/signin', claude), 'allow')
  assert.equal(navigationDecision('https://evil.example/', claude), 'external')
  assert.equal(navigationDecision('javascript:void(0)', claude), 'deny')
  assert.equal(navigationDecision('file:///etc/passwd', claude), 'deny')
  assert.equal(isAllowedNavigation('https://claude.ai/', claude), true)
  assert.equal(isAllowedNavigation('https://evil.example/', claude), false)
})

test('isExternalUrl accepts http(s)/mailto only', () => {
  assert.equal(isExternalUrl('https://x.test/'), true)
  assert.equal(isExternalUrl('http://x.test/'), true)
  assert.equal(isExternalUrl('mailto:a@b.test'), true)
  assert.equal(isExternalUrl('javascript:1'), false)
  assert.equal(isExternalUrl('file:///x'), false)
  assert.equal(isExternalUrl(''), false)
})

test('attachPolicy: allowed popups become child windows, external ones go to the opener, denied ones nowhere', () => {
  const wc = fakeWebContents()
  const opened = []
  const { onWindowOpen, onWillNavigate } = attachPolicy(wc, claude, { openExternal: (u) => opened.push(u), childWindowOptions: { autoHideMenuBar: true } })
  assert.equal(typeof wc.windowOpenHandler, 'function')
  assert.deepEqual(onWindowOpen({ url: 'https://accounts.google.com/o/oauth2' }), { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } })
  assert.deepEqual(onWindowOpen({ url: 'https://evil.example/' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://evil.example/'])
  assert.deepEqual(onWindowOpen({ url: 'javascript:alert(1)' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://evil.example/'])

  // will-navigate off-site → preventDefault + external; on-site → untouched; javascript: → prevented, not opened
  const ev = (url) => {
    const e = { prevented: false, url, preventDefault() { this.prevented = true } }
    onWillNavigate(e, url)
    return e
  }
  assert.equal(ev('https://claude.ai/new').prevented, false)
  assert.equal(ev('https://evil.example/x').prevented, true)
  assert.deepEqual(opened, ['https://evil.example/', 'https://evil.example/x'])
  assert.equal(ev('javascript:1').prevented, true)
  assert.equal(opened.length, 2)
})
