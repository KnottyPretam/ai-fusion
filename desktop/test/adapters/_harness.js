// desktop/test/adapters/_harness.js — the shared driving surface of the adapters specs (not a spec:
// Playwright only collects *.spec.js).
//
// Every spec injects the REAL desktop/preload/site.cjs (read from disk, the very file Electron loads
// as the site preload) into a system-Chrome page with `page.addInitScript`, right after an init
// script that installs `window.__triplexFakeIpc` (the shape documented at the top of site.cjs). Ops
// are then driven exactly as main would drive them: a `{reqId, op, ...}` message on
// 'triplex:adapter', the answer read back from 'triplex:adapter:result'. The prompt text is always
// a message field — it is never spliced into code.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const SITE_CJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'preload', 'site.cjs')
export const { DEFAULT_SELECTORS, SLOTS, mergeSelectors, SNAPSHOT_KEEP_ATTRS } = require(SITE_CJS)
export const SITE_SRC = fs.readFileSync(SITE_CJS, 'utf8')

export const CONFIRMED_BY = ['stop_button', 'composer_cleared', 'assistant_count']

/** Backticks, quotes, ${}, a backslash-n literal, newlines (incl. a blank line), a tab, two spaces, unicode, markup. */
export const TRICKY = 'hello `x` "y" \'z\' ${z} \\n\n  line2 with  two spaces\n\n\tline4 — ünïcödé 日本語 🚀 <b>&amp;</b>\nend'

/**
 * Installed by addInitScript BEFORE site.cjs (it runs inside the page: no closure references). The
 * three members site.cjs uses are `invoke`, `on` and `send` (see the boot comment in site.cjs); the
 * rest is the test's own driving surface.
 */
export function installFakeIpc({ site, selectors, dev }) {
  const handlers = new Map()
  const pending = new Map()
  let seq = 0
  const ipc = {
    site,
    selectors,
    dev: !!dev,
    invoked: [],
    sent: [],
    results: [],
    healths: [],
    invoke(channel, ...args) {
      ipc.invoked.push({ channel, args })
      if (channel === 'adapter:config') return Promise.resolve({ site: ipc.site, selectors: ipc.selectors, dev: ipc.dev })
      return Promise.reject(new Error(`fake ipc: unknown channel ${channel}`))
    },
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, [])
      handlers.get(channel).push(handler)
    },
    send(channel, payload) {
      ipc.sent.push({ channel, payload })
      if (channel === 'triplex:adapter:result') {
        ipc.results.push(payload)
        const resolve = pending.get(payload && payload.reqId)
        if (resolve) {
          pending.delete(payload.reqId)
          resolve(payload)
        }
      } else if (channel === 'triplex:adapter:health') {
        ipc.healths.push(payload)
      }
    },
    // --- test side ---
    emit(channel, msg) {
      for (const h of handlers.get(channel) || []) h({ senderId: 0 }, msg)
    },
    request(msg) {
      const reqId = typeof msg.reqId === 'string' ? msg.reqId : `req-${++seq}`
      return new Promise((resolve) => {
        pending.set(reqId, resolve)
        ipc.emit('triplex:adapter', { ...msg, reqId })
      })
    },
    handlerCount(channel) {
      return (handlers.get(channel) || []).length
    },
  }
  window.__triplexFakeIpc = ipc
}

/**
 * Open a fake-site page with the fake IPC + site.cjs installed. `site` is the page's look-alike;
 * `ipcSite` what adapter:config answers (null = inert). The fake site's own query keys are passed
 * through: state, thread, sendDelayMs, composer (grok only), and Stage 2 replyMs / reply / nostop /
 * nodone / blockAfterMs / doneLagMs / twoTurns. `path` picks the page path (the SPA fallback serves
 * index.html for /c/<id>).
 */
export async function open(page, opts = {}) {
  const { site, selectors = DEFAULT_SELECTORS, dev = false, ipcSite = site, path: pagePath = '/', ...query } = opts
  await page.addInitScript(installFakeIpc, { site: ipcSite, selectors, dev })
  await page.addInitScript({ content: SITE_SRC })
  const q = new URLSearchParams({ site })
  for (const key of ['state', 'thread', 'sendDelayMs', 'composer', 'replyMs', 'reply', 'nostop', 'nodone', 'blockAfterMs', 'doneLagMs', 'twoTurns']) {
    if (query[key] !== undefined && query[key] !== null && query[key] !== false && query[key] !== '') q.set(key, String(query[key]))
  }
  await page.goto(`${pagePath}?${q.toString()}`)
}

export const request = (page, msg) => page.evaluate((m) => window.__triplexFakeIpc.request(m), msg)
export const fake = (page) => page.evaluate(() => ({ site: window.__fake.site, state: window.__fake.state, submitted: window.__fake.submitted, text: window.__fake.getText() }))
/** The fake site's Stage 2 reply state. */
export const replyState = (page) =>
  page.evaluate(() => ({
    replying: window.__fake.replying,
    done: window.__fake.done,
    renders: window.__fake.renders,
    rewinds: window.__fake.rewinds,
    containers: window.__fake.containers,
    doneSignalAt: window.__fake.doneSignalAt,
    lastRenderAt: window.__fake.lastRenderAt,
    rendersAfterSignal: window.__fake.rendersAfterSignal,
    replyText: window.__fake.replyText(),
  }))
export const ipcState = (page) => page.evaluate(() => ({ results: window.__triplexFakeIpc.results, healths: window.__triplexFakeIpc.healths, invoked: window.__triplexFakeIpc.invoked }))
export const outerHtml = (page) => page.evaluate(() => document.documentElement.outerHTML)
export const withOverride = (site, override) => mergeSelectors(DEFAULT_SELECTORS, { [site]: override }).merged
