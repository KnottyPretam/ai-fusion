// Plan (2026-09-27): the section the Fusion pane renders right under its final report — ONE agent
// turns the Fusion outcome into an executable procedure (objective, prerequisites, numbered steps
// each with a verify, decision points for what Fusion left standing, risks, done-when), shown as a
// table / checklist and exportable as md / html / pdf through the same Export control as the panes.
//
// The agent is picked per run (`plan-model`, persisted in localStorage): on the desktop the three
// web panes come first — the plan is typed into THIS conversation's chat for that site and read
// back, the site's own model setting applies — then the hidden analyst pages, local Ollama models
// and, with a key, OpenRouter; in the browser the OpenRouter catalog. The run posts `{of_fusion:
// <the report on screen>, model}` (+ `force` for a re-plan) and refetches the conversation, exactly
// as FusionPane.onRun does. Labels stay R1..Rn; the raw model string is shown ("made by …") because
// the user picked it, and never reaches an export (the backend document carries no model string).
//
// data-testids (for Playwright):
//   plan-root                    section root (data-status)
//   plan-run                     "Make a plan" | "Re-plan" (force) button
//   plan-model                   the agent picker (<select> with <optgroup>s)
//   plan-status                  state chip (data-status)
//   plan-notice                  progress line while running / working
//   plan-error                   terminal error box
//   plan-cached                  "cached" chip (plan_done.cached)
//   plan-stale                   the plan shown is for another fusion turn than the report shown
//   export-plan                  the Export control (features/export)
//   plan-report                  the rendered plan; plan-objective, plan-prerequisites,
//                                plan-steps (rows plan-step-<n> with data-done, plan-step-<n>-done
//                                checkbox, plan-step-<n>-details row), plan-decisions
//                                (plan-decision-<i>), plan-risks, plan-done-when, plan-model-used,
//                                plan-usage
//   plan-degraded                degraded box; plan-raw-attempts <details> with plan-raw-attempt-<n>
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useRunStream } from '../../api/runStream.js'
import { loadConversation } from '../../api/http.js'
import ExportControl from '../export/ExportControl.jsx'
import { anyStreaming, usageSummary } from './derive.js'
import { checkedSteps, hasOption, initial, loadPlanModel, persistPlanModel, planGate, planModelOptions, toggleStep } from './planSlice.js'
import css from './fusion.module.css'

const EMPTY_MODELS = { items: [], byId: {}, loaded: false, error: null }

/** True under the Electron renderer (`window.triplex`, the preload's contextBridge surface) — mirrors features/export/runExport.js isDesktop. */
function isDesktop() {
  return typeof window !== 'undefined' && !!window.triplex
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null
  } catch {
    return null
  }
}

const STATUS_TEXT = { idle: 'idle', running: 'starting…', working: 'working…', done: 'done', degraded: 'degraded', error: 'failed' }

const RUN_TITLE =
  'Ask ONE agent to turn this Fusion report into an executable procedure: objective, prerequisites, numbered steps each with how to verify it, a decision point for every difference still standing, risks, and what "done" looks like. Cached per Fusion report.'
const RERUN_TITLE = 'Ask the chosen agent for a fresh plan from this Fusion report; the cached one is replaced.'
const PICKER_TITLE =
  "The one agent that writes the plan. A web session is typed into this conversation's chat for that site, in the open, and its own model setting applies; a hidden analyst page, a local model or an OpenRouter model answers out of sight."

function Prerequisites({ items }) {
  if (!items.length) {
    return (
      <p className={css.planNone} data-testid="plan-prerequisites">
        (none)
      </p>
    )
  }
  return (
    <ul className={css.planList} data-testid="plan-prerequisites">
      {items.map((p, i) => (
        <li key={i}>{p}</li>
      ))}
    </ul>
  )
}

