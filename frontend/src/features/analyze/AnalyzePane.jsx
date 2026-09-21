// Analyze pane (W10): Analyze / Re-run buttons + the Similar / Differs report. Labels are
// R1/R2/R3 only — the pane never renders a slot name or the anon map (it never sees one).
//
// data-testids (for Playwright):
//   analyze                      pane root (data-status, data-of-turn)
//   analyze-run                  Analyze button (POST {} — cache hit returns the same turn)
//   analyze-rerun                Re-run button (POST {force:true}); rendered once a turn exists
//   analyze-hint                 why the buttons are disabled
//   analyze-cached               "cached" chip (analyze_done.cached)
//   export-analyze               the Export control (features/export; R1/R2/R3 documents only)
//   analyze-status               running indicator
//   analyze-retry                retry indicator (analyze_retry), with the validation error
//   analyze-error                error box (terminal error event / pre-stream failure)
//   analyze-degraded             degraded box; analyze-fusion-disabled inside it
//   analyze-raw-attempts         <details> with analyze-raw-attempt-<n> <pre> blocks
//   analyze-report               the Similar / Differs report
//   analyze-agreements           <ul>; analyze-agreement-<n>, analyze-agreement-<n>-<label>
//   analyze-divergences          <table>; analyze-divergence-<id> rows (data-fused="yes|no"),
//                                analyze-cell-<id>-<label>, analyze-materiality-<id>,
//                                analyze-not-fused-<id>
import { useCallback, useRef } from 'react'
import ExportControl from '../export/ExportControl.jsx'
import { loadConversation } from '../../api/http.js'
import { useRunStream } from '../../api/runStream.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { LABELS, NOT_CAPTURED_MESSAGE_PREFIX, RANK, initial, isSendTurnComplete, latestSendTurn } from './slice.js'
import RefactorView from './RefactorView.jsx'
import { initial as refactorInitial } from './refactorSlice.js'
import css from './analyze.module.css'
import { APP_NAME } from '../../branding.js'

/** The prefix `features/analyze.py split_notice()` writes when it condenses a reply first. */
export const SPLIT_NOTICE_PREFIX = 'splitting the analyst prompt'

/** True when an `analyze_retry` is narrating the split step rather than a failed attempt. */
export function isSplitNotice(error) {
  return typeof error === 'string' && error.startsWith(SPLIT_NOTICE_PREFIX)
}

