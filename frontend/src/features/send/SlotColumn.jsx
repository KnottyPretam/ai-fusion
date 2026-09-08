// W9 (send-ui). One provider column: header (label, model dropdown, effort selector, status
// chip), the persisted thread (fusion messages marked), the live stream, and the solo composer.
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { saveSlotConfig } from '../../api/http.js'
import { SLOT_LABELS, citationUrl, effortsFor, emptySlot, mergeCitations, nearestEffort, slotTurns, vendorModels } from './slice.js'
import styles from './send.module.css'

const STREAM_KEYS = ['send', 'analyze', 'fusion']

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
          const title = it && it.url_citation ? it.url_citation.title : null
          return (
            <li key={url || i}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer noopener">
                  {domainOf(url)}
                </a>
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

function ErrorBox({ message, code, testId, partial }) {
  return (
    <div className={styles.error} data-testid={testId} role="alert">
      <div>
        Slot error{code != null ? <span className={styles.errorCode}> [{String(code)}]</span> : null}: {message}
      </div>
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
  const live = (slots && slots[slot]) || emptySlot()
  const spec = slotConfig && slotConfig.slots ? slotConfig.slots[slot] : null
  const model = spec ? spec.model : ''
  const effort = spec ? spec.effort : ''
  const modelOptions = useMemo(() => vendorModels(models.items, slot, model), [models.items, slot, model])
  const effortOptions = effortsFor(models, model)
  const thread = (conversation && conversation.threads && conversation.threads[slot]) || []
  const { byTurn, latest } = useMemo(() => slotTurns(conversation, slot), [conversation, slot])
  const anyStreaming = busy || STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const [configError, setConfigError] = useState(null)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef(null)

  const isLive = live.status !== 'idle'

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

  const showPersistedError = !isLive && latest && latest.error
  const controlsDisabled = !conversation || !slotConfig

  return (
    <div className={styles.column} data-testid={`slot-${slot}`} data-slot={slot} data-status={live.status}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.dot} aria-hidden="true" />
          <span data-testid={`slot-${slot}-label`}>{SLOT_LABELS[slot]}</span>
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
        {configError ? (
          <div className={styles.configError} data-testid={`slot-${slot}-config-error`}>
            {configError}
          </div>
        ) : null}
      </div>

      <div className={styles.scroll} data-testid={`slot-${slot}-thread`} ref={scrollRef}>
        {!thread.length && !isLive && !pendingPrompt && !showPersistedError ? <div className={styles.empty}>No messages yet.</div> : null}
        {thread.map((m, i) => (
          <Message
            key={`${m.turn_id || 't'}-${i}`}
            slot={slot}
            msg={m}
            extras={m.role === 'assistant' && m.kind !== 'fusion_reply' ? byTurn[m.turn_id] : null}
            isLatest={!!latest && m.turn_id === latest.turnId}
          />
        ))}

        {showPersistedError ? (
          <div data-testid={`slot-${slot}-persisted-error`}>
            <div className={`${styles.msg} ${styles.user} ${styles.pending}`} data-role="user" data-kind="chat">
              <div className={styles.plain}>{latest.prompt}</div>
            </div>
            <div className={`${styles.msg} ${styles.assistant}`} data-role="assistant" data-kind="chat">
              {latest.partial ? <Markdown text={latest.partial} /> : null}
              <div className={styles.extras}>
                <ErrorBox message={latest.error} testId={`slot-${slot}-error`} partial={!!latest.partial} />
              </div>
            </div>
          </div>
        ) : null}

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
                  {live.status === 'error' ? <ErrorBox message={live.error} code={live.code} testId={`slot-${slot}-error`} partial={!!live.buffer} /> : null}
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
