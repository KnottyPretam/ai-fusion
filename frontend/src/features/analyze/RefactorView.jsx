// Refactor pane (S11): Refactor / Re-run + the refactored view — the knowledge graph, the question
// restated, and all three responses reduced. Labels are R1/R2/R3 only; the pane never sees a slot
// name or the anon map.
//
// It runs BEFORE Analyze and its output is what Analyze then compares, which is why the drawer puts
// its tab first. Every button and the whole report are the same shapes as the Analyze pane, so the
// two read as one workflow rather than two features.
//
// data-testids (for Playwright):
//   refactor                     pane root (data-status, data-of-turn)
//   refactor-run                 Refactor button (POST {} — cache hit returns the same turn)
//   refactor-rerun               Re-run button (POST {force:true}); rendered once a turn exists
//   refactor-hint                why the buttons are disabled
//   refactor-cached              "cached" chip (refactor_done.cached)
//   export-refactor              the Export control (features/export; R1/R2/R3 documents only)
//   refactor-status              running indicator
//   refactor-notice              the per-call narration (refactor_retry): progress, not a failure
//   refactor-error               error box (terminal error event / pre-stream failure)
//   refactor-degraded            degraded box; refactor-fallback inside it
//   refactor-raw-attempts        <details> with refactor-raw-attempt-<n> <pre> blocks
//   refactor-report              the refactored view
//   refactor-question            the restated question
//   refactor-graph-nodes         <table> of things; refactor-node-<id> rows
//   refactor-graph-edges         <table> of relations; refactor-edge-<n> rows
//   refactor-replies             the three reduced responses; refactor-reply-<label>,
//                                refactor-summary-<label>, refactor-claim-<label>-<n>
import { useCallback, useRef } from 'react'
import ExportControl from '../export/ExportControl.jsx'
import { loadConversation } from '../../api/http.js'
import { useRunStream } from '../../api/runStream.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { NOT_CAPTURED_MESSAGE_PREFIX, isSendTurnComplete } from '../analyze/slice.js'
import { edgeRows, initial, latestSendTurn } from './slice.js'
import css from './refactor.module.css'
import { APP_NAME } from '../../branding.js'

export const FALLBACK_NOTE = 'Analyze falls back to comparing the responses as they were sent.'

