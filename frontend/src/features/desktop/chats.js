// chats.js (renderer-desktop-2, Stage 2): the conversation ↔ site-chat link, renderer side.
//
// Main records each site's chat URL per Triplex conversation (`chats.json`, plan Decision 12) and
// `triplex.openChats(convId)` navigates the three panes to the chats recorded for that conversation
// ('navigated'), to a fresh chat when none is recorded ('new') or leaves them ('kept') — main
// decides; the renderer only says WHICH conversation is open:
//   * whenever the selected conversation id changes after the first render — a sidebar select, the
//     conversation created by a first Send, a delete/clear (id → null, passed through as
//     `openChats(null)`: the contract admits null and main decides what it means) —
//     `openChats(id)` is called once. The first render is skipped: the panes already show their
//     pages and the shell must not renavigate them on every renderer reload.
//   * "New chat everywhere" (the prompt-bar button and the Ctrl+Shift+N `new-chat-all` shortcut)
//     = `createConversation` + `openChats(newId)` (plan row). The id last handed to main is
//     remembered so the `conversation/loaded` the create dispatches does not open the same chats a
//     second time (a double `loadURL` would reload the panes mid-navigation).
// It is refused while any feature stream runs (the sidebar disables New the same way: a switch
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

export const STREAM_KEYS = ['send', 'analyze', 'fusion']

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
    settle(api?.openChats?.(id))
  }, [api, enabled, id])

  const newChatEverywhere = useCallback(async () => {
    if (busyRef.current || streamingRef.current) return null
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(dispatch, {})
      lastOpened.current = conv.id
      settle(api?.openChats?.(conv.id))
      return conv
    } catch (e) {
      if (alive.current) setError((e && e.message) || 'could not create conversation')
      return null
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }, [api, dispatch])

  const clearError = useCallback(() => setError(null), [])

  return { newChatEverywhere, busy, error, clearError }
}
