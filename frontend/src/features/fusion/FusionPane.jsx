// W11: the Fusion pane. Fusion button + iterations stepper, live per-divergence timeline derived
// from `fusion.rounds`, final report (exit reason, standing items with both sides' latest
// justifications) and the usage summary. Bench instrument, not a product demo.
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useRunStream } from '../../api/runStream.js'
import { loadConversation } from '../../api/http.js'
import {
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  RANK,
  STANCE_VERB,
  analyzeTurnById,
  buildTimeline,
  clampIterations,
  divergenceMap,
  fusionGate,
  labelsWithPosition,
  latestClaim,
  latestJustification,
  latestSendTurn,
  traceText,
  usageSummary,
} from './derive.js'
import css from './fusion.module.css'

const EXIT_LABEL = {
  converged: 'converged',
  stalemate: 'stalemate',
  max_iterations: 'max iterations reached',
  error: 'error',
}
const STATUS_LABEL = {
  resolved: 'resolved',
  resolved_unjustified: 'resolved (unjustified)',
  standing: 'standing',
}
const NOTICE_TEXT = {
  nothing_to_fuse: 'Nothing to fuse: Analyze found no divergence at or above the materiality threshold.',
  analyze_degraded: 'Analyze degraded: the analyst returned no valid extraction, so Fusion is unavailable for this turn.',
}

function statusClass(status) {
  if (status === 'resolved') return css.stResolved
  if (status === 'resolved_unjustified') return css.stUnjustified
  if (status === 'standing') return css.stStanding
  return css.stPending
}

function Markdown({ text }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || ''}</ReactMarkdown>
    </div>
  )
}

function Stance({ exchange }) {
  const { model, stance, flagged_unjustified: flagged, error, confidence } = exchange
  const cls = stance === 'revise' ? css.exRevise : stance === 'unavailable' ? css.exUnavailable : css.exDefend
  const title = stance === 'unavailable' ? `no reply: ${error || 'unavailable'}` : `${model} ${STANCE_VERB[stance]}${confidence != null ? ` (confidence ${confidence})` : ''}`
  return (
    <span className={`${css.exchange} ${cls}`} data-testid={`fusion-exchange-${exchange.divergence_id}-${exchange.round}-${model}`} data-stance={stance} title={title}>
      <span className={css.label}>{model}</span> {STANCE_VERB[stance] || stance}
      {stance === 'revise' && flagged ? (
        <span className={css.flag} data-testid="fusion-flag-unjustified" title="revise flagged as unjustified by the anti-sycophancy rule">
          ⚑ unjustified
        </span>
      ) : null}
    </span>
  )
}

function Cell({ id, cell }) {
  const tid = `fusion-cell-${id}-${cell.round}`
  if (cell.skipped) {
    return (
      <td className={`${css.cell} ${css.cellSkipped}`} data-testid={tid} data-status={cell.status || ''}>
        <span className={css.muted} title="already resolved; not re-challenged">—</span>
      </td>
    )
  }
  return (
    <td className={css.cell} data-testid={tid} data-status={cell.status || ''}>
      <div className={css.exchanges}>
        {cell.exchanges.length === 0 ? <span className={css.muted}>{cell.complete ? '(no exchanges)' : '…'}</span> : null}
        {cell.exchanges.map((e) => (
          <Stance key={`${e.model}-${cell.round}`} exchange={{ ...e, round: cell.round }} />
        ))}
      </div>
      <div className={`${css.status} ${statusClass(cell.status)}`} data-testid={`fusion-status-${id}-${cell.round}`}>
        {cell.status ? STATUS_LABEL[cell.status] || cell.status : cell.complete ? 'standing' : 'in progress'}
      </div>
    </td>
  )
}

