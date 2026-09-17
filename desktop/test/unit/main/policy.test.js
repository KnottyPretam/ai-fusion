// policy.js — the popup / will-navigate / will-redirect matrix of contract §5, child windows policed
// recursively, the renderer window's origin guard, the foreign-frame IPC check and the backstop
// for webContents nobody policed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  popupDecision,
  isAllowedPopup,
  navigationDecision,
  isAllowedNavigation,
  isExternalUrl,
  attachPolicy,
  attachOriginPolicy,
  attachDefaultDenyPolicy,
  frameOriginMatches,
  originOf,
  isPoliced,
  isSiteUrl,
} from '../../../main/policy.js'
import { SITES } from '../../../main/sites.js'
import { fakeWebContents, fakeChildWindow, navEvent, fakeLog } from './_fakes.js'

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
  assert.equal(isPoliced(wc), true)
})

test('attachPolicy: a server-side redirect of the main frame follows the same matrix; sub-frame redirects are not ours', () => {
  const wc = fakeWebContents()
  const opened = []
  const { onWillRedirect } = attachPolicy(wc, claude, { openExternal: (u) => opened.push(u) })
  const redirect = (url, isMainFrame = true) => {
    const e = navEvent(url)
    wc.emit('will-redirect', e, url, false, isMainFrame)
    return e.prevented
  }
  assert.equal(redirect('https://claude.ai/login'), false)
  assert.equal(redirect('https://accounts.google.com/signin'), false)
  assert.equal(redirect('https://evil.example/'), true, 'a 302 off the allow-list is prevented (the whole navigation)')
  assert.deepEqual(opened, ['https://evil.example/'])
  assert.equal(redirect('https://evil.example/frame', false), false, 'an iframe redirect is left to the page')
  assert.equal(opened.length, 1)
  // the Electron ≥ 30 shape: details.url / details.isMainFrame without the deprecated positionals
  const details = navEvent('https://evil.example/d', { isMainFrame: true })
  onWillRedirect(details)
  assert.equal(details.prevented, true)
  const sub = navEvent('https://evil.example/s', { isMainFrame: false })
  onWillRedirect(sub)
  assert.equal(sub.prevented, false)
})

