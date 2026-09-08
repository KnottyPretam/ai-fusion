// W9 (send-ui). The `slots` slice: live per-column state for the three provider slots, driven by
// the frozen `sse` actions of feature 'send' (Send AND solo continue both stream under that key).
//
// Shape (docs/api-contract.md "Frontend contract"):
//   slots = { claude: Slot, chatgpt: Slot, grok: Slot }
//   Slot  = { buffer, reasoning, citations, status: 'idle'|'streaming'|'done'|'error', usage,
//             truncated, error, effort, effortCoerced, model }  (+ code / errorType / finishReason)
//
// The persisted thread (conversation.threads[slot]) is the source of truth: `conversation/loaded`
// clears every live buffer, so after the pane refetches the column renders the stored history and
// the per-slot extras stamped on the turn.
//
// Stale-stream rule: `slot_start` precedes every other per-slot event of a turn (docs/semantics.md
// addendum; backend/features/send.py emits it before the first delta) and is the ONLY event that
// takes a slot from `idle` to `streaming`. So a `slot_delta / slot_reasoning / slot_citations /
// slot_done / slot_error` for a slot that is `idle` can only come from a stream whose columns were
// already reset by `conversation/loaded` or `conversation/cleared` (the user switched conversation
// mid-stream): it is ignored, so conversation A's reply never streams into conversation B's
// columns. The pane side of that isolation (pending prompt, post-stream refetch) is in SendPane.

export const SLOT_IDS = ['claude', 'chatgpt', 'grok']
// Duplicated from backend/schemas.py SLOT_VENDORS (state/* is frozen, so it lives here).
export const SLOT_VENDORS = { claude: 'anthropic', chatgpt: 'openai', grok: 'x-ai' }
export const SLOT_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }
// Fallback when the catalog has no entry for a model (docs/api-contract.md effort rule).
export const DEFAULT_EFFORTS = ['off', 'low', 'medium', 'high']

export function emptySlot() {
  return {
    buffer: '',
    reasoning: '',
    citations: [],
    status: 'idle',
    usage: null,
    truncated: false,
    error: null,
    code: null,
    errorType: null,
    finishReason: null,
    effort: null,
    effortCoerced: false,
    model: null,
  }
}

export function initialSlots() {
  const s = {}
  for (const k of SLOT_IDS) s[k] = emptySlot()
  return s
}

export function isSlotId(x) {
  return SLOT_IDS.includes(x)
}

export function citationUrl(item) {
  return item && item.url_citation && typeof item.url_citation.url === 'string' ? item.url_citation.url : null
}

// The LLM layer's session cost-cap code (docs/api-contract.md addendum): `slot_error{code}` live,
// `complete_json` errors for Analyze / Fusion. The backend's message ("session cost cap reached:
// spent $… of SESSION_COST_CAP_USD=$…; live calls refused") does not repeat the code, and that
// message is what a SendTurn.errors[slot] / ContinueTurn.error persists, so the wording is matched
// too. The meter slice keeps the session-wide flag; this is the per-slot / per-turn view.
export const COST_CAP_CODE = 'cost_cap_exceeded'

export function isCostCapError(code, message) {
  if (code === COST_CAP_CODE) return true
  return typeof message === 'string' && (message.includes(COST_CAP_CODE) || /\bcost cap\b/i.test(message))
}

// Annotations are third-party data (web-search results): only an absolute http(s) url may become
// an <a href>; anything else (javascript:, data:, relative, garbage) is shown as text.
export function safeCitationHref(url) {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// Merge raw annotation objects, de-duplicated by url_citation.url; keeps `existing` identity when
// nothing new arrives.
export function mergeCitations(existing, items) {
  if (!Array.isArray(items) || !items.length) return existing
  const seen = new Set(existing.map(citationUrl).filter(Boolean))
  const out = existing.slice()
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const u = citationUrl(it)
    if (u) {
      if (seen.has(u)) continue
      seen.add(u)
    }
    out.push(it)
  }
  return out.length === existing.length ? existing : out
}

function patch(s, slot, p) {
  return { ...s, [slot]: { ...s[slot], ...p } }
}

// Every slot still streaming gets `status` (+ error); untouched slots keep identity.
function settleStreaming(s, status, error) {
  let next = s
  for (const k of SLOT_IDS) {
    if (s[k] && s[k].status === 'streaming') next = patch(next, k, { status, error })
  }
  return next
}