function Timeline({ fusion, divs }) {
  const rows = buildTimeline(fusion.standing, fusion.rounds)
  const roundNumbers = fusion.rounds.map((r) => r.round)
  if (!rows.length) return null
  return (
    <div className={css.scroll}>
      <table className={css.timeline} data-testid="fusion-timeline">
        <thead>
          <tr>
            <th className={css.th}>divergence</th>
            {roundNumbers.map((n) => (
              <th className={css.th} key={n} data-testid={`fusion-round-head-${n}`}>
                round {n}
              </th>
            ))}
            <th className={css.th}>trace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const d = divs[row.id]
            return (
              <tr key={row.id} data-testid={`fusion-row-${row.id}`} data-final-status={row.finalStatus || ''}>
                <th className={css.rowHead} scope="row">
                  <span className={css.divId}>{row.id}</span>
                  <span className={css.topic} data-testid={`fusion-topic-${row.id}`}>
                    {d ? d.topic : '(topic pending)'}
                  </span>
                  {d ? <span className={css.materiality}>{d.materiality}</span> : null}
                </th>
                {row.cells.map((c) => (
                  <Cell key={c.round} id={row.id} cell={c} />
                ))}
                <td className={css.trace} data-testid={`fusion-trace-${row.id}`}>
                  {traceText(row)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FinalPanel({ fusion, divs }) {
  const exit = fusion.exitReason
  return (
    <div className={css.final} data-testid="fusion-final">
      <div className={css.finalHead}>
        <span className={css.finalTitle}>Fusion report</span>
        <span className={`${css.exit} ${css[`exit_${exit}`] || ''}`} data-testid="fusion-exit-reason" data-exit-reason={exit || ''}>
          exit: {EXIT_LABEL[exit] || exit || '?'}
        </span>
        <span className={css.roundsRun}>
          {fusion.rounds.length} of {fusion.maxIterations ?? '?'} rounds
        </span>
      </div>
      <ul className={css.finalList}>
        {fusion.final.map((f) => {
          const d = divs[f.divergence_id]
          const standing = f.status === 'standing'
          return (
            <li key={f.divergence_id} className={css.finalItem} data-testid={`fusion-final-${f.divergence_id}`} data-status={f.status}>
              <div className={css.finalRow}>
                <span className={css.divId}>{f.divergence_id}</span>
                <span className={css.topic}>{d ? d.topic : ''}</span>
                <span className={`${css.status} ${statusClass(f.status)}`}>{STATUS_LABEL[f.status] || f.status}</span>
              </div>
              {f.status === 'resolved_unjustified' ? (
                <div className={css.caption}>resolved only through revisions flagged as unjustified — not counted as clean convergence</div>
              ) : null}
              {f.status === 'resolved' ? <div className={css.caption}>convergence, not verified truth</div> : null}
              {standing && d ? (
                <div className={css.sides} data-testid={`fusion-sides-${f.divergence_id}`}>
                  {labelsWithPosition(d).map((label) => (
                    <div key={label} className={css.side} data-testid={`fusion-side-${f.divergence_id}-${label}`}>
                      <div className={css.sideHead}>
                        <span className={css.label}>{label}</span>
                        <span className={css.claim}>{latestClaim(fusion.rounds, d, label)}</span>
                      </div>
                      <Markdown text={latestJustification(fusion.rounds, d, label)} />
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {fusion.usage ? (
        <div className={css.usage} data-testid="fusion-usage">
          fusion usage: {usageSummary(fusion.usage)}
        </div>
      ) : null}
    </div>
  )
}

export default function FusionPane() {
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams')
  const fusion = useSlice('fusion')
  const dispatch = useDispatch()
  const run = useRunStream()

  const configured = clampIterations((slotConfig && slotConfig.max_iterations) || 2)
  const [iterations, setIterations] = useState(configured) // the committed value, always 1..5
  // '' while the user has cleared the number field to type a new count (a controlled number input
  // that snapped '' straight to 1 made the next keystroke append: '1' + '4' -> 14 -> 5); null otherwise.
  const [draft, setDraft] = useState(null)
  // Re-sync the stepper whenever the persisted default changes (config bar / conversation switch).
  useEffect(() => {
    setIterations(configured)
    setDraft(null)
  }, [configured])
  function stepIterations(delta) {
    setDraft(null)
    setIterations((v) => clampIterations(v + delta))
  }

  if (!conversation) return null

  const gate = fusionGate({ conversation, slotConfig, streams })
  const running = fusion.status === 'running'
  const analyzeTurn = analyzeTurnById(conversation, fusion.ofAnalyze) || (fusion.analyzeTurn && fusion.analyzeTurn.id === fusion.ofAnalyze ? fusion.analyzeTurn : null)
  const divs = divergenceMap(analyzeTurn)
  // "not fused" follows the CURRENT slotConfig.materiality_min (docs/semantics.md: the marker and the
  // button rule match the NEXT run), not the as-run `standing` stamped on the persisted turn.
  const materialityMin = (slotConfig && slotConfig.materiality_min) || (conversation.slot_config && conversation.slot_config.materiality_min) || 'medium'
  const minRank = RANK[materialityMin] ?? RANK.medium
  const notFused = Object.values(divs).filter((d) => (RANK[d.materiality] ?? -1) < minRank)
  const nextStanding = gate.standing
  // The shown result (report or notice) belongs to the send turn its Analyze turn was run on; after
  // a newer Send it is stale and the next run fuses the latest send turn instead.
  const latestSend = latestSendTurn(conversation)
  const shownFor = analyzeTurn ? analyzeTurn.of_turn : fusion.notice && fusion.analyzeTurn ? fusion.analyzeTurn.of_turn : null
  const showsResult = fusion.status === 'done' && (fusion.notice || fusion.turnId)
  const stale = !!(showsResult && shownFor && latestSend && shownFor !== latestSend.id)

  async function onRun() {
    const id = conversation.id
    let resolved = false
    try {
      await run('fusion', `/api/conversations/${id}/fusion`, { max_iterations: clampIterations(iterations) })
      resolved = true
    } catch {
      // HTTP failure: runStream already dispatched sse/end{ok:false,status,body}; the slice shows it.
    }
    if (resolved) {
      try {
        await loadConversation(dispatch, id)
      } catch {
        /* the timeline is already in the slice; a failed refetch only delays the button rule */
      }
    }
  }

  const currentRound = fusion.rounds.length ? fusion.rounds[fusion.rounds.length - 1] : null
  const exchangesSoFar = fusion.rounds.reduce((n, r) => n + r.exchanges.length, 0)

  return (
    <div className={css.pane} data-testid="fusion-root">
      <div className={css.bar}>
        <span className={css.title}>Fusion</span>
        <label className={css.stepper} title="rounds for this run (1..5)">
          <span>iterations</span>
          <button
            type="button"
            className={css.stepBtn}
            data-testid="fusion-iterations-dec"
            disabled={running || iterations <= MIN_ITERATIONS}
            onClick={() => stepIterations(-1)}
            aria-label="fewer iterations"
          >
            −
          </button>
          <input
            type="number"
            className={css.stepInput}
            data-testid="fusion-iterations"
            min={MIN_ITERATIONS}
            max={MAX_ITERATIONS}
            step={1}
            value={draft ?? iterations}
            disabled={running}
            onChange={(e) => {
              if (e.target.value === '') {
                setDraft('')
                return
              }
              setDraft(null)
              setIterations(clampIterations(e.target.value))
            }}
            onBlur={() => setDraft(null)}
            aria-label="max iterations"
          />
          <button
            type="button"
            className={css.stepBtn}
            data-testid="fusion-iterations-inc"
            disabled={running || iterations >= MAX_ITERATIONS}
            onClick={() => stepIterations(1)}
            aria-label="more iterations"
          >
            +
          </button>
        </label>
        <button type="button" className={css.runBtn} data-testid="fusion-run" disabled={!gate.enabled} onClick={onRun} title={gate.reason || (gate.autoAnalyze ? 'no Analyze result yet: Analyze runs first' : 'run Fusion on the standing divergences')}>
          Fusion
        </button>
        <span className={css.hint} data-testid="fusion-gate-hint">
          {gate.enabled ? (gate.autoAnalyze ? 'will run Analyze first' : nextStanding ? `${nextStanding.length} standing divergence${nextStanding.length === 1 ? '' : 's'}` : '') : gate.reason}
        </span>
        <span className={`${css.state} ${css[`state_${fusion.status}`] || ''}`} data-testid="fusion-status" data-status={fusion.status} data-analyzing={fusion.analyzing ? 'true' : 'false'}>
          {running ? (fusion.analyzing ? 'analyzing…' : fusion.rounds.length ? `round ${currentRound.round} of ${fusion.maxIterations ?? '?'}…` : 'starting…') : fusion.status === 'done' ? (fusion.notice ? 'stopped' : 'done') : fusion.status === 'error' ? 'failed' : 'idle'}
        </span>
      </div>

      {running ? (
        <div className={css.progress} data-testid="fusion-progress">
          {fusion.analyzing ? (
            <span>Analyze is running first (no ok Analyze result for the latest send turn)…</span>
          ) : fusion.rounds.length ? (
            <span>
              round {currentRound.round} of {fusion.maxIterations ?? '?'} {currentRound.complete ? 'done' : 'in progress'} · {exchangesSoFar} exchange{exchangesSoFar === 1 ? '' : 's'} so far · {fusion.standing.length} standing
            </span>
          ) : (
            <span>waiting for fusion_start…</span>
          )}
        </div>
      ) : null}

      {fusion.notice ? (
        <div className={css.notice} data-testid="fusion-notice" data-notice={fusion.notice}>
          {NOTICE_TEXT[fusion.notice] || fusion.notice}
        </div>
      ) : null}
      {fusion.error ? (
        <div className={css.error} data-testid="fusion-error">
          Fusion failed: {fusion.error}
          {fusion.status === 'done' ? ' — showing the last persisted report' : ''}
        </div>
      ) : null}
      {stale ? (
        <div className={css.stale} data-testid="fusion-stale">
          for an earlier send turn ({shownFor}); the next run fuses the latest one
        </div>
      ) : null}

      {fusion.standing.length ? <Timeline fusion={fusion} divs={divs} /> : null}

      {notFused.length ? (
        <div className={css.notFused} data-testid="fusion-not-fused">
          not fused (below materiality "{materialityMin}"):{' '}
          {notFused.map((d) => (
            <span key={d.id} className={css.notFusedItem}>
              {d.id} ({d.materiality}) {d.topic}
            </span>
          ))}
        </div>
      ) : null}

      {fusion.status === 'done' && !fusion.notice && fusion.turnId ? <FinalPanel fusion={fusion} divs={divs} /> : null}
    </div>
  )
}
