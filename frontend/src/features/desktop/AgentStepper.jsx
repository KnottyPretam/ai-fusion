// AgentStepper (2026-10-17) — `−  N agents  +` in the deck bar: the quick way to change who sits on
// the council (two to four agents). ./stepper.js holds every rule; this is the React half.
//
//   agents-stepper            role=group "Agents" (data-count, data-mode: default | in-place | new-chat, data-busy)
//   agents-stepper-remove     "−": removes the right-most agent (data-slot, aria-label "Remove Gemini")
//   agents-stepper-count      "4 agents" (aria-live)
//   agents-stepper-add        "+": opens the add menu (aria-haspopup=menu, aria-expanded, aria-controls)
//   agents-stepper-menu       role=menu, an IN-FLOW strip under the deck bar (never over a site view:
//                             the views move down by its height while it is open, as for the notice)
//     agents-stepper-menu-hint   one line: where an addition lands
//     agents-stepper-add-<slot>  role=menuitem (data-slot, data-group web|token|local, data-seatable);
//                                an unseatable vendor is aria-disabled with its reason — still focusable,
//                                a click does nothing
//     agents-stepper-more        "More options… (Agents page)": opens the drawer on Agents (panes.drawerTab)
//   agents-stepper-error      role=alert row under the bar, with agents-stepper-error-dismiss
// None of the ids starts with `deck-tab-` (councilDeck.test.jsx counts tabs by that prefix).
//
// The hook `useAgentStepper` owns the state; PaneDeck renders <AgentStepper> inside `.deckBar`
// right after `.tabs`, and <AgentStepperMenu> / <AgentStepperError> right after the bar, only while
// open / failed (PaneDeck.test.jsx pins the capture notice as the deck's second child otherwise).
//
// Effects of a click, with the conversation and the config read through refs AT CLICK TIME:
//   1. in place (an empty conversation): `PUT slot_config` with the full config; a 409
//      `council_changed` (the conversation gained a turn since the render) falls back to a new
//      chat — not an error; any other failure shows the error and changes nothing else;
//   2. the default: `triplex.setCouncil(spec)` → `panes/council` (main persists it and pushes it to
//      the backend's session defaults); a refusal shows the error and stops before any create;
//   3. a new chat (something was said): `chats.newChatEverywhere(spec)` — the spec is handed over
//      explicitly, because ./chats.js's council ref is only refreshed at render;
//   4. an addition re-targets the new member (`panes/target on`), even if it was unchecked before.
// Keyboard (the ExportControl pattern): Enter/Space on + opens and focuses the first seatable
// item, the arrow keys walk the items (wrapping), Escape closes and hands focus back to +, a
// mousedown outside closes. The menu also closes when a change starts, when the council changes
// and when another conversation is selected. The model catalog and the local Ollama probe are
// fetched only when the menu opens: the deck alone loads nothing (councilDeck.test.jsx).
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api as http, loadModels, request } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useOpenChats } from './chats.js'
import { COUNCIL_EDIT_MAX } from './council.js'
import { COUNCIL_MIN, SLOT_LABELS, initialPanes, slotStyle } from './slice.js'
import {
  MORE_TEXT,
  addOptions,
  addTitle,
  busyReason,
  countText,
  countTitle,
  itemText,
  itemTitle,
  membersOf,
  menuHint,
  removeTitle,
  stepperAction,
  stepperMode,
  stepperSource,
} from './stepper.js'
import css from './desktop.module.css'

/** The 409 the backend answers once a conversation has turns (backend/store/conversations.py). */
export const COUNCIL_CHANGED = 'council_changed'
export const MORE_TITLE = 'Open the drawer’s Agents page: any vendor on any transport and model, efforts, and the OpenRouter key.'

const EMPTY_MODELS = { items: [], byId: {}, loaded: false, error: null }

function messageOf(e, fallback) {
  return (e && (e.message || e.code)) || fallback
}