function isEmptySlot(x) {
  return (
    !!x && x.status === 'idle' && !x.buffer && !x.reasoning && !x.citations.length && !x.usage && !x.error && !x.truncated
  )
}

function reduceEvent(s, ev) {
  switch (ev.type) {
    case 'turn_start': {
      // Send lists all three slots; a continue lists exactly one. Only the listed slots reset.
      const list = Array.isArray(ev.slots) ? ev.slots.filter(isSlotId) : SLOT_IDS
      let next = s
      for (const k of list) next = { ...next, [k]: emptySlot() }
      return next
    }
    case 'slot_start': {
      if (!isSlotId(ev.slot)) return s
      return patch(s, ev.slot, {
        status: 'streaming',
        error: null,
        code: null,
        errorType: null,
        model: ev.model ?? null,
        effort: ev.effort ?? null,
        effortCoerced: !!ev.effort_coerced,
      })
    }
    case 'slot_delta': {
      if (!isSlotId(ev.slot) || typeof ev.text !== 'string' || !ev.text) return s
      const cur = s[ev.slot]
      if (cur.status === 'idle') return s // stale stream (see header)
      return patch(s, ev.slot, { buffer: cur.buffer + ev.text })
    }
    case 'slot_reasoning': {
      if (!isSlotId(ev.slot) || typeof ev.text !== 'string' || !ev.text) return s
      const cur = s[ev.slot]
      if (cur.status === 'idle') return s
      return patch(s, ev.slot, { reasoning: cur.reasoning + ev.text })
    }
    case 'slot_citations': {
      if (!isSlotId(ev.slot)) return s
      const cur = s[ev.slot]
      if (cur.status === 'idle') return s
      const merged = mergeCitations(cur.citations, ev.items)
      if (merged === cur.citations) return s
      return patch(s, ev.slot, { citations: merged })
    }
    case 'slot_done': {
      if (!isSlotId(ev.slot) || s[ev.slot].status === 'idle') return s
      return patch(s, ev.slot, {
        status: 'done',
        error: null,
        usage: ev.usage ?? null,
        truncated: !!ev.truncated,
        finishReason: ev.finish_reason ?? null,
      })
    }
    case 'slot_error': {
      if (!isSlotId(ev.slot)) return s
      const cur = s[ev.slot]
      if (cur.status === 'idle') return s
      // Partial text is kept: the deltas already in the buffer, or the server's `partial` if longer.
      const partial = typeof ev.partial === 'string' ? ev.partial : ''
      return patch(s, ev.slot, {
        status: 'error',
        error: ev.message || 'error',
        code: ev.code ?? null,
        errorType: ev.error_type ?? null,
        buffer: partial.length > cur.buffer.length ? partial : cur.buffer,
      })
    }
    case 'turn_done':
      // Exactly one of slot_done / slot_error per slot precedes this; settle stragglers anyway.
      return settleStreaming(s, 'done', null)
    case 'error':
      // Terminal stream error: whatever is still in flight failed.
      return settleStreaming(s, 'error', ev.message || 'error')
    default:
      return s
  }
}

export function slotsReducer(s = initialSlots(), a) {
  switch (a.type) {
    case 'sse':
      if (a.feature !== 'send' || !a.event) return s
      return reduceEvent(s, a.event)
    case 'sse/end':
      return a.feature === 'send' && !a.ok ? settleStreaming(s, 'error', a.error || 'stream failed') : s
    case 'sse/abort':
      return a.feature === 'send' ? settleStreaming(s, 'error', 'aborted') : s
    case 'conversation/loaded':
    case 'conversation/cleared':
      // The persisted document is now the source of truth; drop live buffers.
      return SLOT_IDS.every((k) => isEmptySlot(s[k])) ? s : initialSlots()
    default:
      return s
  }
}

// ---------------------------------------------------------------------------- derived helpers
// (pure, shared by SlotColumn and its tests)

// Models of this slot's vendor, plus the configured slug when the catalog lacks it.
export function vendorModels(items, slot, configured) {
  const list = (Array.isArray(items) ? items : []).filter((m) => m && m.vendor === SLOT_VENDORS[slot])
  if (configured && !list.some((m) => m.id === configured)) {
    return [{ id: configured, name: configured, vendor: SLOT_VENDORS[slot], efforts: null, missing: true }, ...list]
  }
  return list
}

