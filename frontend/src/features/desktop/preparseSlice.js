// Pre-parse slice (2026-09-23). Registered under key 'preparse' from ./index.jsx, beside `panes`.
//
// Shape: { status:      'idle'|'running'|'working'|'done'|'degraded'|'error',
//          notice:      the latest preparse_retry{error} narration while working — progress, as a
//                       refactor_retry is, which is why it is not `error`,
//          prompt:      preparse_done.prompt: the restated question with the answer block appended,
//                       the text PromptBar puts into the composer,
//          original:    the text the backend was given, as preparse_done / preparse_degraded echo it,
//          question:    the restated question on its own,
//          error:       the terminal message on 'error', the degrade reason on 'degraded',
//          rawAttempts: preparse_degraded.raw_attempts (what the analyst actually answered),
//          seq:         how many preparse_done results have arrived. PromptBar applies each one
//                       exactly once (an effect keyed on it), so it only ever goes up: a clear and
//                       an abort keep it }
//
// `sse` is read ONLY when a.feature === 'preparse': nothing else runs a pre-parse (the analyze slice
// cannot afford that rule because Fusion auto-runs Analyze on its own stream). A pre-stream failure
// (404, 409 busy, 422 empty_prompt / prompt_too_long) emits no preparse_* event at all and lands as
// sse/end{ok:false, error:<code>}. sse/abort is the Cancel button: back to idle. preparse/clear is
// the next click, or a Send. conversation/loaded|cleared are ignored ON PURPOSE: the draft belongs
// to the composer, not to a conversation — a first Pre-parse creates the conversation in the middle
// of the flow and that create dispatches `loaded` — and nothing is persisted, so there is nothing to
// hydrate from either.
//
// Convention (state/reducers.js, ./slice.js): an action that changes nothing returns the SAME
// object, so untouched slices keep identity across the root reducer. Malformed payloads are
// reported, never thrown — and never quietly turned into an empty composer.

export const FEATURE = 'preparse'

export function initial() {
  return { status: 'idle', notice: null, prompt: null, original: null, question: null, error: null, rawAttempts: [], seq: 0 }
}

const str = (v) => (typeof v === 'string' ? v : null)

function atRest(s) {
  return s.status === 'idle' && s.notice === null && s.prompt === null && s.original === null && s.question === null && s.error === null && s.rawAttempts.length === 0
}

/** A pre-parse the composer is still waiting on: only these states may turn into a stream failure. */
export function preparseInFlight(s) {
  return s.status === 'running' || s.status === 'working'
}

/** A result already applied (or already failed): a late sse/end says nothing new about it. */
function preparseSettled(s) {
  return s.status === 'done' || s.status === 'degraded' || s.status === 'error'
}

/** Back to idle, keeping the count of results that have arrived. */
function cleared(s) {
  return atRest(s) ? s : { ...initial(), seq: s.seq }
}

export function reducer(s = initial(), a) {
  switch (a.type) {
    case 'sse': {
      if (a.feature !== FEATURE) return s
      const ev = a.event
      if (!ev || typeof ev.type !== 'string') return s
      switch (ev.type) {
        case 'preparse_start':
          return { ...initial(), status: 'running', seq: s.seq }
        case 'preparse_retry':
          return { ...s, status: 'working', notice: str(ev.error) }
        case 'preparse_done':
          // The composer is about to take this text verbatim: a missing or empty prompt is a
          // failure to report, never an empty composer.
          if (typeof ev.prompt !== 'string' || ev.prompt === '') return { ...s, status: 'error', notice: null, error: 'malformed preparse_done' }
          return { status: 'done', notice: null, prompt: ev.prompt, original: str(ev.original), question: str(ev.question), error: null, rawAttempts: [], seq: s.seq + 1 }
        case 'preparse_degraded':
          return {
            ...s,
            status: 'degraded',
            notice: null,
            prompt: null,
            original: str(ev.original),
            question: null,
            error: str(ev.error) || 'degraded',
            rawAttempts: Array.isArray(ev.raw_attempts) ? ev.raw_attempts : [],
          }
        case 'error':
          return { ...s, status: 'error', notice: null, error: ev.message || 'error' }
        default:
          return s
      }
    }
    case 'sse/end':
      if (a.feature !== FEATURE || a.ok) return s
      // review 2026-09-23: a settled result is never re-labelled by a late transport failure; a
      // pre-stream failure (404 / 409 / 422) arrives while still idle and must land as an error
      if (preparseSettled(s)) return s
      return { ...s, status: 'error', notice: null, error: a.error || 'stream failed' }
    case 'sse/abort':
      return a.feature === FEATURE ? cleared(s) : s
    case 'preparse/clear':
      return cleared(s)
    default:
      return s
  }
}