export default function RefactorPane() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  const convIdRef = useRef(null)
  convIdRef.current = conversation ? conversation.id : null
  const streams = useSlice('streams') || {}
  const refactor = useSlice('refactor') || initial()

  const send = latestSendTurn(conversation)
  const complete = isSendTurnComplete(send)
  const streaming = Object.values(streams).some((st) => st && st.status === 'streaming')
  const canRun = !!conversation && complete && !streaming

  const start = useCallback(
    async (body) => {
      if (!conversation) return
      const id = conversation.id
      try {
        await run('refactor', `/api/conversations/${id}/refactor`, body)
        if (convIdRef.current === id) await loadConversation(dispatch, id, { isCurrent: (c) => convIdRef.current === c.id })
      } catch {
        // Surfaced through the streams / refactor slices (sse/end{ok:false} -> error box).
      }
    },
    [conversation, run, dispatch],
  )

  if (!conversation) return null

  const turn = refactor.turn
  const ref = turn && turn.refactoring

  // Same rule and the same wording as the Analyze pane: an incomplete send turn is named by slot and
  // cause, and the fix for a missing reply is always a NEW Send.
  const errs = (send && send.errors) || {}
  const failed = Object.keys(errs)
  const notCaptured = failed.filter((s) => String(errs[s] || '').startsWith(NOT_CAPTURED_MESSAGE_PREFIX))
  const errored = failed.filter((s) => !notCaptured.includes(s))
  const list = (xs) => xs.join(', ')
  const were = (xs) => (xs.length === 1 ? 'was' : 'were')
  const reasons = (xs) => xs.map((s) => `${s}: ${String(errs[s] || '').trim() || 'no reason given'}`).join('; ')

  let hint = null
  if (!send) hint = 'send a prompt first'
  else if (streaming) hint = 'a stream is running'
  else if (notCaptured.length && !errored.length) {
    hint = `${list(notCaptured)} replied on screen but capture ${were(notCaptured)} off, so ${APP_NAME} never read ${notCaptured.length === 1 ? 'it' : 'them'}. Turn Capture on in ${notCaptured.length === 1 ? 'that pane header' : 'those pane headers'} and Send again: capture applies to the next Send, not this one.`
  } else if (errored.length) {
    hint = `no reply came back from ${reasons(errored)}${notCaptured.length ? ` (and capture was off for ${list(notCaptured)})` : ''}. This turn cannot be refactored — Send again.`
  } else if (!complete) hint = 'waiting for all three responses'

  const nodes = (ref && ref.graph && ref.graph.nodes) || []
  const edges = ref ? edgeRows(ref.graph) : []

  return (
    <div className={css.pane} data-testid="refactor" data-status={refactor.status} data-of-turn={refactor.ofTurn || ''}>
      <div className={css.toolbar}>
        <span className={css.title}>Refactor</span>
        <button type="button" className={css.btn} data-testid="refactor-run" disabled={!canRun} onClick={() => start({})} title="Map the question and reduce all three responses (cached when already refactored). Analyze then compares this version.">
          Refactor
        </button>
        {turn && (
          <button type="button" className={`${css.btn} ${css.btnSecondary}`} data-testid="refactor-rerun" disabled={!canRun} onClick={() => start({ force: true })} title="Force a fresh refactor">
            Re-run
          </button>
        )}
        {refactor.status === 'done' && refactor.cached && (
          <span className={css.chip} data-testid="refactor-cached" title="Served from the existing refactor turn; no analyst call was made">
            cached
          </span>
        )}
        <ExportControl
          feature="refactor"
          conversationId={conversation.id}
          turnId={turn && turn.id ? turn.id : null}
          title={conversation.title}
          busy={streaming || refactor.status === 'running' || refactor.status === 'working'}
        />
        {hint && (
          <span className={css.hint} data-testid="refactor-hint">
            {hint}
          </span>
        )}
      </div>

      {refactor.status === 'running' && (
        <div className={css.status} data-testid="refactor-status">
          mapping the question and reducing the three responses…
        </div>
      )}
      {refactor.status === 'working' && refactor.notice && (
        <div className={css.status} data-testid="refactor-notice">
          {refactor.notice}
        </div>
      )}
      {refactor.status === 'error' && (
        <div className={css.error} data-testid="refactor-error">
          {refactor.error || 'error'}
        </div>
      )}

      {refactor.status === 'degraded' && (
        <div className={css.degraded} data-testid="refactor-degraded">
          <p className={css.degradedWhy}>{refactor.error || 'the analyst returned no usable refactoring'}</p>
          <p className={css.fallback} data-testid="refactor-fallback">
            {FALLBACK_NOTE}
          </p>
          {turn && turn.raw_attempts && turn.raw_attempts.length > 0 && (
            <details className={css.raw} data-testid="refactor-raw-attempts">
              <summary>raw analyst attempts ({turn.raw_attempts.length})</summary>
              {turn.raw_attempts.map((attempt, i) => (
                <pre key={i} className={css.pre} data-testid={`refactor-raw-attempt-${i + 1}`}>
                  {attempt || '(no output)'}
                </pre>
              ))}
            </details>
          )}
        </div>
      )}

      {ref && (
        <div className={css.report} data-testid="refactor-report">
          <h3 className={css.h3}>The question, restated</h3>
          <p className={css.question} data-testid="refactor-question">
            {ref.question}
          </p>

          <h3 className={css.h3}>What the question is about</h3>
          {nodes.length > 0 && (
            <table className={css.table} data-testid="refactor-graph-nodes">
              <thead>
                <tr>
                  <th>thing</th>
                  <th>kind</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id} data-testid={`refactor-node-${n.id}`}>
                    <td>{n.label}</td>
                    <td className={css.muted}>{n.kind || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {edges.length > 0 && (
            <table className={css.table} data-testid="refactor-graph-edges">
              <thead>
                <tr>
                  <th>from</th>
                  <th>relation</th>
                  <th>to</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e, i) => (
                  <tr key={i} data-testid={`refactor-edge-${i + 1}`}>
                    <td>{e.from}</td>
                    <td className={css.muted}>{e.relation}</td>
                    <td>{e.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nodes.length === 0 && edges.length === 0 && <p className={css.muted}>The analyst returned no graph for this question.</p>}

          <h3 className={css.h3}>The three responses, reduced</h3>
          <div className={css.replies} data-testid="refactor-replies">
            {(ref.replies || []).map((reply) => (
              <section key={reply.model} className={css.reply} data-testid={`refactor-reply-${reply.model}`}>
                <h4 className={css.h4}>{reply.model}</h4>
                {reply.summary && (
                  <p className={css.summary} data-testid={`refactor-summary-${reply.model}`}>
                    {reply.summary}
                  </p>
                )}
                <ul className={css.claims}>
                  {(reply.claims || []).map((claim, i) => (
                    <li key={i} data-testid={`refactor-claim-${reply.model}-${i + 1}`}>
                      {claim}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