// Effort options for a model: catalog efforts, else the four defaults. A mandatory-reasoning
// model simply lacks 'off'.
export function effortsFor(models, model) {
  const meta = models && models.byId && model ? models.byId[model] : null
  return meta && Array.isArray(meta.efforts) && meta.efforts.length ? meta.efforts : DEFAULT_EFFORTS
}

// Mirror of backend reasoning.build's coercion: nearest lower supported effort, else the lowest.
export function nearestEffort(effort, efforts) {
  if (efforts.includes(effort)) return effort
  const order = DEFAULT_EFFORTS
  const supported = order.filter((e) => efforts.includes(e))
  if (!supported.length) return efforts[0]
  const idx = order.indexOf(effort)
  for (let i = idx - 1; i >= 0; i--) if (supported.includes(order[i])) return order[i]
  return supported[0]
}

function usageFor(turn, slot) {
  const calls = turn && turn.usage && Array.isArray(turn.usage.calls) ? turn.usage.calls : []
  const mine = calls.filter((u) => u && u.role === slot)
  return mine.length ? mine[mine.length - 1] : null
}

// Per-slot view of one persisted send/continue turn (null when the turn does not touch `slot`).
export function turnExtras(turn, slot) {
  if (!turn) return null
  const configuredEffort =
    turn.slot_config && turn.slot_config.slots && turn.slot_config.slots[slot] ? turn.slot_config.slots[slot].effort : null
  if (turn.type === 'send') {
    return {
      turnId: turn.id,
      type: 'send',
      prompt: turn.prompt,
      response: (turn.responses && turn.responses[slot]) ?? null,
      error: (turn.errors && turn.errors[slot]) ?? null,
      partial: (turn.partial && turn.partial[slot]) ?? '',
      reasoning: (turn.reasoning && turn.reasoning[slot]) ?? '',
      citations: (turn.citations && turn.citations[slot]) ?? [],
      truncated: !!(turn.truncated && turn.truncated[slot]),
      effort: (turn.effort_applied && turn.effort_applied[slot]) ?? null,
      configuredEffort,
      usage: usageFor(turn, slot),
    }
  }
  if (turn.type === 'continue' && turn.slot === slot) {
    return {
      turnId: turn.id,
      type: 'continue',
      prompt: turn.prompt,
      response: turn.response ?? null,
      error: turn.error ?? null,
      partial: '',
      reasoning: turn.reasoning ?? '',
      citations: turn.citations ?? [],
      truncated: !!turn.truncated,
      effort: turn.effort_applied ?? null,
      configuredEffort,
      usage: usageFor(turn, slot),
    }
  }
  return null
}

// { byTurn: {turnId -> extras}, latest: extras of the newest send/continue turn for the slot,
//   errored: turn ids (in turn order) of the send/continue turns where this slot ended in
//   slot_error, rank: {turnId -> index in conversation.turns} for every turn }
export function slotTurns(conversation, slot) {
  const byTurn = {}
  const errored = []
  const rank = {}
  let latest = null
  const turns = conversation && Array.isArray(conversation.turns) ? conversation.turns : []
  turns.forEach((t, i) => {
    if (t && t.id != null) rank[t.id] = i
    const x = turnExtras(t, slot)
    if (x) {
      byTurn[x.turnId] = x
      latest = x
      if (x.error) errored.push(x.turnId)
    }
  })
  return { byTurn, latest, errored, rank }
}

// The column's render list: the persisted thread interleaved with the turns where this slot
// errored. On slot_error nothing is appended to the thread (docs/semantics.md) — the failed
// exchange lives only on the turn — so every such turn is shown at its place in the history
// (before the first message of a later turn), not just the newest one.
// Items: { kind: 'message', msg } | { kind: 'error', extras }.
export function threadItems(thread, { byTurn, errored, rank }) {
  const list = Array.isArray(thread) ? thread : []
  if (!errored || !errored.length) return list.map((msg) => ({ kind: 'message', msg }))
  const pos = (id) => (id != null && id in rank ? rank[id] : Infinity)
  const out = []
  let e = 0
  for (const msg of list) {
    while (e < errored.length && pos(errored[e]) < pos(msg.turn_id)) out.push({ kind: 'error', extras: byTurn[errored[e++]] })
    out.push({ kind: 'message', msg })
  }
  while (e < errored.length) out.push({ kind: 'error', extras: byTurn[errored[e++]] })
  return out
}
