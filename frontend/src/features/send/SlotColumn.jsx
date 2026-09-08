// W9 (send-ui). One provider column: header (label, grounded badge, model dropdown, effort
// selector, status chip), the persisted thread (fusion messages marked), the live stream, and the
// solo composer. Phase 5 (PLAN §8): citations as domain-named links, the truncation warning and
// the session cost-cap notice — live and after refetch. The cost-cap notice mirrors the meter
// slice's session-wide `costCapExceeded` flag (read-only, optional: the column also derives it
// from its own slot_error / persisted error, so it renders without the meter registered).
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { saveSlotConfig } from '../../api/http.js'
import { SLOT_LABELS, citationUrl, effortsFor, emptySlot, isCostCapError, mergeCitations, nearestEffort, safeCitationHref, slotTurns, threadItems, vendorModels } from './slice.js'
import styles from './send.module.css'

const STREAM_KEYS = ['send', 'analyze', 'fusion']
const EMPTY_THREAD = [] // stable identity: the scroll effect keys on the thread object

// Plain text, link-free (docs/api-contract.md addendum: "the UI shows a persistent warning when
// any event carries that code"). Shown on every column while the cap is hit.
export const COST_CAP_TEXT =
  'Session cost cap reached: the backend refuses every live model call once this session has spent SESSION_COST_CAP_USD. Raise the cap in .env and restart the backend to continue. Mock mode is not affected.'
export const GROUNDED_TITLE =
  "Grounded mode is on: this slot's Send and solo continue calls carry the OpenRouter web-search plugin (never Analyze or Fusion); citations appear under the reply."