function Steps({ steps, checked, onToggle }) {
  if (!steps.length) {
    return (
      <p className={css.planNone} data-testid="plan-steps">
        (no steps)
      </p>
    )
  }
  return (
    <div className={css.scroll}>
      <table className={css.planTable} data-testid="plan-steps">
        <thead>
          <tr>
            <th title="Tick a step once it is done (kept in this browser only, per plan)">done</th>
            <th>#</th>
            <th>step</th>
            <th>action</th>
            <th>verify</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((st) => {
            const n = st.number
            const done = checked.includes(n)
            const inputs = st.inputs || []
            const outputs = st.outputs || []
            const details = !!(st.why || inputs.length || outputs.length)
            return [
              <tr key={`s${n}`} className={done ? css.planStepDone : undefined} data-testid={`plan-step-${n}`} data-done={done ? 'true' : 'false'}>
                <td className={css.planDoneCell}>
                  <input type="checkbox" data-testid={`plan-step-${n}-done`} checked={done} onChange={() => onToggle(n)} aria-label={`step ${n} done`} title={done ? 'Untick: this step is not done after all' : 'Tick when this step is done (kept in this browser only, per plan)'} />
                </td>
                <td className={css.planNum}>{n}</td>
                <td className={css.planStepTitle}>{st.title}</td>
                <td className={css.planStepAction}>{st.action}</td>
                <td>{st.verify || <span className={css.muted}>—</span>}</td>
              </tr>,
              details ? (
                <tr key={`d${n}`} className={css.planDetailsRow} data-testid={`plan-step-${n}-details`}>
                  <td colSpan={5}>
                    <details>
                      <summary className={css.planSummary} title="Why this step is there, and what goes in and comes out of it">
                        why · inputs · outputs
                      </summary>
                      <dl className={css.planDl}>
                        {st.why ? (
                          <>
                            <dt>why</dt>
                            <dd>{st.why}</dd>
                          </>
                        ) : null}
                        {inputs.length ? (
                          <>
                            <dt>inputs</dt>
                            <dd>{inputs.join(', ')}</dd>
                          </>
                        ) : null}
                        {outputs.length ? (
                          <>
                            <dt>outputs</dt>
                            <dd>{outputs.join(', ')}</dd>
                          </>
                        ) : null}
                      </dl>
                    </details>
                  </td>
                </tr>
              ) : null,
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}

function Decisions({ items }) {
  if (!items.length) {
    return (
      <p className={css.planNone} data-testid="plan-decisions">
        (none — every difference was cleanly resolved)
      </p>
    )
  }
  return (
    <ol className={css.planList} data-testid="plan-decisions">
      {items.map((d, i) => (
        <li key={i} className={css.planDecision} data-testid={`plan-decision-${i + 1}`} data-divergence-id={d.divergence_id || ''}>
          <div className={css.planDecisionHead}>
            {d.divergence_id ? <span className={css.divId}>{d.divergence_id}</span> : null}
            <span>{d.topic}</span>
          </div>
          {(d.options || []).length ? (
            <ul className={css.planList}>
              {d.options.map((o, j) => (
                <li key={j}>{o}</li>
              ))}
            </ul>
          ) : null}
          {d.recommendation ? (
            <div>
              <span className={css.planCaption}>recommendation: </span>
              {d.recommendation}
            </div>
          ) : null}
          {d.rationale ? (
            <div>
              <span className={css.planCaption}>why: </span>
              {d.rationale}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function Risks({ items }) {
  if (!items.length) {
    return (
      <p className={css.planNone} data-testid="plan-risks">
        (none)
      </p>
    )
  }
  return (
    <ul className={css.planList} data-testid="plan-risks">
      {items.map((r, i) => (
        <li key={i}>
          {r.risk}
          {r.mitigation ? <span className={css.muted}> — {r.mitigation}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function DoneWhen({ items }) {
  if (!items.length) {
    return (
      <p className={css.planNone} data-testid="plan-done-when">
        (none given)
      </p>
    )
  }
  return (
    <ul className={css.planChecklist} data-testid="plan-done-when">
      {items.map((d, i) => (
        <li key={i}>
          <label>
            <input type="checkbox" disabled aria-label={`done when: ${d}`} />
            <span>{d}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

function Degraded({ turn }) {
  const attempts = Array.isArray(turn.raw_attempts) ? turn.raw_attempts : []
  return (
    <div className={css.planDegraded} data-testid="plan-degraded">
      <div>
        <strong>Plan degraded.</strong> {attempts.length > 1 ? 'The agent returned no valid plan after one retry.' : 'The agent returned no valid plan.'} Pick another agent or try again.
      </div>
      {turn.error ? <pre className={css.planPre}>{turn.error}</pre> : null}
      <details data-testid="plan-raw-attempts">
        <summary>raw attempts ({attempts.length})</summary>
        {attempts.map((raw, i) => (
          <pre key={i} className={css.planPre} data-testid={`plan-raw-attempt-${i + 1}`}>
            {raw || '(no output)'}
          </pre>
        ))}
      </details>
    </div>
  )
}

function Report({ turn, checked, onToggle }) {
  const p = turn.plan
  return (
    <div className={css.planBody} data-testid="plan-report">
      <h3 className={css.planH3}>Objective</h3>
      <p className={css.planObjective} data-testid="plan-objective">
        {p.objective}
      </p>
      <h3 className={css.planH3}>Prerequisites</h3>
      <Prerequisites items={p.prerequisites || []} />
      <h3 className={css.planH3}>Procedure</h3>
      <Steps steps={p.steps || []} checked={checked} onToggle={onToggle} />
      <h3 className={css.planH3}>
        Decision points
        <span className={css.planCaption}>what Fusion left standing is a choice here, never a silent pick</span>
      </h3>
      <Decisions items={p.decisions || []} />
      <h3 className={css.planH3}>Risks</h3>
      <Risks items={p.risks || []} />
      <h3 className={css.planH3}>Done when</h3>
      <DoneWhen items={p.done_when || []} />
      <div className={css.planMeta}>
        <span data-testid="plan-model-used">made by {turn.model}</span>
        {turn.usage ? (
          <span data-testid="plan-usage" className={css.planUsage}>
            plan usage: {usageSummary(turn.usage)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default function PlanSection({ conversation, fusion }) {
  const dispatch = useDispatch()
  const run = useRunStream()
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || EMPTY_MODELS
  // Desktop only: main's key status lives in the panes slice (read by KEY, never imported); the
  // web app has no such slice, so the key reads as not configured there.
  const panes = useSlice('panes')
  const plan = useSlice('plan') || initial()
  const desktop = isDesktop()
  const keyConfigured = !!(panes && panes.openRouterKey && panes.openRouterKey.configured)
  // Mirror of the displayed conversation id: a post-stream refetch that lands after the user
  // switched conversations is dropped (isCurrent) instead of snapping the UI back.
  const convIdRef = useRef(null)
  convIdRef.current = conversation ? conversation.id : null

  const [model, setModel] = useState(() => loadPlanModel(storage(), desktop))
  const turn = plan.turn
  const turnId = turn ? turn.id : null
  const [checked, setChecked] = useState(() => checkedSteps(storage(), turnId))
  // The ticks belong to ONE plan turn: a new plan (or a switch) starts from what that turn has stored.
  useEffect(() => {
    setChecked(checkedSteps(storage(), turnId))
  }, [turnId])

  if (!conversation || !fusion) return null

  const inFlight = plan.status === 'running' || plan.status === 'working'
  const gate = planGate({ fusion, streams })
  const groups = planModelOptions({ items: models.items || [], desktop, keyConfigured })
  const known = hasOption(groups, model)
  const stale = !!(turn && fusion.turnId && turn.of_fusion !== fusion.turnId)
  const replan = !!(turn && !stale)

  function onModel(e) {
    const value = e.target.value
    setModel(value)
    persistPlanModel(storage(), value)
  }

  function onToggle(n) {
    setChecked(toggleStep(storage(), turnId, n))
  }

  async function onRun() {
    const id = conversation.id
    const body = { of_fusion: fusion.turnId, model }
    if (replan) body.force = true
    let resolved = false
    try {
      await run('plan', `/api/conversations/${id}/plan`, body)
      resolved = true
    } catch {
      // HTTP failure: runStream already dispatched sse/end{ok:false,status,body}; the slice shows it.
    }
    if (resolved) {
      try {
        if (convIdRef.current === id) await loadConversation(dispatch, id, { isCurrent: (c) => convIdRef.current === c.id })
      } catch {
        /* the plan is already in the slice; a failed refetch only delays the button rule */
      }
    }
  }

  return (
    <div className={css.planRoot} data-testid="plan-root" data-status={plan.status}>
      <div className={css.planBar}>
        <span className={css.planTitle}>Plan</span>
        <label className={css.planPick} title={PICKER_TITLE}>
          <span>agent</span>
          <select className={css.planSelect} data-testid="plan-model" value={model} disabled={inFlight} onChange={onModel} aria-label="plan agent">
            {known ? null : <option value={model}>{model}</option>}
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button type="button" className={css.planRunBtn} data-testid="plan-run" disabled={!gate.enabled} onClick={onRun} title={gate.reason ? `Plan: ${gate.reason}` : replan ? RERUN_TITLE : RUN_TITLE}>
          {replan ? 'Re-plan' : 'Make a plan'}
        </button>
        <ExportControl feature="plan" conversationId={conversation.id} turnId={turnId} title={conversation.title} turnType="plan" busy={inFlight || anyStreaming(streams)} busyReason={inFlight ? 'Plan is running' : null} />
        {plan.status === 'done' && plan.cached ? (
          <span className={css.planChip} data-testid="plan-cached" title="Served from the existing plan turn for this Fusion report; no call was made">
            cached
          </span>
        ) : null}
        <span className={`${css.state} ${css[`state_${plan.status}`] || ''}`} data-testid="plan-status" data-status={plan.status}>
          {STATUS_TEXT[plan.status] || plan.status}
        </span>
      </div>

      {inFlight ? (
        <div className={css.progress} data-testid="plan-notice">
          {plan.notice || 'asking the agent for a plan…'}
        </div>
      ) : null}
      {plan.status === 'error' ? (
        <div className={css.error} data-testid="plan-error">
          Plan failed: {plan.error || 'unknown error'}
        </div>
      ) : null}
      {stale ? (
        <div className={css.stale} data-testid="plan-stale">
          this plan was made for an earlier Fusion report ({turn.of_fusion}); Make a plan again for the one shown
        </div>
      ) : null}
      {plan.status === 'degraded' && turn ? <Degraded turn={turn} /> : null}
      {turn && turn.plan ? <Report turn={turn} checked={checked} onToggle={onToggle} /> : null}
    </div>
  )
}
