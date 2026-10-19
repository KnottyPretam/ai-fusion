// Analyze pane (W10): Analyze / Re-run buttons + the Similar / Differs report. Labels are
// R1..Rn only (n = the analyzed send turn's council size, `labelsFor(councilSize(send))`) — the
// pane never renders a slot name or the anon map (it never sees one).
//
// data-testids (for Playwright):
//   analyze                      pane root (data-status, data-of-turn)
//   analyze-run                  Analyze button (POST {} — cache hit returns the same turn)
//   analyze-rerun                Re-run button (POST {force:true}); rendered once a turn exists
//   analyze-hint                 why the buttons are disabled
//   analyze-reread               (2026-10-15) the Read-again row: analyze-reread-<slot> buttons, one per
//                                slot whose reply can be read out of its pane again; analyze-reread-status
//                                while one runs, analyze-reread-error when it failed
//   analyze-cached               "cached" chip (analyze_done.cached)
//   export-analyze               the Export control (features/export; R-labelled documents only)
//   analyze-status               running indicator
//   analyze-retry                retry indicator (analyze_retry): a progress narration shown as
//                                itself, a failed attempt with its error tucked away
//   analyze-error                error box (terminal error event / pre-stream failure)
//   analyze-degraded             degraded box; analyze-fusion-disabled inside it
//   analyze-raw-attempts         <details> with analyze-raw-attempt-<n> <pre> blocks
//   analyze-report               the Similar / Differs report
//   analyze-agreements           <ul>; analyze-agreement-<n>, analyze-agreement-<n>-<label>
//   analyze-divergences          <table>; analyze-divergence-<id> rows (data-fused="yes|no"),
//                                analyze-cell-<id>-<label>, analyze-materiality-<id>,
//                                analyze-not-fused-<id>
import { useCallback, useRef, useState } from 'react'
import ExportControl from '../export/ExportControl.jsx'
import { loadConversation } from '../../api/http.js'
import { useRunStream } from '../../api/runStream.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { NOT_CAPTURED_MESSAGE_PREFIX, RANK, councilSize, councilSizeFor, countWord, initial, isSendTurnComplete, isStillAnswering, labelsFor, latestSendTurn, plainError, rereadableSlots, sendTurnFor } from './slice.js'
import RefactorView from './RefactorView.jsx'
import { initial as refactorInitial } from './refactorSlice.js'
import css from './analyze.module.css'
import { APP_NAME } from '../../branding.js'

/**
 * The prefix every PROGRESS narration on `analyze_retry` begins with. The source is
 * `SPLIT_NOTICE_PREFIX` in `backend/features/analyze.py`; this is its mirror (product code never
 * reads the backend, so it is duplicated with a pointer, like SLOT_VENDORS, and pinned verbatim by
 * tests/analyze/test_split.py). The event alphabet is frozen, so a reply being condensed and a
 * reply being condensed in pieces both announce themselves on the retry event, and this prefix is
 * the only thing that tells either apart from a failed attempt being sent back.
 */
/**
 * A degraded turn whose error carries one of these never ran the comparison: `oversize_message`,
 * `condense_failure` and `condense_ineffective` in backend/features/analyze.py. Copies with a pointer,
 * not a second definition (features never import the backend's strings): keep them in step.
 */
export const NO_COMPARISON_MARKERS = ['can take in one message', 'could not condense', 'condense passes']

export const NOTICE_PREFIX = 'splitting the analyst prompt'

/** True when an `analyze_retry` is narrating progress (a condensation) rather than a failed attempt. */
export function isProgressNotice(error) {
  return typeof error === 'string' && error.startsWith(NOTICE_PREFIX)
}

