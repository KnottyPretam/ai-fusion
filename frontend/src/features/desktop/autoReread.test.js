// autoReread.js (2026-10-18): the pure rules of the automatic Read again.
import { describe, expect, test } from 'vitest'
import { STREAM_FEATURES } from '../conversations/index.jsx'
import { STREAM_KEYS as SEND_LOCK_KEYS } from '../send/useSendTurn.js'
import { STREAM_KEYS as CHATS_LOCK_KEYS } from './chats.js'
import { AUTO_REREAD_SETTLE_MS, TRANSIENT_REREAD_CODES, autoRereadKey, autoRereadTarget, isStillAnsweringResult, isTransientRereadFailure, rereadDone, rereadFailed, rereadRunning } from './autoReread.js'

const DIAG = '[containers=0 followed=- connected=false anchor=0 order=oldest geom=no presubmit=0 stopNow=true stopSeen=true end=- md=0 pre=0 code=0 reply=0 inner=0 textContent=0 maxContainer=0 rect=- viewport=413×803]'
const STILL = `the reply was still in progress after 525880 ms ${DIAG}`
const GONE = 'the reply was still in progress after 525880 ms [containers=1 stopNow=false stopSeen=true]'
const WEB = { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' }, grok: { model: 'web:grok', effort: 'off' }, gemini: { model: 'web:gemini', effort: 'off' } }

function send(over = {}) {
  return {
    type: 'send',
    id: 's1',
    prompt: 'Explain it',
    slot_config: { slots: WEB, analyst_model: 'web:chatgpt:analyst' },
    responses: { claude: 'a', chatgpt: null, grok: 'c', gemini: 'd' },
    errors: { chatgpt: STILL },
    ...over,
  }
}
const conversation = (turns, id = 'c1') => ({ id, title: 't', turns, threads: {} })
const health = (over = {}) => ({ composer: true, send: true, reply: null, stop: false, session: 'ok', chatOf: ['c1'], ...over })
function panes(over = {}) {
  return {
    sending: false,
    health: { claude: health(), chatgpt: health(), grok: health(), gemini: health() },
    capture: { claude: true, chatgpt: true, grok: true, gemini: true },
    lastSend: {},
    bridge: { connected: true },
    ...over,
  }
}
const target = (over = {}) => autoRereadTarget({ conversation: conversation([send()]), panes: panes(), streams: {}, attempted: new Set(), ...over })

describe('autoRereadTarget', () => {
  test('a still-answering web slot whose pane says the stop control is gone, signed in, capture on', () => {
    expect(target()).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
    expect(AUTO_REREAD_SETTLE_MS).toBe(3000)
  })

  test('nothing without a conversation, while any stream runs, or while a send is in flight', () => {
    expect(target({ conversation: null })).toBeNull()
    expect(target({ streams: { analyze: { status: 'streaming' } } })).toBeNull()
    expect(target({ streams: { reread: { status: 'streaming' } } })).toBeNull()
    expect(target({ streams: { send: { status: 'done' } } })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
    expect(target({ panes: panes({ sending: true }) })).toBeNull()
  })

  test('only a STILL ANSWERING error: a timeout with the stop control gone, or another failure, is the manual button\'s', () => {
    expect(target({ conversation: conversation([send({ errors: { chatgpt: GONE } })]) })).toBeNull()
    expect(target({ conversation: conversation([send({ errors: { chatgpt: 'reply_not_found' } })]) })).toBeNull()
    expect(target({ conversation: conversation([send({ errors: {} })]) })).toBeNull()
  })

  test('only a slot that can be read again: a later turn other than Analyze / Refactor makes it stale', () => {
    expect(target({ conversation: conversation([send(), { type: 'analyze', id: 'a1' }, { type: 'refactor', id: 'r1' }]) })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
    expect(target({ conversation: conversation([send(), { type: 'continue', id: 'k1', slot: 'grok' }]) })).toBeNull()
    // the latest Send is what counts: an older stuck Send under a newer complete one is stale anyway
    expect(target({ conversation: conversation([send(), send({ id: 's2', responses: { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd' }, errors: {} })]) })).toBeNull()
  })

  test('only a web pane: the analyst page, OpenRouter or Ollama are not read again', () => {
    const slots = { ...WEB, chatgpt: { model: 'web:chatgpt:analyst', effort: 'off' } }
    expect(target({ conversation: conversation([send({ slot_config: { slots } })]) })).toBeNull()
    const openrouter = { ...WEB, chatgpt: { model: 'openai/gpt-6', effort: 'off' } }
    expect(target({ conversation: conversation([send({ slot_config: { slots: openrouter } })]) })).toBeNull()
  })

  test('the pane must say it has finished: stop up, stop unknown, no health, or not signed in → wait', () => {
    expect(target({ panes: panes({ health: { chatgpt: health({ stop: true }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ stop: null }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: null } }) })).toBeNull()
    expect(target({ panes: panes({ health: {} }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ session: 'logged_out' }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ session: 'challenge' }) } }) })).toBeNull()
  })

  test('only while the pane SHOWS this conversation\'s chat (main\'s `chatOf`): another page, no ids, or an older main without the field → skip', () => {
    expect(target({ panes: panes({ health: { chatgpt: health({ chatOf: ['c2'] }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ chatOf: [] }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ chatOf: undefined }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ chatOf: 'c1' }) } }) })).toBeNull()
    expect(target({ panes: panes({ health: { chatgpt: health({ chatOf: ['c2', 'c1'] }) } }) })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
    // a mismatch only SKIPS: nothing is marked, so the read fires once the pane is back on this chat
    const attempted = new Set()
    expect(autoRereadTarget({ conversation: conversation([send()]), panes: panes({ health: { chatgpt: health({ chatOf: ['c2'] }) } }), streams: {}, attempted })).toBeNull()
    expect(attempted.size).toBe(0)
    expect(autoRereadTarget({ conversation: conversation([send()]), panes: panes(), streams: {}, attempted })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
  })

  test('only with the bridge to Electron connected', () => {
    expect(target({ panes: panes({ bridge: { connected: false } }) })).toBeNull()
    expect(target({ panes: panes({ bridge: undefined }) })).toBeNull()
    expect(target({ panes: panes({ bridge: { connected: 'yes' } }) })).toBeNull()
  })

  test('capture must be on for that site (a re-read with capture off reads nothing)', () => {
    expect(target({ panes: panes({ capture: { chatgpt: false } }) })).toBeNull()
    expect(target({ panes: panes({ capture: {} }) })).toBeNull()
  })

  test('once per conversation + turn + slot: an attempted key is skipped and the next slot is taken', () => {
    const two = send({ responses: { claude: null, chatgpt: null, grok: 'c', gemini: 'd' }, errors: { claude: STILL, chatgpt: STILL } })
    const conv = conversation([two])
    expect(autoRereadTarget({ conversation: conv, panes: panes(), streams: {}, attempted: new Set() })).toEqual({ turnId: 's1', slot: 'claude', message: STILL })
    const attempted = new Set([autoRereadKey('c1', 's1', 'claude')])
    expect(autoRereadTarget({ conversation: conv, panes: panes(), streams: {}, attempted })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
    attempted.add(autoRereadKey('c1', 's1', 'chatgpt'))
    expect(autoRereadTarget({ conversation: conv, panes: panes(), streams: {}, attempted })).toBeNull()
    // keyed by conversation too: the same ids under another conversation are a different key
    expect(autoRereadKey('c1', 's1', 'claude')).not.toBe(autoRereadKey('c2', 's1', 'claude'))
    // order: catalog order, so a waiting claude (stop up) does not block a finished chatgpt
    expect(autoRereadTarget({ conversation: conv, panes: panes({ health: { ...panes().health, claude: health({ stop: true }) } }), streams: {}, attempted: new Set() })).toEqual({ turnId: 's1', slot: 'chatgpt', message: STILL })
  })

  test('only a site: a non-site council member (a renderer column) is never read again', () => {
    const slots = { ...WEB, qwen: { model: 'web:qwen', effort: 'off' } }
    const turn = send({ slot_config: { slots }, responses: { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', qwen: null }, errors: { qwen: STILL } })
    expect(target({ conversation: conversation([turn]), panes: panes({ health: { qwen: health() }, capture: { qwen: true } }) })).toBeNull()
  })
})

describe('transient failures (one more try)', () => {
  test('the bridge / view / navigation codes and a thrown network error are transient; a reply not found is final', () => {
    for (const code of ['bridge_unavailable', 'bridge_disconnected', 'bridge_no_ack', 'busy', 'view_busy', 'adapter_gone', 'navigation', 'cancelled']) {
      expect(TRANSIENT_REREAD_CODES).toContain(code)
      expect(isTransientRereadFailure(code)).toBe(true)
    }
    for (const code of ['reply_not_found', 'timeout', 'empty_reply', 'not_captured', 'reread_stale', 'already_captured', 'error', undefined]) expect(isTransientRereadFailure(code)).toBe(false)
    expect(isTransientRereadFailure(undefined, { thrown: true })).toBe(true) // a fetch that threw
    expect(isTransientRereadFailure('busy', { thrown: true })).toBe(true) // a 409 busy
    expect(isTransientRereadFailure('reread_stale', { thrown: true })).toBe(false)
  })
})

describe('the prompt-bar results', () => {
  test('isStillAnsweringResult: the same predicate as the prompt bar, never one of the re-read lines', () => {
    expect(isStillAnsweringResult({ ok: false, code: 'timeout', message: STILL })).toBe(true)
    expect(isStillAnsweringResult({ ok: false, code: 'timeout', message: GONE })).toBe(false)
    expect(isStillAnsweringResult({ ok: true, ms: 5 })).toBe(false)
    expect(isStillAnsweringResult(rereadRunning())).toBe(false)
    expect(isStillAnsweringResult({ ...rereadFailed('timeout', STILL), message: STILL })).toBe(false)
    expect(isStillAnsweringResult(null)).toBe(false)
  })

  test('the shapes', () => {
    expect(rereadRunning()).toEqual({ ok: false, reread: 'running' })
    expect(rereadDone(4120.6)).toEqual({ ok: true, reread: 'done', ms: 4121 })
    expect(rereadDone(NaN)).toEqual({ ok: true, reread: 'done', ms: 0 })
    expect(rereadFailed('timeout', STILL)).toEqual({ ok: false, reread: 'failed', code: 'timeout', message: 'the reply was still in progress after 525880 ms' })
    expect(rereadFailed(null, '')).toEqual({ ok: false, reread: 'failed', code: 'error', message: 'error' })
  })
})

describe('a running re-read locks what any stream locks', () => {
  test('the composer (useSendTurn), the panes\' navigation (chats.js) and the sidebar all count the `reread` stream', () => {
    expect(SEND_LOCK_KEYS).toContain('reread')
    expect(CHATS_LOCK_KEYS).toContain('reread')
    expect(STREAM_FEATURES).toContain('reread')
  })
})