export function useAgentStepper({ api = null, chats = null } = {}) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || EMPTY_MODELS
  // PaneDeck mounted on its own (tests) has no shared instance: one of our own that never opens
  // chats by itself (`enabled: false`), the fallback PromptBar uses too.
  const own = useOpenChats(api, { enabled: false })
  const chatsApi = chats || own

  const [open, setOpen] = useState(false)
  const [error, setError] = useState(null)
  const [inflight, setInflight] = useState(false)
  const [ollama, setOllama] = useState(null) // the live local model names; null while probing
  const menuId = useId()
  const hintId = useId()

  const { spec } = stepperSource({ conversation, slotConfig, council: panes.council })
  const members = membersOf(spec)
  const councilKey = members.join(',')
  const mode = stepperMode({ conversation })
  const busy = busyReason({ streams, sending: !!panes.sending, creating: !!chatsApi.busy, inflight })
  const convId = conversation ? conversation.id : null

  // Read at click time (the render that drew the button may be older than the store).
  const latest = useRef({})
  latest.current = { conversation, slotConfig, council: panes.council, streams, sending: !!panes.sending, chats: chatsApi, models }
  const inflightRef = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const triggerRef = useRef(null)
  const removeRef = useRef(null)
  const wrapRef = useRef(null)
  const menuRef = useRef(null)
  // The button to hand focus back to once a change settles (review 2026-10-17): a menu item unmounts with the
  // menu and both buttons are disabled while the change runs, so focus would otherwise fall to <body>.
  const refocusRef = useRef(null)
  useEffect(() => {
    if (inflight || !refocusRef.current) return
    const want = refocusRef.current
    refocusRef.current = null
    // only when focus was lost: a new chat that focused something else keeps it
    if (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body) return
    for (const ref of want === 'add' ? [triggerRef, removeRef] : [removeRef, triggerRef]) {
      if (ref.current && !ref.current.disabled) {
        ref.current.focus()
        return
      }
    }
  }, [inflight])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus && triggerRef.current) triggerRef.current.focus()
  }, [])

  // A council change or another conversation closes the menu (its items would describe the old set).
  useEffect(() => {
    setOpen(false)
  }, [councilKey, convId])

  // Lazy loads, once per opening: the catalog (only if not loaded) and the Ollama probe (every
  // time — a server started since the last look is seen). A probe failure means "no local models".
  const probeSeq = useRef(0)
  useEffect(() => {
    if (!open) return
    if (!latest.current.models.loaded) loadModels(dispatch).catch(() => {})
    const seq = (probeSeq.current += 1)
    setOllama(null)
    Promise.resolve()
      .then(() => request('GET', '/api/ollama/models'))
      .then((reply) => (reply && Array.isArray(reply.models) ? reply.models.filter((n) => typeof n === 'string') : []))
      .catch(() => [])
      .then((names) => {
        if (alive.current && probeSeq.current === seq) setOllama(names)
      })
  }, [open, dispatch])

  // Opening moves focus to the first seatable item (else the first item), keyboard reachable.
  useEffect(() => {
    if (!open || !menuRef.current) return
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')]
    const first = items.find((el) => el.getAttribute('aria-disabled') !== 'true') || items[0]
    if (first) first.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const inside = (ref) => ref.current && ref.current.contains(e.target)
      if (!inside(wrapRef) && !inside(menuRef)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation()
        close()
        return
      }
      if (!open || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      const items = menuRef.current ? [...menuRef.current.querySelectorAll('[role="menuitem"]')] : []
      if (!items.length) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement)
      const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
      const next = forward ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1
      items[next].focus()
    },
    [open, close],
  )

  const toggle = useCallback(() => setOpen((v) => !v), [])
  const dismissError = useCallback(() => setError(null), [])

  const more = useCallback(() => {
    close(false)
    dispatch({ type: 'panes/drawer', open: true, tab: 'agents' })
  }, [close, dispatch])

  const commit = useCallback(
    async (op, slot = null, seat = null) => {
      if (inflightRef.current) return
      const now = latest.current
      const action = stepperAction({
        conversation: now.conversation,
        slotConfig: now.slotConfig,
        council: now.council,
        streams: now.streams,
        busy: now.sending || !!now.chats.busy,
        op,
        slot,
        seat,
      })
      if (action.kind === 'blocked') return
      refocusRef.current = op
      inflightRef.current = true
      setInflight(true)
      setOpen(false)
      setError(null)
      let kind = action.kind
      try {
        // 1. in place, on the empty conversation the click was made in
        if (kind === 'apply-in-place' && action.conversationId) {
          const id = action.conversationId
          const base = now.slotConfig || (now.conversation && now.conversation.slot_config) || {}
          try {
            const stored = await http.putSlotConfig(id, { ...base, slots: action.spec.slots })
            // The slotConfig reducer does not check the id: land it only while that conversation is open.
            if (alive.current && latest.current.conversation && latest.current.conversation.id === id) dispatch({ type: 'slotConfig/loaded', conversationId: id, slotConfig: stored })
          } catch (e) {
            if (e && e.code === COUNCIL_CHANGED) kind = 'new-chat' // a turn landed after the render: same spec, new chat
            else {
              if (alive.current) setError(`The agents did not change: ${messageOf(e, 'the backend refused the council')}`)
              return
            }
          }
        }
        // 2. the default for new chats (main persists it; panes/council mirrors it here)
        if (typeof api?.setCouncil === 'function') {
          try {
            const reply = await api.setCouncil(action.spec)
            dispatch({ type: 'panes/council', council: reply && typeof reply === 'object' && reply.slots ? reply : action.spec })
          } catch (e) {
            if (alive.current) setError(`The default did not change: ${messageOf(e, 'main refused the council')}${kind === 'new-chat' ? '; no new chat was started' : ''}`)
            return
          }
        } else dispatch({ type: 'panes/council', council: action.spec })
        // 3. a new chat with the new set (the old one keeps its agents)
        if (kind === 'new-chat') {
          const conv = await latest.current.chats.newChatEverywhere(action.spec)
          if (!conv) {
            // The create's own message (if any) is in the prompt bar's banner (chats.error).
            if (alive.current) setError('New chat did not start. The new agents are already the default, so the next new chat seats them.')
            return
          }
        }
        // 4. the added member is a Send target, whatever its checkbox said before
        if (op === 'add') dispatch({ type: 'panes/target', slot: action.target, on: true })
      } finally {
        inflightRef.current = false
        if (alive.current) setInflight(false)
      }
    },
    [api, dispatch],
  )

  const options = open ? addOptions({ spec, models, keyStatus: panes.openRouterKey, ollama, health: panes.health }) : []

  return { open, toggle, close, more, commit, error, dismissError, members, mode, busy, options, onKeyDown, triggerRef, removeRef, wrapRef, menuRef, menuId, hintId }
}