// The names this pair shipped under at S10, kept so an in-flight importer keeps resolving.
export const SPLIT_NOTICE_PREFIX = NOTICE_PREFIX
export const isSplitNotice = isProgressNotice

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
  // The desktop's pane state, by KEY (2026-10-18): only a still-answering slot whose capture switch is on is
  // read again automatically (features/desktop/autoReread.js), so only that one is promised it. Absent in the
  // web app, where nothing is rereadable anyway.
  const panes = useSlice('panes')

  const send = latestSendTurn(conversation)
  const complete = isSendTurnComplete(send)
  const councilN = countWord(councilSizeFor(send, slotConfig)) // the open config before the first Send
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
  // Read again (2026-10-15): read one slot's reply out of its pane, typing nothing, and complete the Send
  // (backend/features/reread.py). Local state, keyed by conversation: the outcome is shown once, then the
  // refetched conversation says the rest (a filled slot drops its button and enables Analyze).
  const [reread, setReread] = useState({ convId: null, slot: null, status: 'idle', error: null })
  const startReread = useCallback(
    async (turnId, slot) => {
      if (!conversation) return
      const id = conversation.id
      setReread({ convId: id, slot, status: 'running', error: null })
      let error = null
      try {
        const events = await run('reread', `/api/conversations/${id}/turns/${turnId}/slots/${slot}/reread`)
        const last = events[events.length - 1]
        if (!last || last.type !== 'reread_done') error = plainError(last && last.message) || 'the re-read ended without a reply'
      } catch (e) {
        error = (e && (e.code || e.message)) || 'error'
      }
      setReread({ convId: id, slot, status: error ? 'error' : 'idle', error })
      if (convIdRef.current === id) await loadConversation(dispatch, id, { isCurrent: (c) => convIdRef.current === c.id })
    },
    [conversation, run, dispatch],
  )

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
  //
  // Read again (2026-10-15): when a failed slot is a web pane whose reply can be read again
  // (`rereadableSlots`), "cannot be analyzed — Send again" is no longer true, and a capture that gave up
  // with the site's stop control still up is not a failure of the model at all: it was still answering
  // when the app stopped waiting. That branch says so and points at the Read-again row (and, since
  // 2026-10-18, says such a slot is read again automatically once the site has finished); every other
  // turn keeps the wording above, word for word.
  const errs = (send && send.errors) || {}
  const failed = Object.keys(errs)
  const notCaptured = failed.filter((s) => String(errs[s] || '').startsWith(NOT_CAPTURED_MESSAGE_PREFIX))
  const errored = failed.filter((s) => !notCaptured.includes(s))
  const rereadable = rereadableSlots(conversation, send)
  const list = (xs) => xs.join(', ')
  const were = (xs) => (xs.length === 1 ? 'was' : 'were')
  // One clause per slot: two slots that failed for different reasons (a cost cap and a timeout) must
  // never be given one shared cause — that sends the user to the wrong fix for one of them.
  const reasons = (xs) => xs.map((s) => `${s}: ${plainError(errs[s]) || 'no reason given'}`).join('; ')

  let hint = null
  if (!send) hint = 'send a prompt first'
  else if (streaming) hint = 'a stream is running'
  else if (rereadable.length) {
    const still = errored.filter((s) => isStillAnswering(errs[s]))
    const other = errored.filter((s) => !still.includes(s))
    const said = []
    if (still.length) said.push(`${list(still)} ${were(still)} still answering when ${APP_NAME} stopped waiting; the reply is in the pane`)
    if (other.length) said.push(`no reply came back from ${reasons(other)}`)
    if (notCaptured.length) said.push(`capture was off for ${list(notCaptured)}, so ${APP_NAME} never read ${notCaptured.length === 1 ? 'it' : 'them'}`)
    const capture = notCaptured.some((s) => rereadable.includes(s)) ? ` Turn Capture on in ${notCaptured.length === 1 ? 'that pane header' : 'those pane headers'} first.` : ''
    const rest = failed.filter((s) => !rereadable.includes(s))
    // 2026-10-18: a slot that was still answering is read again BY ITSELF once its site has finished, while
    // this conversation is open (features/desktop/useAutoReread.js); the button stays the manual path.
    const auto = rereadable.filter((s) => still.includes(s) && !!(panes && panes.capture && panes.capture[s] === true))
    const manual = rereadable.filter((s) => !auto.includes(s))
    const how = []
    if (auto.length) how.push(`${APP_NAME} reads ${list(auto)} again by itself once the site has finished, while this conversation is open (or use the button below)`)
    if (manual.length) how.push(`Read ${list(manual)} again below`)
    hint = `${said.join('; ')}.${capture} ${how.join('; ')}${rest.length ? `; ${list(rest)} cannot be read again — Send again for ${rest.length === 1 ? 'it' : 'them'}` : ''}.`
  } else if (notCaptured.length && !errored.length) {
    hint = `${list(notCaptured)} replied on screen but capture ${were(notCaptured)} off, so ${APP_NAME} never read ${notCaptured.length === 1 ? 'it' : 'them'}. Turn Capture on in ${notCaptured.length === 1 ? 'that pane header' : 'those pane headers'} and Send again: capture applies to the next Send, not this one.`
  } else if (errored.length) {
    hint = `no reply came back from ${reasons(errored)}${notCaptured.length ? ` (and capture was off for ${list(notCaptured)})` : ''}. This turn cannot be analyzed — Send again.`
  } else if (!complete) hint = `waiting for all ${councilN} responses`

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
              ? `Refactor again: map the question and reduce all ${councilN} answers afresh. Analyze will compare the new version.`
              : `Map the question into a knowledge graph, restate it concisely, and reduce all ${councilN} answers to their claims. Analyze then compares that instead of the whole answers.`
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

      {send && rereadable.length > 0 && (
        <div className={css.reread} data-testid="analyze-reread">
          {rereadable.map((slot) => (
            <button
              key={slot}
              type="button"
              className={`${css.btn} ${css.btnSecondary}`}
              data-testid={`analyze-reread-${slot}`}
              disabled={streaming}
              onClick={() => startReread(send.id, slot)}
              title={`Read ${slot}'s reply out of its pane again, typing nothing, and complete this Send so it can be analyzed. If the site is still answering, this waits for it to finish.`}
            >
              Read {slot} again
            </button>
          ))}
          {reread.convId === conversation.id && reread.status === 'running' && (
            <span className={css.status} data-testid="analyze-reread-status">
              reading {reread.slot}&apos;s reply from its pane…
            </span>
          )}
          {reread.convId === conversation.id && reread.status === 'error' && rereadable.includes(reread.slot) && (
            <span className={css.error} data-testid="analyze-reread-error">
              {reread.slot}: {reread.error}
            </span>
          )}
        </div>
      )}
      {(refactor.status === 'running' || refactor.status === 'working') && (
        <div className={css.status} data-testid="refactor-status">
          {refactor.notice || `mapping the question and reducing the ${councilN} responses…`}
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
              condensed before the comparison (in pieces, when one is too big for one message).
              Announcing a condensation as a validation failure would be three wrong sentences in a
              row, so a message carrying the backend's progress prefix speaks for itself. */}
          {isProgressNotice(analyze.error) ? (
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

      {extraction && <Report extraction={extraction} labels={labelsFor(councilSize(sendTurnFor(conversation, turn && turn.of_turn)))} materialityMin={materialityMin} minRank={minRank} />}
    </div>
  )
}

function Degraded({ turn }) {
  const attempts = Array.isArray(turn.raw_attempts) ? turn.raw_attempts : []
  // "after one retry" is true only when the comparison ran and its failed output was sent back once.
  // A size-bound degrade — a reply over the budget, a condensation that failed, or a set that did not
  // shrink enough — never got that far, and the frozen turn has no field for which it was. The
  // raw-attempt count cannot tell them apart (review 2026-09-22: a refused set after two passes
  // leaves nine attempts and no comparison), so the branch keys on the error text, mirroring the
  // three strings backend/features/analyze.py writes for those cases the way NOTICE_PREFIX mirrors
  // SPLIT_NOTICE_PREFIX.
  const noComparison = NO_COMPARISON_MARKERS.some((m) => String(turn.error || '').includes(m))
  const retried = !noComparison && attempts.length > 1
  return (
    <div className={css.degraded} data-testid="analyze-degraded">
      <div>
        <strong>Analysis degraded.</strong>{' '}
        {retried
          ? 'The analyst did not return a valid extraction after one retry.'
          : 'The analyst could not produce a report.'}{' '}
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

function Report({ extraction, labels, materialityMin, minRank }) {
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
                  {labels.map((l) => (
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
                      {labels.map((l) => {
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