test('attachPolicy: an allowed child window (SSO / site popup) is policed like its opener, recursively', () => {
  const wc = fakeWebContents()
  const opened = []
  attachPolicy(wc, chatgpt, { openExternal: (u) => opened.push(u), childWindowOptions: { autoHideMenuBar: true } })
  const child = fakeChildWindow()
  assert.equal(child.webContents.windowOpenHandler, null)
  wc.emit('did-create-window', child, { url: 'https://accounts.google.com/o/oauth2' })
  assert.equal(typeof child.webContents.windowOpenHandler, 'function')
  assert.equal(isPoliced(child.webContents), true)
  assert.deepEqual(child.webContents.windowOpenHandler({ url: 'https://evil.example/' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://evil.example/'])
  assert.deepEqual(child.webContents.windowOpenHandler({ url: 'https://chatgpt.com/share/x' }), { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } })
  assert.deepEqual(child.webContents.windowOpenHandler({ url: 'javascript:1' }), { action: 'deny' })
  const bad = navEvent('https://evil.example/2')
  child.webContents.emit('will-navigate', bad, bad.url)
  assert.equal(bad.prevented, true)
  const hop = navEvent('https://auth.openai.com/callback')
  child.webContents.emit('will-navigate', hop, hop.url)
  assert.equal(hop.prevented, false, 'an OAuth hop between listed hosts stays in the popup')
  const redirect = navEvent('https://evil.example/r')
  child.webContents.emit('will-redirect', redirect, redirect.url, false, true)
  assert.equal(redirect.prevented, true)
  assert.deepEqual(opened, ['https://evil.example/', 'https://evil.example/2', 'https://evil.example/r'])
  // a popup of the popup
  const grandchild = fakeChildWindow()
  child.webContents.emit('did-create-window', grandchild, {})
  assert.deepEqual(grandchild.webContents.windowOpenHandler({ url: 'https://evil.example/3' }), { action: 'deny' })
  assert.equal(opened.at(-1), 'https://evil.example/3')
  assert.doesNotThrow(() => wc.emit('did-create-window', null, {}))
  assert.doesNotThrow(() => wc.emit('did-create-window', { webContents: null }, {}))
})

test('ssoHosts override: an empty list (TRIPLEX_E2E_APP=1) sends SSO popups and navigations to the system browser', () => {
  assert.equal(popupDecision('https://accounts.google.com/', claude, []), 'external')
  assert.equal(navigationDecision('https://accounts.google.com/', claude, []), 'external')
  assert.equal(isAllowedPopup('https://accounts.google.com/', claude, []), false)
  assert.equal(isAllowedNavigation('https://accounts.google.com/', claude, []), false)
  assert.equal(popupDecision('https://claude.ai/x', claude, []), 'allow', 'the site\'s own hosts are untouched')
  const wc = fakeWebContents()
  const opened = []
  const { onWindowOpen, onWillNavigate } = attachPolicy(wc, claude, { openExternal: (u) => opened.push(u), ssoHosts: [] })
  assert.deepEqual(onWindowOpen({ url: 'https://accounts.google.com/' }), { action: 'deny' })
  const e = navEvent('https://challenges.cloudflare.com/x')
  onWillNavigate(e, e.url)
  assert.equal(e.prevented, true)
  assert.deepEqual(opened, ['https://accounts.google.com/', 'https://challenges.cloudflare.com/x'])
})

test('attachOriginPolicy: the renderer window never leaves its origin and never opens windows', () => {
  const wc = fakeWebContents()
  const opened = []
  const log = fakeLog()
  const { onWindowOpen } = attachOriginPolicy(wc, 'http://localhost:5184', { openExternal: (u) => opened.push(u), log })
  assert.equal(isPoliced(wc), true)
  const go = (event, url, extra = []) => {
    const e = navEvent(url)
    wc.emit(event, e, url, ...extra)
    return e.prevented
  }
  assert.equal(go('will-navigate', 'http://localhost:5184/#/settings'), false)
  assert.equal(go('will-navigate', 'http://localhost:5184'), false)
  assert.equal(go('will-navigate', 'https://evil.example/'), true)
  assert.equal(go('will-navigate', 'http://localhost:5185/'), true, 'another port is another origin')
  assert.equal(go('will-navigate', 'http://127.0.0.1:5184/'), true, '127.0.0.1 is not localhost')
  assert.equal(go('will-redirect', 'https://evil.example/r', [false, true]), true, 'a 302 elsewhere is prevented too')
  assert.equal(go('will-redirect', 'https://evil.example/sub', [false, false]), false, 'sub-frame redirects are not the main frame')
  assert.equal(go('will-navigate', 'about:blank'), true)
  assert.equal(go('will-navigate', 'javascript:1'), true)
  assert.deepEqual(opened, ['https://evil.example/', 'http://localhost:5185/', 'http://127.0.0.1:5184/', 'https://evil.example/r'], 'only http(s) reaches the system browser')
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('blocked navigation off http://localhost:5184')))
  assert.deepEqual(onWindowOpen({ url: 'https://claude.ai/' }), { action: 'deny' })
  assert.equal(opened.at(-1), 'https://claude.ai/')
  assert.deepEqual(onWindowOpen({ url: 'javascript:1' }), { action: 'deny' })
  assert.equal(opened.length, 5)
  // the Electron ≥ 30 shape (details.url) and a null origin (unparseable renderer URL → prevent everything)
  const details = navEvent('https://evil.example/d')
  wc.emit('will-navigate', details)
  assert.equal(details.prevented, true)
  const strict = fakeWebContents()
  attachOriginPolicy(strict, null, {})
  const e = navEvent('http://localhost:5184/')
  strict.emit('will-navigate', e, e.url)
  assert.equal(e.prevented, true)
  assert.equal(originOf('http://localhost:5184/app/#x'), 'http://localhost:5184')
  assert.equal(originOf('not a url'), null)
})

test('frameOriginMatches: same origin passes, another origin / a disposed frame is refused, fakes without a url pass', () => {
  const origin = 'http://localhost:5184'
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: 'http://localhost:5184/' } }, origin), true)
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: 'http://localhost:5184/app/index.html?x#y' } }, origin), true)
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: 'https://evil.example/' } }, origin), false)
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: 'http://127.0.0.1:5184/' } }, origin), false)
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: '' } }, origin), false)
  assert.equal(frameOriginMatches({ senderFrame: { parent: null, url: 'http://localhost:5184/' } }, null), false, 'no renderer origin → nothing matches')
  assert.equal(frameOriginMatches({ senderFrame: { parent: null } }, origin), true, 'fakes carry no url')
  assert.equal(frameOriginMatches({ sender: {} }, origin), true, 'older events carry no frame')
  assert.equal(frameOriginMatches({ senderFrame: null }, origin), false)
  assert.equal(frameOriginMatches(null, origin), false)
  const disposedEvent = {
    get senderFrame() {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    },
  }
  assert.equal(frameOriginMatches(disposedEvent, origin), false)
  const disposedUrl = {
    senderFrame: {
      parent: null,
      get url() {
        throw new Error('disposed')
      },
    },
  }
  assert.equal(frameOriginMatches(disposedUrl, origin), false)
})

