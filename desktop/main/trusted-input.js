// desktop/main/trusted-input.js — TRUSTED keyboard input into a site view, from main (2026-10-17).
//
// gemini.google.com is publicly reported (an Electron-44 embed, 2026-09-30) to ignore UNTRUSTED input: a
// synthetic insert plus `el.click()` showed the Stop state and no usable reply — a false confirmation the
// adapter's own submit would accept, so a fallback keyed on `not_submitted` would never fire. Electron's
// `webContents.insertText` and `webContents.sendInputEvent` go through the renderer's input pipeline and
// arrive as `isTrusted` events, which is what a person typing produces. They are NOT the debugger: no
// `debugger.attach`, no CDP session, no user-agent change and no `executeJavaScript` (CLAUDE.md gotcha 19
// holds) — this module never calls anything but the two methods below, `setBackgroundThrottling(false)` and
// `capturePage()`.
//
// Measured 2026-10-17 (Electron 44, a probe on DISPLAY=:1 against the gemini look-alike): a view that was
// HIDDEN BEFORE ITS PAGE FIRST LOADED — the analyst page always, and a pane never shown since launch — has its
// widget created hidden: `insertText` still lands, but every `sendInputEvent` key is dropped (no keydown
// reaches the page, rAF never fires), so the trusted Enter submitted nothing and the app spec's
// gemini-as-analyst Pre-parse ended `not_submitted`. A view shown once and hidden later keeps taking keys
// (Electron ignores WasHidden under backgroundThrottling:false). Re-asserting `setBackgroundThrottling(false)`
// — the value every site view is created with (views.js buildViewOptions) — makes Electron call WasShown on a
// widget that is still hidden; after it the same Enter lands. Nothing is drawn on screen: the view's own
// visibility and bounds are untouched. In the app that was not enough for the analyst page: its widget is
// already "shown" (so there is nothing to re-show), but its new-chat navigation committed while hidden, the
// new document never painted, and Chromium drops input before a document's first paint (measured: innerWidth 0,
// rAF 0, no keydown). The analyst view now has real bounds while hidden (analyst-views.js), and ONE
// `capturePage()` before the Enter renders a frame of it (Chromium shows a hidden page for a capture); the
// image is discarded. With both, the app spec's gemini-as-analyst Pre-parse submits.
//
// Who may type: MAIN only, and only the bridge request's own text into the view that request named
// (orchestrator.js). The preload never asks main to type, so a page can never inject keystrokes through it.
//
//   createTrustedInput({webContentsFor}) → {insertText(view, slot, text), pressEnter(view, slot)}
//     webContentsFor(view, slot)   the WebContents of that view ('pane' → views.webContents(slot),
//                                  'analyst' → analystViews.webContents()); null when there is none
//     insertText                    → wake, then wc.insertText(text) (a Promise in Electron; awaited)
//     pressEnter                    → wake, paint once, then wc.sendInputEvent for each of ENTER_EVENTS (keyDown,
//                                     char, keyUp)
//     (wake = wc.setBackgroundThrottling(false); paint once = wc.capturePage(), at most TRUSTED_PAINT_MS, the image
//     discarded — the header's 2026-10-17 measurements; a throw in either is ignored)
//   A missing or destroyed WebContents rejects `view_crashed`; anything the WebContents throws is
//   re-thrown with its message as `site_error` (the orchestrator maps both to a result code). The text is
//   never logged and never part of an error message.
// Pure module: no electron import; the WebContents is injected so node --test drives it with a fake.

import { AdapterRequestError } from './adapter-client.js'

/**
 * Enter as a keyboard produces it: keyDown, the `char` event that carries the carriage return (what an
 * editor's keypress handler sees), keyUp. Plain Enter is never intercepted by shortcuts.js.
 */
export const ENTER_EVENTS = Object.freeze([
  Object.freeze({ type: 'keyDown', keyCode: 'Return' }),
  Object.freeze({ type: 'char', keyCode: '\r' }),
  Object.freeze({ type: 'keyUp', keyCode: 'Return' }),
])

export const TRUSTED_VIEWS = Object.freeze(['pane', 'analyst'])

/** How long the pre-Enter capture (`paintOnce`) is waited for at most; orchestrator.js budgets it per Enter. */
export const TRUSTED_PAINT_MS = 1500

export function createTrustedInput({ webContentsFor, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  if (typeof webContentsFor !== 'function') throw new Error('createTrustedInput: webContentsFor is required')

  /** The live WebContents of (view, slot), or a `view_crashed` rejection. */
  function live(view, slot) {
    if (!TRUSTED_VIEWS.includes(view)) throw new AdapterRequestError('site_error', `trusted input: unknown view ${String(view)}`)
    let wc = null
    try {
      wc = webContentsFor(view, slot)
    } catch (e) {
      throw new AdapterRequestError('view_crashed', `trusted input: no view for ${view} ${String(slot)} (${(e && e.message) || e})`)
    }
    let destroyed = true
    try {
      destroyed = !wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())
    } catch (_e) {
      destroyed = true
    }
    if (destroyed) throw new AdapterRequestError('view_crashed', `trusted input: the ${view} view of ${String(slot)} is gone`)
    return wc
  }

  /**
   * Re-assert backgroundThrottling:false so Electron shows a widget created hidden (header, 2026-10-17): its
   * keys are dropped otherwise. Idempotent for a widget already shown; a WebContents without the method, or
   * one that throws, is left as it is — the page's own confirmation is the judge either way.
   */
  function wake(wc) {
    if (typeof wc.setBackgroundThrottling !== 'function') return
    try {
      wc.setBackgroundThrottling(false)
    } catch (_e) {
      /* verifyInput / confirmSubmit say what landed */
    }
  }

  /**
   * One frame of the page before the trusted Enter (header, 2026-10-17): `capturePage()` makes Chromium render
   * a hidden page for the capture, and a document that has never painted — the analyst page after its new-chat
   * navigation — drops every key until it has. The image is discarded; a capture that fails or outlasts
   * TRUSTED_PAINT_MS is not waited for (confirmSubmit is the judge). Never rejects.
   */
  async function paintOnce(wc) {
    if (typeof wc.capturePage !== 'function') return
    let timer = null
    try {
      await Promise.race([Promise.resolve().then(() => wc.capturePage()), new Promise((resolve) => (timer = setT(resolve, TRUSTED_PAINT_MS)))])
    } catch (_e) {
      /* nothing painted; the Enter is still sent */
    } finally {
      if (timer !== null) clearT(timer)
    }
  }

  async function insertText(view, slot, text) {
    if (typeof text !== 'string' || text === '') throw new AdapterRequestError('site_error', 'trusted input: the text must be a non-empty string')
    const wc = live(view, slot)
    if (typeof wc.insertText !== 'function') throw new AdapterRequestError('site_error', 'trusted input: this WebContents has no insertText')
    wake(wc)
    try {
      await wc.insertText(text)
    } catch (e) {
      throw new AdapterRequestError('site_error', `trusted insertText failed: ${(e && e.message) || e}`)
    }
  }

  async function pressEnter(view, slot) {
    const wc = live(view, slot)
    if (typeof wc.sendInputEvent !== 'function') throw new AdapterRequestError('site_error', 'trusted input: this WebContents has no sendInputEvent')
    wake(wc)
    await paintOnce(wc)
    try {
      for (const event of ENTER_EVENTS) wc.sendInputEvent({ ...event })
    } catch (e) {
      throw new AdapterRequestError('site_error', `trusted Enter failed: ${(e && e.message) || e}`)
    }
  }

  return { insertText, pressEnter }
}
