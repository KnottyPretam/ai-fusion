// The refactored view (S11), rendered INSIDE the Analyze pane: the restated question, the knowledge
// graph, and the three responses reduced to a summary plus claims. Refactor is an OPTION ON ANALYZE —
// its button sits beside the Analyze button and Analyze compares this artifact instead of the raw
// answers — so it lives in the analyze feature rather than as a pane of its own, and no feature has to
// import across to another.
//
// Presentational only: every button, the run wiring and the export control are in AnalyzePane, which
// owns the toolbar the user asked for. Labels are R1/R2/R3; this component never sees a slot name.
//
// data-testids (for Playwright):
//   refactor-report              the refactored view
//   refactor-question            the restated question
//   refactor-graph-nodes         <table> of things; refactor-node-<id> rows
//   refactor-graph-edges         <table> of relations; refactor-edge-<n> rows
//   refactor-replies             the three reduced responses; refactor-reply-<label>,
//                                refactor-summary-<label>, refactor-claim-<label>-<n>
//   refactor-degraded            degraded box; refactor-fallback inside it
//   refactor-raw-attempts        <details> with refactor-raw-attempt-<n> <pre> blocks
import { edgeRows } from './refactorSlice.js'
import css from './refactor.module.css'

export const FALLBACK_NOTE = 'Analyze falls back to comparing the responses as they were sent.'

export default function RefactorView({ refactor }) {
  const turn = refactor && refactor.turn
  const ref = turn && turn.refactoring
  const nodes = (ref && ref.graph && ref.graph.nodes) || []
  const edges = ref ? edgeRows(ref.graph) : []

  if (refactor && refactor.status === 'degraded') {
    return (
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
    )
  }

  if (!ref) return null

  return (
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
  )
}