export default function AnalyzePane() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  // Mirror of the displayed conversation id: a post-stream refetch that lands after the user
  // switched conversations is dropped (isCurrent) instead of snapping the UI back.
  const convIdRef = useRef(null)
  convIdRef.current = conversation ? conversation.id : null
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const analyze = useSlice('analyze') || initial()
  // Refactor is an OPTION ON ANALYZE (user, 2026-09-20): its button sits beside the Analyze button and
  // Analyze compares its artifact — the restated question, the knowledge graph and the reduced replies —
  // instead of the whole answers. Read by slice KEY, so nothing imports across features.
  const refactor = useSlice('refactor') || refactorInitial()

  const send = latestSendTurn(conversation)
  const complete = isSendTurnComplete(send)
  const streaming = Object.values(streams).some((st) => st && st.status === 'streaming')
  const canRun = !!conversation && complete && !streaming

  const startFeature = useCallback(
    async (feature, body) => {
      if (!conversation) return
      const id = conversation.id
      try {
        await run(feature, `/api/conversations/${id}/${feature}`, body)
        if (convIdRef.current === id) await loadConversation(dispatch, id, { isCurrent: (c) => convIdRef.current === c.id })
      } catch {
        // Surfaced through the streams / analyze / refactor slices (sse/end{ok:false} -> error box).
      }
    },
    [conversation, run, dispatch],
  )
  const start = useCallback((body) => startFeature('analyze', body), [startFeature])
  const startRefactor = useCallback((body) => startFeature('refactor', body), [startFeature])

  if (!conversation) return null

  const materialityMin = (slotConfig && slotConfig.materiality_min) || 'medium'
  const minRank = RANK[materialityMin] ?? RANK.medium
  const turn = analyze.turn
  const extraction = turn && turn.extraction
  const refactorTurn = refactor.turn

  // An incomplete send turn has three very different causes, and telling the user "waiting for all
  // three responses" when the replies are finished (or failed) sends them back to the models
  // instead of to the fix. Name the slots and the cause, and say what to do: a turn that is missing
  // a reply can never be analyzed, so the answer is always a NEW Send, not another Analyze.
  //
  // ORDER: a live stream wins over every verdict about a finished turn. `send` is the PERSISTED
  // turn and features/send/useSendTurn.js refetches the conversation only after the stream ends, so
  // while a Send is in flight `send` still describes the PREVIOUS turn — judging it here would tell
  // the user "Send again" about a turn that is no longer on screen while they are already sending.
  //
  // Wording: only the `notCaptured` branch may speak of capture. That branch fires solely on the
  // desktop message minted by backend/llm/bridge.py (there is no capture switch on the web); a
  // plain failure "came back" or did not, in both shells.
  const errs = (send && send.errors) || {}
  const failed = Object.keys(errs)
  const notCaptured = failed.filter((s) => String(errs[s] || '').startsWith(NOT_CAPTURED_MESSAGE_PREFIX))
  const errored = failed.filter((s) => !notCaptured.includes(s))
  const list = (xs) => xs.join(', ')
  const were = (xs) => (xs.length === 1 ? 'was' : 'were')
  // One clause per slot: two slots that failed for different reasons (a cost cap and a timeout) must
  // never be given one shared cause — that sends the user to the wrong fix for one of them.
  const reasons = (xs) => xs.map((s) => `${s}: ${String(errs[s] || '').trim() || 'no reason given'}`).join('; ')

  let hint = null
  if (!send) hint = 'send a prompt first'
  else if (streaming) hint = 'a stream is running'
  else if (notCaptured.length && !errored.length) {
    hint = `${list(notCaptured)} replied on screen but capture ${were(notCaptured)} off, so ${APP_NAME} never read ${notCaptured.length === 1 ? 'it' : 'them'}. Turn Capture on in ${notCaptured.length === 1 ? 'that pane header' : 'those pane headers'} and Send again: capture applies to the next Send, not this one.`
  } else if (errored.length) {
    hint = `no reply came back from ${reasons(errored)}${notCaptured.length ? ` (and capture was off for ${list(notCaptured)})` : ''}. This turn cannot be analyzed — Send again.`
  } else if (!complete) hint = 'waiting for all three responses'

  return (
    <div className={css.pane} data-testid="analyze" data-status={analyze.status} data-of-turn={analyze.ofTurn || ''}>
      <div className={css.toolbar}>
        <span className={css.title}>Analyze</span>
        {/* Refactor sits immediately before Analyze because it runs first and Analyze reads its output:
            the question restated, the knowledge graph, and each answer reduced to its claims. */}
        <button
          type="button"
          className={`${css.btn} ${css.btnSecondary}`}
          data-testid="refactor-run"
          disabled={!canRun}
          onClick={() => startRefactor(refactorTurn ? { force: true } : {})}
          title={
            refactorTurn
              ? 'Refactor again: map the question and reduce all three answers afresh. Analyze will compare the new version.'
              : 'Map the question into a knowledge graph, restate it concisely, and reduce all three answers to their claims. Analyze then compares that instead of the whole answers.'
          }
        >
          {refactorTurn ? 'Re-refactor' : 'Refactor'}
        </button>
        <button type="button" className={css.btn} data-testid="analyze-run" disabled={!canRun} onClick={() => start({})} title={refactorTurn ? 'Compare the refactored version of the latest send turn (cached when already analyzed)' : 'Compare the latest send turn (cached when already analyzed)'}>
          Analyze
        </button>
        {turn && (
          <button type="button" className={`${css.btn} ${css.btnSecondary}`} data-testid="analyze-rerun" disabled={!canRun} onClick={() => start({ force: true })} title="Force a fresh analyst call">
            Re-run
          </button>
        )}
        {analyze.status === 'done' && analyze.cached && (
          <span className={css.chip} data-testid="analyze-cached" title="Served from the existing analyze turn; no analyst call was made">
            cached
          </span>
        )}
        <ExportControl
          feature="analyze"
          conversationId={conversation.id}
          turnId={turn && turn.id ? turn.id : null}
          title={conversation.title}
          busy={streaming || analyze.status === 'running' || analyze.status === 'retrying'}
        />
        <ExportControl
          feature="refactor"
          conversationId={conversation.id}
          turnId={refactorTurn && refactorTurn.id ? refactorTurn.id : null}
          title={conversation.title}
          turnType="refactor"
          busy={streaming || refactor.status === 'running' || refactor.status === 'working'}
        />
        {refactor.status === 'done' && refactorTurn && (
          <span className={css.chip} data-testid="refactor-ready" title="Analyze compares this refactored version instead of the whole answers">
            refactored
          </span>
        )}
        {hint && (
          <span className={css.hint} data-testid="analyze-hint">
            {hint}
          </span>
        )}
      </div>

      {(refactor.status === 'running' || refactor.status === 'working') && (
        <div className={css.status} data-testid="refactor-status">
          {refactor.notice || 'mapping the question and reducing the three responses…'}
        </div>
      )}
      {refactor.status === 'error' && (
        <div className={css.error} data-testid="refactor-error">
          {refactor.error || 'error'}
        </div>
      )}
      {(refactor.status === 'done' || refactor.status === 'degraded') && (
        <details className={css.refactorDetails} data-testid="refactor-details" open={!extraction}>
          <summary className={css.refactorSummary}>
            {refactor.status === 'degraded' ? 'refactor failed' : 'the refactored version Analyze compares'}
          </summary>
          <RefactorView refactor={refactor} />
        </details>
      )}

      {analyze.status === 'running' && (
        <div className={css.status} data-testid="analyze-status">
          Analyzing the latest send turn…
        </div>
      )}
      {analyze.status === 'retrying' && (
        <div className={css.retry} data-testid="analyze-retry">
          {/* The same event narrates two different things, because the event alphabet is frozen: a
              failed attempt being sent back, and — on a long conversation — each reply being
              condensed before the comparison. Announcing a condensation as a validation failure
              would be three wrong sentences in a row, so the message speaks for itself when the
              backend wrote one. */}
          {isSplitNotice(analyze.error) ? (
            analyze.error
          ) : (
            <>
              Retrying: the analyst output failed validation; sending the error back once.
              {analyze.error && (
                <details>
                  <summary>validation error</summary>
                  <pre className={css.raw}>{analyze.error}</pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {analyze.status === 'error' && (
        <div className={css.error} data-testid="analyze-error">
          Analyze failed: {analyze.error || 'unknown error'}
        </div>
      )}
      {analyze.status === 'degraded' && turn && <Degraded turn={turn} />}

      {extraction && <Report extraction={extraction} materialityMin={materialityMin} minRank={minRank} />}
    </div>
  )
}

function Degraded({ turn }) {
  const attempts = Array.isArray(turn.raw_attempts) ? turn.raw_attempts : []
  return (
    <div className={css.degraded} data-testid="analyze-degraded">
      <div>
        <strong>Analysis degraded.</strong> The analyst did not return a valid extraction after one retry.{' '}
        <span data-testid="analyze-fusion-disabled">Fusion disabled for this turn.</span>
      </div>
      {turn.error && <pre className={css.raw}>{turn.error}</pre>}
      <details data-testid="analyze-raw-attempts">
        <summary>
          raw analyst attempts ({attempts.length})
        </summary>
        {attempts.map((raw, i) => (
          <pre key={i} className={css.raw} data-testid={`analyze-raw-attempt-${i + 1}`}>
            {raw}
          </pre>
        ))}
      </details>
    </div>
  )
}

function Report({ extraction, materialityMin, minRank }) {
  const agreements = Array.isArray(extraction.agreements) ? extraction.agreements : []
  const divergences = Array.isArray(extraction.divergences) ? extraction.divergences : []
  return (
    <div className={css.report} data-testid="analyze-report">
      <section className={css.section}>
        <h3 className={css.heading}>
          Similar
          <span className={css.caption}>convergence, not verified truth</span>
        </h3>
        {agreements.length === 0 ? (
          <p className={css.empty}>No agreements identified.</p>
        ) : (
          <ul className={css.agreements} data-testid="analyze-agreements">
            {agreements.map((ag, i) => (
              <li key={i} data-testid={`analyze-agreement-${i + 1}`}>
                <span className={css.topic}>{ag.topic}</span>
                <span className={css.statement}>{ag.statement}</span>
                <span className={css.labels}>
                  {(ag.models || []).map((l) => (
                    <span key={l} className={css.label} data-testid={`analyze-agreement-${i + 1}-${l}`}>
                      {l}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.section}>
        <h3 className={css.heading}>
          Differs
          <span className={css.caption}>rows below materiality "{materialityMin}" are not fused</span>
        </h3>
        {divergences.length === 0 ? (
          <p className={css.empty}>No divergences identified.</p>
        ) : (
          <div className={css.tableWrap}>
            <table className={css.table} data-testid="analyze-divergences">
              <thead>
                <tr>
                  <th>topic</th>
                  {LABELS.map((l) => (
                    <th key={l}>{l}</th>
                  ))}
                  <th>materiality</th>
                </tr>
              </thead>
              <tbody>
                {divergences.map((d) => {
                  const notFused = (RANK[d.materiality] ?? 0) < minRank
                  return (
                    <tr key={d.id} className={notFused ? css.notFused : undefined} data-testid={`analyze-divergence-${d.id}`} data-fused={notFused ? 'no' : 'yes'}>
                      <td>
                        <span className={css.divId}>{d.id}</span>
                        {d.topic}
                      </td>
                      {LABELS.map((l) => {
                        const p = (d.positions || []).find((x) => x && x.model === l)
                        return (
                          <td key={l} data-testid={`analyze-cell-${d.id}-${l}`}>
                            {p ? (
                              <>
                                <div className={css.claim}>{p.claim}</div>
                                <div className={css.evidence}>{p.evidence_cited ? `evidence: ${p.evidence_cited}` : 'no evidence cited'}</div>
                              </>
                            ) : (
                              <span className={css.none} title="no position on this divergence">
                                —
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td>
                        <span className={`${css.badge} ${css['m_' + d.materiality] || ''}`} data-testid={`analyze-materiality-${d.id}`}>
                          {d.materiality}
                        </span>
                        {notFused && (
                          <span className={css.notFusedTag} data-testid={`analyze-not-fused-${d.id}`}>
                            not fused
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