/** The stepper itself, inside the deck bar. */
export function AgentStepper({ stepper }) {
  const { members, mode, busy, open } = stepper
  const n = members.length
  const target = members[n - 1]
  const canRemove = !busy && n > COUNCIL_MIN
  const canAdd = !busy && n < COUNCIL_EDIT_MAX
  return (
    <span className={css.stepper} ref={stepper.wrapRef} role="group" aria-label="Agents" data-testid="agents-stepper" data-count={n} data-mode={mode} data-busy={busy ? 'true' : 'false'} onKeyDown={stepper.onKeyDown}>
      <button
        type="button"
        ref={stepper.removeRef}
        className={css.stepperBtn}
        data-testid="agents-stepper-remove"
        data-slot={target}
        aria-label={target ? `Remove ${SLOT_LABELS[target]}` : 'Remove an agent'}
        title={removeTitle({ mode, members, busy })}
        disabled={!canRemove}
        onClick={() => stepper.commit('remove')}
      >
        −
      </button>
      <span className={css.stepperCount} data-testid="agents-stepper-count" aria-live="polite" title={countTitle(mode, members)}>
        {countText(n)}
      </span>
      <button
        type="button"
        ref={stepper.triggerRef}
        className={css.stepperBtn}
        data-testid="agents-stepper-add"
        aria-label="Add an agent"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={stepper.menuId}
        title={addTitle({ mode, members, busy })}
        disabled={!canAdd}
        onClick={stepper.toggle}
      >
        +
      </button>
    </span>
  )
}

/** The add menu: an in-flow strip under the deck bar, rendered only while open. */
export function AgentStepperMenu({ stepper }) {
  const { options, mode } = stepper
  return (
    <div className={css.stepperMenu} ref={stepper.menuRef} id={stepper.menuId} role="menu" aria-label="Add an agent" aria-describedby={stepper.hintId} data-testid="agents-stepper-menu" onKeyDown={stepper.onKeyDown}>
      <span className={css.stepperHint} id={stepper.hintId} role="none" data-testid="agents-stepper-menu-hint">
        {menuHint(mode)}
      </span>
      {options.map((item) => (
        <button
          key={item.slot}
          type="button"
          role="menuitem"
          className={css.stepperItem}
          data-testid={`agents-stepper-add-${item.slot}`}
          data-slot={item.slot}
          data-group={item.group}
          data-seatable={item.seat ? 'true' : 'false'}
          aria-disabled={item.seat ? undefined : 'true'}
          title={itemTitle(item)}
          style={slotStyle(item.slot)}
          onClick={() => {
            if (item.seat) stepper.commit('add', item.slot, item.seat)
          }}
        >
          {itemText(item)}
        </button>
      ))}
      <button type="button" role="menuitem" className={`${css.stepperItem} ${css.stepperMore}`} data-testid="agents-stepper-more" title={MORE_TITLE} onClick={stepper.more}>
        {MORE_TEXT}
      </button>
    </div>
  )
}

/** The failure row under the deck bar (nothing when there is no error). */
export function AgentStepperError({ stepper }) {
  if (!stepper.error) return null
  return (
    <div className={css.stepperError} data-testid="agents-stepper-error" role="alert">
      <span>{stepper.error}</span>
      <button type="button" data-testid="agents-stepper-error-dismiss" aria-label="Dismiss" title="Dismiss this message" onClick={stepper.dismissError}>
        ×
      </button>
    </div>
  )
}
