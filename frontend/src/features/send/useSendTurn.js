// Stage 2 (integrator pre-work). The Send turn lifecycle as a hook: the behaviour-preserving
// extraction of SendPane.startTurn, consumed by the web SendPane (features/send/SendPane.jsx)
// and by the desktop PromptBar (features/desktop/PromptBar.jsx). One turn:
//   no conversation -> createConversation(dispatch, {}) first — the lock is taken BEFORE this
//                      round-trip, so a second call during POST /api/conversations never creates
//                      a second conversation plus a second three-model Send for one intended turn
//   run('send', url, body)                  (a solo continue also streams under feature key 'send')
//   then loadConversation(dispatch, id, { isCurrent })   (the persisted thread is the source of truth)
//   and, after the conversation's first send, loadConversations(dispatch) (the backend auto-titles).
//
// Conversation isolation: a turn belongs to the conversation it was started in (`id`). If the
// user switches / clears / deletes the conversation while its stream is open, the `slots` slice
// has already dropped the live columns (conversation/loaded|cleared) and ignores the stale
// stream's later events; here `pending` carries that conversation id (a consumer shows the
// prompt bubble only while `pending.convId` is the rendered conversation), the post-stream
// refetch of `id` is skipped before the GET and its response dropped after a switch (the sidebar
// unfreezes at sse/end, before the refetch resolves, and a late conversation/loaded of `id` would
// snap the whole UI back), and the error banner is retired. `locked` stays true from submit —
// including the create round-trip — until the refetch settles, so a consumer that gates on it
// cannot start a second turn in the POST -> sse/end -> conversation/loaded gaps; `startTurn`
// itself refuses a second call while one is in flight (synchronously, before any render).
//
// Body rule (docs/desktop-contract.md §6): `startTurn({ prompt, slots })` with `slots` a strict
// subset of the three slot ids posts `{ prompt, slots }` and `pending.slots` lists exactly those
// slots; omitted / null / not an array / empty / all three posts `{ prompt }` with all three
// pending — the web pane's unchanged behaviour. A solo continue (`slot` set) ignores `slots`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useRunStream } from '../../api/runStream.js'
import { createConversation, loadConversation, loadConversations } from '../../api/http.js'
import './register.js'
import { SLOT_IDS } from './slice.js'

export const STREAM_KEYS = ['send', 'analyze', 'fusion']

// The slots a Send targets when `slots` names a strict subset: known ids only, de-duplicated, in
// SLOT_IDS order (what the backend does too); null otherwise (= all three, the default).
export function subsetSlots(slots) {
  if (!Array.isArray(slots)) return null
  const list = SLOT_IDS.filter((s) => slots.includes(s))
  return list.length && list.length < SLOT_IDS.length ? list : null
}

// POST …/send body: `{ prompt }` by default, `{ prompt, slots }` for a strict subset.
export function sendBody(prompt, slots) {
  const subset = subsetSlots(slots)
  return subset ? { prompt, slots: subset } : { prompt }
}

export function useSendTurn() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  const streams = useSlice('streams') || {}
  const [pending, setPending] = useState(null) // { prompt, slots, convId } while a turn is in flight
  const [inFlight, setInFlight] = useState(false) // submit -> post-stream refetch settled
  const [localError, setLocalError] = useState(null)
  // Conversation id (null = none) the current turn / banner belongs to; `undefined` = retired.
  const [bannerFor, setBannerFor] = useState(undefined)
  const currentId = conversation ? conversation.id : null
  // Latest rendered conversation id, readable after the awaits in startTurn.
  const convIdRef = useRef(null)
  convIdRef.current = currentId
  // Synchronous mirror of `inFlight`: a second startTurn before the render that flips `locked`
  // (same tick, or a consumer that did not re-render yet) is refused from here.
  const inFlightRef = useRef(false)

  // A conversation switch retires the banner of the previous one for good.
  useEffect(() => {
    setBannerFor((f) => (f === currentId ? f : undefined))
  }, [currentId])

  const anyStreaming = STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const locked = anyStreaming || inFlight

  const startTurn = useCallback(
    async ({ slot = null, prompt: raw, slots = null } = {}) => {
      const text = (raw || '').trim()
      if (!text) return false
      if (!conversation && slot) return false // solo continue needs an existing conversation
      if (inFlightRef.current) return false // one turn at a time (header)
      setLocalError(null)
      setBannerFor(conversation ? conversation.id : null)
      // Lock first: the create round-trip below is part of the turn. Unlocked, a second Enter
      // during POST /api/conversations would run with the same `conversation === null` closure
      // and create a second conversation plus a second three-model Send for one intended turn.
      inFlightRef.current = true
      setInFlight(true)
      let conv = conversation
      if (!conv) {
        try {
          conv = await createConversation(dispatch, {})
        } catch (e) {
          setLocalError(e && e.message ? e.message : 'could not create conversation')
          inFlightRef.current = false
          setInFlight(false)
          return false
        }
        // createConversation dispatched conversation/loaded; the render that mirrors it into the
        // ref may not have flushed before a fast stream ends.
        convIdRef.current = conv.id
      }
      const id = conv.id
      setBannerFor(id)
      const firstSend = !slot && !(conv.turns || []).length
      const url = slot ? `/api/conversations/${id}/slots/${slot}/continue` : `/api/conversations/${id}/send`
      const body = slot ? { prompt: text } : sendBody(text, slots)
      setPending({ prompt: text, slots: slot ? [slot] : body.slots || SLOT_IDS, convId: id })
      let ok = true
      try {
        await run('send', url, body)
      } catch {
        ok = false // streams.send.error carries the message (sse/end{ok:false})
      }
      try {
        if (convIdRef.current !== id) {
          // Switched / cleared / deleted mid-stream: the columns were reset already and refetching
          // `id` would silently navigate the user back to it.
          setPending(null)
        } else {
          try {
            // The refetch is skipped before the GET (above) AND its response dropped after a
            // switch: the sidebar re-enables select/new/delete the moment streams.send leaves
            // 'streaming', which is before this GET resolves (`inFlight` only locks the consumer).
            await loadConversation(dispatch, id, { isCurrent: (c) => convIdRef.current === c.id })
            setPending(null)
          } catch {
            if (!ok) setPending(null) // else keep the prompt bubble next to the live reply
          }
        }
        // The backend auto-titled the conversation on its first send; the list refresh does not
        // navigate, so it runs even when the user has moved on.
        if (firstSend) loadConversations(dispatch).catch(() => {})
      } finally {
        inFlightRef.current = false
        setInFlight(false)
      }
      return ok
    },
    [conversation, dispatch, run],
  )

  const clearError = useCallback(() => {
    setLocalError(null)
    setBannerFor(undefined)
  }, [])

  const streamError = streams.send && streams.send.status === 'error' ? streams.send.error : null
  // The message to show for the rendered conversation: a local failure (create) or the send
  // stream's terminal error, only while the banner belongs to the current conversation.
  const banner = bannerFor === currentId ? localError || streamError : null

  return { startTurn, locked, inFlight, pending, bannerFor, localError, banner, clearError }
}
