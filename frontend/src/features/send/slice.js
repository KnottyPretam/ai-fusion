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
      return patch(s, ev.slot, { buffer: cur.buffer + ev.text, status: cur.status === 'idle' ? 'streaming' : cur.status })
    }
    case 'slot_reasoning': {
      if (!isSlotId(ev.slot) || typeof ev.text !== 'string' || !ev.text) return s
      const cur = s[ev.slot]
      return patch(s, ev.slot, { reasoning: cur.reasoning + ev.text, status: cur.status === 'idle' ? 'streaming' : cur.status })
    }
    case 'slot_citations': {
      if (!isSlotId(ev.slot)) return s
      const cur = s[ev.slot]
      const merged = mergeCitations(cur.citations, ev.items)
      if (merged === cur.citations && cur.status !== 'idle') return s
      return patch(s, ev.slot, { citations: merged, status: cur.status === 'idle' ? 'streaming' : cur.status })
    }
    case 'slot_done': {
      if (!isSlotId(ev.slot)) return s
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

// { byTurn: {turnId -> extras}, latest: extras of the newest send/continue turn for the slot }
export function slotTurns(conversation, slot) {
  const byTurn = {}
  let latest = null
  const turns = conversation && Array.isArray(conversation.turns) ? conversation.turns : []
  for (const t of turns) {
    const x = turnExtras(t, slot)
    if (x) {
      byTurn[x.turnId] = x
      latest = x
    }
  }
  return { byTurn, latest }
}