export function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '-'
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function fmtCost(c) {
  if (c == null || Number.isNaN(c)) return '-'
  if (c === 0) return '$0'
  if (c < 0.0001) return '<$0.0001'
  return `$${c.toFixed(4)}`
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function fusionLabel(msg) {
  const meta = msg.meta || {}
  return `Fusion round ${meta.round ?? '?'} · ${meta.divergence_id ?? '?'}`
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function Markdown({ text }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function Reasoning({ text, testId }) {
  if (!text) return null
  return (
    <details className={styles.reasoning} data-testid={testId}>
      <summary>Reasoning ({text.length} chars)</summary>
      <pre className={styles.reasoningText}>{text}</pre>
    </details>
  )
}

function Citations({ items, testId }) {
  const list = mergeCitations([], items)
  if (!list.length) return null
  return (
    <div data-testid={testId}>
      <div className={styles.citationsHead}>Citations</div>
      <ol className={styles.citations}>
        {list.map((it, i) => {
          const url = citationUrl(it)
          const href = safeCitationHref(url) // third-party data: only http(s) becomes a link
          const title = it && it.url_citation ? it.url_citation.title : null
          return (
            <li key={url || i}>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {domainOf(href)}
                </a>
              ) : url ? (
                <span data-testid="citation-unlinked">{url}</span>
              ) : (
                <span>(no url)</span>
              )}
              {title ? ` — ${title}` : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function Truncated({ testId }) {
  return (
    <div className={styles.warn} data-testid={testId} role="status">
      Output truncated: the reply hit the token cap (finish_reason = length).
    </div>
  )
}

function ErrorBox({ message, code, testId, partial, costCap = false }) {
  return (
    <div className={styles.error} data-testid={testId} role="alert" data-cost-cap={costCap ? 'true' : 'false'}>
      <div>
        Slot error{code != null ? <span className={styles.errorCode}> [{String(code)}]</span> : null}: {message}
      </div>
      {costCap ? (
        <div className={styles.capNote} data-testid="cost-cap-note">
          {COST_CAP_TEXT}
        </div>
      ) : null}
      {partial ? <div className={styles.notAppended}>Partial output above was kept; nothing was appended to this thread.</div> : null}
    </div>
  )
}

function Extras({ slot, extras, withTestIds }) {
  if (!extras) return null
  const id = (suffix) => (withTestIds ? `slot-${slot}-${suffix}` : undefined)
  if (!extras.reasoning && !(extras.citations && extras.citations.length) && !extras.truncated) return null
  return (
    <div className={styles.extras}>
      <Reasoning text={extras.reasoning} testId={id('reasoning')} />
      <Citations items={extras.citations} testId={id('citations')} />
      {extras.truncated ? <Truncated testId={id('truncated')} /> : null}
    </div>
  )
}

function Message({ slot, msg, extras, isLatest }) {
  const fusion = msg.kind === 'fusion_challenge' || msg.kind === 'fusion_reply'
  const cls = [styles.msg, msg.role === 'user' ? styles.user : styles.assistant, fusion ? styles.fusion : ''].filter(Boolean).join(' ')
  let body
  if (msg.kind === 'fusion_reply') body = <pre className={styles.raw}>{prettyJson(msg.content || '')}</pre>
  else if (msg.role === 'assistant') body = <Markdown text={msg.content || ''} />
  else body = <div className={styles.plain}>{msg.content}</div>
  return (
    <div className={cls} data-testid={`slot-${slot}-message`} data-role={msg.role} data-kind={msg.kind || 'chat'} data-turn-id={msg.turn_id}>
      {fusion ? (
        <div className={styles.fusionLabel} data-testid={`slot-${slot}-fusion-label`}>
          <span>{fusionLabel(msg)}</span>
          <span className={styles.fusionKind}>{msg.kind === 'fusion_challenge' ? 'challenge' : 'reply'}</span>
        </div>
      ) : null}
      {body}
      {msg.role === 'assistant' && msg.kind !== 'fusion_reply' ? <Extras slot={slot} extras={extras} withTestIds={isLatest} /> : null}
    </div>
  )
}

// A send/continue turn where this slot ended in slot_error: nothing was appended to the thread
// (docs/semantics.md), so the prompt, the partial text and the error are rendered from the turn.
// Test ids on the error box follow the Extras rule: only for the newest turn of the slot.
function PersistedError({ slot, extras, isLatest }) {
  return (
    <div data-testid={`slot-${slot}-persisted-error`} data-turn-id={extras.turnId}>
      <div className={`${styles.msg} ${styles.user} ${styles.pending}`} data-role="user" data-kind="chat">
        <div className={styles.plain}>{extras.prompt}</div>
      </div>
      <div className={`${styles.msg} ${styles.assistant}`} data-role="assistant" data-kind="chat">
        {extras.partial ? <Markdown text={extras.partial} /> : null}
        <div className={styles.extras}>
          <ErrorBox message={extras.error} testId={isLatest ? `slot-${slot}-error` : undefined} partial={!!extras.partial} costCap={isCostCapError(null, extras.error)} />
        </div>
      </div>
    </div>
  )
}

function Chip({ slot, status, usage, model, effort, coerced }) {
  const parts = []
  if (usage) {
    const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
    parts.push(
      <span key="tok" title={`prompt ${usage.prompt_tokens ?? 0} · completion ${usage.completion_tokens ?? 0} · reasoning ${usage.reasoning_tokens ?? 0}`}>
        {fmtTokens(tokens)} tok
      </span>,
    )
    parts.push(<span key="cost">{fmtCost(usage.cost_usd)}</span>)
    parts.push(<span key="ms">{usage.latency_ms != null ? `${usage.latency_ms} ms` : '- ms'}</span>)
  }
  return (
    <div className={styles.chip} data-testid={`slot-${slot}-status`} data-status={status || 'idle'}>
      {status && status !== 'idle' ? (
        <span className={styles.status} data-status={status}>
          {status}
        </span>
      ) : null}
      {parts}
      {effort ? (
        <span className={styles.badge} data-testid={`slot-${slot}-effort-badge`} data-coerced={coerced ? 'true' : 'false'} title={model || undefined}>
          {effort}
          {coerced ? ' (coerced)' : ''}
        </span>
      ) : null}
    </div>
  )
}

export default function SlotColumn({ slot, pendingPrompt = null, onContinue, busy = false }) {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const models = useSlice('models') || { items: [], byId: {} }
  const slots = useSlice('slots')
  const streams = useSlice('streams') || {}
  const meter = useSlice('meter') // optional (see header): the session-wide cost-cap flag
  const live = (slots && slots[slot]) || emptySlot()
  const spec = slotConfig && slotConfig.slots ? slotConfig.slots[slot] : null
  const model = spec ? spec.model : ''
  const effort = spec ? spec.effort : ''
  const modelOptions = useMemo(() => vendorModels(models.items, slot, model), [models.items, slot, model])
  const effortOptions = effortsFor(models, model)
  const thread = (conversation && conversation.threads && conversation.threads[slot]) || EMPTY_THREAD
  const { byTurn, latest, errored, rank } = useMemo(() => slotTurns(conversation, slot), [conversation, slot])
  const items = useMemo(() => threadItems(thread, { byTurn, errored, rank }), [thread, byTurn, errored, rank])
  const anyStreaming = busy || STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const [configError, setConfigError] = useState(null)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef(null)

  const isLive = live.status !== 'idle'
  const grounded = !!(slotConfig && slotConfig.grounded)
  // Persistent notice: the meter's session flag (any feature, any conversation), this slot's live
  // cost-cap error, or the newest persisted turn where this slot was refused by the cap.
  const costCapHit = !!(meter && meter.costCapExceeded) || isCostCapError(live.code, live.error) || !!(latest && isCostCapError(null, latest.error))

  // Newest message in view: when the thread (re)loads — a conversation selected in the sidebar,
  // the refetch after a turn — the column must not open scrolled to the oldest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread])

  // Follow the stream: keep the newest text in view while this slot is streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el && live.status === 'streaming') el.scrollTop = el.scrollHeight
  }, [live.buffer, live.reasoning, live.status])

  async function save(patchSpec) {
    if (!conversation || !slotConfig) return
    setConfigError(null)
    try {
      await saveSlotConfig(dispatch, conversation.id, { slots: { [slot]: patchSpec } }, slotConfig)
    } catch (e) {
      setConfigError(e && e.message ? e.message : 'could not save slot config')
    }
  }

  function onModelChange(e) {
    const next = e.target.value
    if (!next || next === model) return
    const p = { model: next }
    const efforts = models.byId && models.byId[next] ? models.byId[next].efforts : null
    if (Array.isArray(efforts) && efforts.length && !efforts.includes(effort)) p.effort = nearestEffort(effort, efforts)
    save(p)
  }

  function onEffortChange(e) {
    const next = e.target.value
    if (!next || next === effort) return
    save({ effort: next })
  }

  function submitContinue() {
    const text = draft.trim()
    if (!text || anyStreaming || !conversation || !onContinue) return
    setDraft('')
    onContinue(text)
  }

  function onDraftKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault()
      submitContinue()
    }
  }

  // Chip data: the live slot while a stream is on, else the newest persisted turn for this slot.
  const chip = isLive
    ? { status: live.status, usage: live.usage, model: live.model || model, effort: live.effort, coerced: live.effortCoerced }
    : latest
      ? {
          status: null,
          usage: latest.usage,
          model: latest.usage ? latest.usage.model : model,
          effort: latest.effort,
          coerced: !!(latest.effort && latest.configuredEffort && latest.effort !== latest.configuredEffort),
        }
      : { status: null, usage: null, model, effort: null, coerced: false }

  const controlsDisabled = !conversation || !slotConfig

  return (
    <div className={styles.column} data-testid={`slot-${slot}`} data-slot={slot} data-status={live.status}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.dot} aria-hidden="true" />
          <span data-testid={`slot-${slot}-label`}>{SLOT_LABELS[slot]}</span>
          {grounded ? (
            <span className={styles.groundedBadge} data-testid={`slot-${slot}-grounded`} title={GROUNDED_TITLE}>
              grounded
            </span>
          ) : null}
        </div>
        <div className={styles.controls}>
          <select
            data-testid={`slot-${slot}-model`}
            aria-label={`${SLOT_LABELS[slot]} model`}
            value={model}
            onChange={onModelChange}
            disabled={controlsDisabled}
            title={controlsDisabled ? 'Defaults apply until a conversation exists' : model}
          >
            {!model ? <option value="">{'—'}</option> : null}
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.missing ? ' (not in catalog)' : ''}
              </option>
            ))}
          </select>
          <select
            className={styles.effort}
            data-testid={`slot-${slot}-effort`}
            aria-label={`${SLOT_LABELS[slot]} effort`}
            value={effort || ''}
            onChange={onEffortChange}
            disabled={controlsDisabled}
          >
            {!effort ? <option value="">{'—'}</option> : null}
            {effort && !effortOptions.includes(effort) ? (
              <option value={effort} disabled>
                {effort} (unsupported)
              </option>
            ) : null}
            {effortOptions.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <Chip slot={slot} {...chip} />
        {costCapHit ? (
          <div className={`${styles.warn} ${styles.headerWarn}`} data-testid={`slot-${slot}-cost-cap`} role="status">
            {COST_CAP_TEXT}
          </div>
        ) : null}
        {configError ? (
          <div className={styles.configError} data-testid={`slot-${slot}-config-error`}>
            {configError}
          </div>
        ) : null}
      </div>

      <div className={styles.scroll} data-testid={`slot-${slot}-thread`} ref={scrollRef}>
        {!items.length && !isLive && !pendingPrompt ? <div className={styles.empty}>No messages yet.</div> : null}
        {items.map((it, i) =>
          it.kind === 'error' ? (
            <PersistedError key={`err-${it.extras.turnId}`} slot={slot} extras={it.extras} isLatest={!!latest && it.extras.turnId === latest.turnId} />
          ) : (
            <Message
              key={`${it.msg.turn_id || 't'}-${i}`}
              slot={slot}
              msg={it.msg}
              extras={it.msg.role === 'assistant' && it.msg.kind !== 'fusion_reply' ? byTurn[it.msg.turn_id] : null}
              isLatest={!!latest && it.msg.turn_id === latest.turnId}
            />
          ),
        )}

        {isLive || pendingPrompt ? (
          <div data-testid={`slot-${slot}-live`}>
            {pendingPrompt ? (
              <div className={`${styles.msg} ${styles.user} ${styles.pending}`} data-role="user" data-kind="chat" data-testid={`slot-${slot}-pending`}>
                <div className={styles.plain}>{pendingPrompt}</div>
              </div>
            ) : null}
            {isLive ? (
              <div className={`${styles.msg} ${styles.assistant} ${live.status === 'streaming' ? styles.streaming : ''}`} data-role="assistant" data-kind="chat">
                {live.buffer ? (
                  <Markdown text={live.buffer} />
                ) : live.status === 'streaming' ? (
                  <div className={styles.waiting}>
                    {live.reasoning ? 'Reasoning…' : 'Waiting for the first token…'}
                    <span className={styles.cursor} aria-hidden="true" />
                  </div>
                ) : null}
                {live.buffer && live.status === 'streaming' ? <span className={styles.cursor} aria-hidden="true" /> : null}
                <div className={styles.extras}>
                  <Reasoning text={live.reasoning} testId={`slot-${slot}-reasoning`} />
                  <Citations items={live.citations} testId={`slot-${slot}-citations`} />
                  {live.truncated ? <Truncated testId={`slot-${slot}-truncated`} /> : null}
                  {live.status === 'error' ? (
                    <ErrorBox message={live.error} code={live.code} testId={`slot-${slot}-error`} partial={!!live.buffer} costCap={isCostCapError(live.code, live.error)} />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        className={styles.solo}
        onSubmit={(e) => {
          e.preventDefault()
          submitContinue()
        }}
      >
        <textarea
          data-testid={`slot-${slot}-composer`}
          aria-label={`Continue ${SLOT_LABELS[slot]} thread`}
          placeholder={conversation ? `Continue ${SLOT_LABELS[slot]} only… (Enter to send)` : 'Send a prompt first'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKey}
          disabled={anyStreaming || !conversation}
          rows={1}
        />
        <button type="submit" data-testid={`slot-${slot}-continue`} disabled={anyStreaming || !conversation || !draft.trim()}>
          Continue
        </button>
      </form>
    </div>
  )
}