test('attachDefaultDenyPolicy: a webContents nobody policed opens nothing and stays put; a policed one is left alone', () => {
  const stray = fakeWebContents()
  const log = fakeLog()
  const handlers = attachDefaultDenyPolicy(stray, { log })
  assert.equal(typeof handlers.onWindowOpen, 'function')
  assert.deepEqual(stray.windowOpenHandler({ url: 'https://accounts.google.com/' }), { action: 'deny' })
  const e = navEvent('https://claude.ai/')
  stray.emit('will-navigate', e, e.url)
  assert.equal(e.prevented, true)
  const r = navEvent('https://claude.ai/')
  stray.emit('will-redirect', r, r.url, false, true)
  assert.equal(r.prevented, true)
  const sub = navEvent('https://claude.ai/')
  stray.emit('will-redirect', sub, sub.url, false, false)
  assert.equal(sub.prevented, false)
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('unpoliced')))
  assert.equal(isPoliced(stray), false)

  // Electron's order: web-contents-created (backstop) fires inside the constructor, the real
  // policy is attached right after — the backstop must then be inert
  const view = fakeWebContents()
  const opened = []
  attachDefaultDenyPolicy(view)
  attachPolicy(view, claude, { openExternal: (u) => opened.push(u) })
  assert.equal(view.windowOpenHandler({ url: 'https://accounts.google.com/' }).action, 'allow')
  const ok = navEvent('https://claude.ai/new')
  view.emit('will-navigate', ok, ok.url)
  assert.equal(ok.prevented, false)
  const okRedirect = navEvent('https://claude.ai/login')
  view.emit('will-redirect', okRedirect, okRedirect.url, false, true)
  assert.equal(okRedirect.prevented, false)
  const bad = navEvent('https://evil.example/')
  view.emit('will-navigate', bad, bad.url)
  assert.equal(bad.prevented, true)
  assert.deepEqual(opened, ['https://evil.example/'])
  // the same for the renderer window's policy
  const win = fakeWebContents()
  attachDefaultDenyPolicy(win)
  attachOriginPolicy(win, 'http://localhost:5184', {})
  const same = navEvent('http://localhost:5184/')
  win.emit('will-navigate', same, same.url)
  assert.equal(same.prevented, false)
  assert.equal(attachDefaultDenyPolicy(null), null)
  assert.equal(attachDefaultDenyPolicy({}), null)
})

test('isSiteUrl (loadURL bypasses will-navigate): https on the site\'s hosts, http only on loopback, never another scheme', () => {
  const chatgpt = SITES.chatgpt
  assert.equal(isSiteUrl('https://chatgpt.com/c/abc', chatgpt), true)
  assert.equal(isSiteUrl('https://chat.openai.com/c/abc', chatgpt), true)
  assert.equal(isSiteUrl('https://sub.chatgpt.com/', chatgpt), true, 'subdomains')
  assert.equal(isSiteUrl('http://chatgpt.com/c/abc', chatgpt), false, 'plain http on a real host')
  assert.equal(isSiteUrl('https://chatgpt.com.evil.example/', chatgpt), false)
  assert.equal(isSiteUrl('https://claude.ai/chat/1', chatgpt), false, 'another site')
  assert.equal(isSiteUrl('https://accounts.google.com/', chatgpt), false, 'SSO hosts are not chat pages')
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/hostname', 'about:blank', 'chrome://settings', 'ws://chatgpt.com/', '', null, 42, 'not a url']) {
    assert.equal(isSiteUrl(bad, chatgpt), false, String(bad))
  }
  const fake = { hosts: ['127.0.0.1', 'localhost'] }
  assert.equal(isSiteUrl('http://127.0.0.1:5199/c/1?site=claude', fake), true, 'the fake site: http on loopback')
  assert.equal(isSiteUrl('http://localhost:5199/c/1', fake), true)
  assert.equal(isSiteUrl('https://127.0.0.1:5199/c/1', fake), true)
  assert.equal(isSiteUrl('http://evil.example/', fake), false)
  assert.equal(isSiteUrl('http://127.0.0.1:5199/', { hosts: ['chatgpt.com'] }), false, 'loopback still has to be a listed host')
  assert.equal(isSiteUrl('https://anything.example/', null), true, 'no site: the scheme rule alone')
  assert.equal(isSiteUrl('http://anything.example/', null), false)
  assert.equal(isSiteUrl('http://localhost/', null), true)
})
