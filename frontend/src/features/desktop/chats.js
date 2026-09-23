// chats.js (renderer-desktop-2, Stage 2): the conversation ↔ site-chat link, renderer side.
//
// Main records each site's chat URL per Triplex conversation (`chats.json`, plan Decision 12) and
// `triplex.openChats(convId)` navigates the three panes to the chats recorded for that conversation
// ('navigated'), to a fresh chat when none is recorded ('new') or leaves them ('kept') — main
// decides; the renderer only says WHICH conversation is open:
//   * whenever the selected conversation id changes after the first render — a sidebar select, a
//     delete/clear (id → null, passed through as `openChats(null)`: the contract admits null and
//     main decides what it means) — `openChats(id)` is called once. The first render is skipped:
//     the panes already show their pages and the shell must not renavigate them on every renderer
//     reload. The conversation a first Send creates is NOT a switch: PromptBar dispatches
//     `panes/sendStart` before `startTurn`, so while `panes.sending` is true a new id is only
//     remembered — that Send's bridge requests are already in flight, and main's `openChat` would
//     otherwise race them by loading a fresh chat under the request typing into the pane
//     (`adapter_gone`, or a reply observed on the wrong page). Decision 12 has the send adopt
//     whatever chat each pane currently shows; main records the link from that turn.
//   * "New chat everywhere" (the prompt-bar button and the Ctrl+Shift+N `new-chat-all` shortcut)
//     = `createConversation` + `openChats(newId)` (plan row); from Stage 3 the conversation is
//     created with `desktopSlotConfig()` (./analyst.js: web:* panes + the chosen analyst), like
//     PromptBar's first-Send create. The id last handed to main is
//     remembered so the `conversation/loaded` the create dispatches does not open the same chats a
//     second time (a double `loadURL` would reload the panes mid-navigation).
//   * Pre-parse (2026-09-23): a first Pre-parse with no conversation selected needs an id — the
//     route is per conversation (`conversation_scope` and the busy guard) — but the user has not
//     sent anything, so the panes must keep the chats they show, exactly as a first Send adopts them
//     (Decision 12). `createAdopted()` is `newChatEverywhere` minus the navigation: the same create,
//     the same last-opened mark (so the `loaded` the create dispatches is not a switch), and no
//     `openChats`; the first Send then adopts the panes' current chats.
// Both are refused while any feature stream runs (the sidebar disables New the same way: a switch
// mid-stream would book the in-flight turn into the wrong conversation) and while a create is in
// flight. Every `window.triplex` call is optional-chained: the hook works under a partial stub
// and returns quietly when `openChats` is absent.
//
// One instance per shell: DesktopShell creates it and hands `newChatEverywhere` to PaneDeck (the
// shortcut) and PromptBar (the button); PromptBar mounted on its own (tests) falls back to an
// instance of its own. `enabled: false` keeps a second instance from also opening chats.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createConversation } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { desktopSlotConfig } from './analyst.js'

export const STREAM_KEYS = ['send', 'analyze', 'fusion', 'preparse'] // preparse: the panes must not navigate while the composer waits on the analyst

/** Swallow the rejection of an IPC promise (bad_request, a closed window); the UI stays up. */
function settle(p) {
  Promise.resolve(p).catch(() => {})
}

export function useOpenChats(api, { enabled = true } = {}) {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const streams = useSlice('streams') || {}
  const id = conversation ? conversation.id : null
  const anyStreaming = STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const streamingRef = useRef(anyStreaming)
  streamingRef.current = anyStreaming
  // `panes.sending` spans the whole unified Send, the create round-trip included (PromptBar
  // dispatches `panes/sendStart` before `startTurn`). `sendSeen` = "a Send has started and this
  // hook has not yet seen it end": under React's batching a fast turn (create → stream → refetch →
  // `panes/sendResult`) collapses into ONE render in which the id change and `sending: false`
  // arrive together, so the instantaneous flag would miss it. Set at render time, cleared by the
  // effect declared AFTER the id effect below, the flag still classifies that id change as the
  // Send's own create.
  const panes = useSlice('panes')
  const sending = !!(panes && panes.sending)
  const sendSeen = useRef(false)
  if (sending) sendSeen.current = true
  // The conversation id whose chats main was last asked to open; `undefined` until the first render.
  const lastOpened = useRef(undefined)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (lastOpened.current === undefined) {
      lastOpened.current = id // first render: the panes already show their pages
      return
    }
    if (lastOpened.current === id) return
    lastOpened.current = id
    // The id a Send's own create produced (a Send seen and not yet ended): the panes are adopted,
    // not renavigated — the same mark `newChatEverywhere` sets for its own conversation. A clear
    // (id → null) still reaches main, which leaves the panes where they are.
    if (id !== null && sendSeen.current) return
    settle(api?.openChats?.(id))
  }, [api, enabled, id])

  // Declared after the id effect on purpose: in a collapsed render the id effect runs first.
  useEffect(() => {
    if (!sending) sendSeen.current = false
  }, [sending])

  // One create for both callers. The id is marked as the one last handed to main BEFORE the
  // `conversation/loaded` the create dispatched can reach the id effect above (that render is
  // scheduled, not synchronous), so the effect sees no switch; only "New chat everywhere" then
  // asks main to open the new conversation's chats.
  const create = useCallback(
    async (navigate) => {
      if (busyRef.current || streamingRef.current) return null
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        const conv = await createConversation(dispatch, { slot_config: desktopSlotConfig() })
        lastOpened.current = conv.id
        if (navigate) settle(api?.openChats?.(conv.id))
        return conv
      } catch (e) {
        if (alive.current) setError((e && e.message) || 'could not create conversation')
        return null
      } finally {
        busyRef.current = false
        if (alive.current) setBusy(false)
      }
    },
    [api, dispatch],
  )

  const newChatEverywhere = useCallback(() => create(true), [create])

  /** Pre-parse's create: the conversation exists, the panes keep the chats they show (header). */
  const createAdopted = useCallback(() => create(false), [create])

  const clearError = useCallback(() => setError(null), [])

  return { newChatEverywhere, createAdopted, busy, error, clearError }
}
