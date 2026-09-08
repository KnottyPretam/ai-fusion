// CostMeter (W12): footer meter — tokens / $ / latency / calls per feature, in two groups: the
// LAST invocation of each feature (PLAN §7) and the cumulative figures for this conversation
// (plus a Total row, the truncation count and the persistent cost-cap warning). Fusion's
// multiplier — the last Fusion's cost divided by the cost of the Send it fused — sits on the
// Fusion row so it is impossible to miss and never shrinks as the conversation grows.
import { Fragment } from 'react'
import { registerSlice } from '../../state/registry.js'
import { useSlice } from '../../state/store.jsx'
import { FEATURE_ROWS, initialMeter, meterReducer } from './slice.js'
import css from './meter.module.css'

registerSlice('meter', meterReducer, initialMeter)

const LABELS = { send: 'Send', analyze: 'Analyze', fusion: 'Fusion', total: 'Total' }
const GROUPS = [
  { key: 'last', label: 'last invocation' },
  { key: 'conv', label: 'this conversation' },
]

export function fmtInt(n) {
  return Math.round(n || 0).toLocaleString('en-US')
}

export function fmtUsd(n) {
  const v = n || 0
  if (v === 0) return '$0'
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`
}

export function fmtMs(ms) {
  const v = ms || 0
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
}

// The four cells of one group. Test ids: meter-<row>-<col> for the last-invocation group and
// meter-<row>-conv-<col> for the conversation group.
function Cells({ name, group, row, badge }) {
  const id = group === 'last' ? `meter-${name}` : `meter-${name}-conv`
  const first = group === 'conv' ? css.groupStart : undefined
  return (
    <>
      <td className={first} data-testid={`${id}-tokens`}>
        {fmtInt(row.prompt_tokens)} / {fmtInt(row.completion_tokens)}
        {row.reasoning_tokens > 0 && <span className={css.muted}> (+{fmtInt(row.reasoning_tokens)} reasoning)</span>}
      </td>
      <td data-testid={`${id}-cost`}>
        {fmtUsd(row.cost_usd)}
        {badge}
      </td>
      <td data-testid={`${id}-latency`}>{fmtMs(row.latency_ms)}</td>
      <td data-testid={`${id}-calls`}>{fmtInt(row.calls)}</td>
    </>
  )
}

function FeatureRow({ name, last, conv, mult, fusedSendCost }) {
  const badge =
    name === 'fusion' && mult !== null ? (
      <span
        className={css.mult}
        data-testid="meter-fusion-multiplier"
        title={`this Fusion's cost divided by the fused Send's cost (${fmtUsd(fusedSendCost)})`}
      >
        ×{mult.toFixed(1)} vs Send
      </span>
    ) : null
  return (
    <tr data-testid={`meter-row-${name}`}>
      <td className={`${css.feature} ${css[name] || ''}`}>{LABELS[name]}</td>
      <Cells name={name} group="last" row={last} badge={badge} />
      <Cells name={name} group="conv" row={conv} />
    </tr>
  )
}

export default function CostMeter() {
  const meter = useSlice('meter') || initialMeter()
  const fallback = initialMeter()
  const last = meter.last || fallback.last
  const fusedSendCost = meter.fusedSendCost || 0
  const lastFusion = last.fusion || fallback.last.fusion
  const mult = lastFusion.calls > 0 && fusedSendCost > 0 ? lastFusion.cost_usd / fusedSendCost : null
  const total = meter.total || fallback.total
  return (
    <div className={css.meter} data-testid="meter">
      {meter.costCapExceeded && (
        <div className={css.warn} role="alert" data-testid="meter-cost-cap">
          Session cost cap exceeded (SESSION_COST_CAP_USD): live model calls are being refused.
        </div>
      )}
      <table className={css.table}>
        <thead>
          <tr className={css.group}>
            <th />
            {GROUPS.map((g) => (
              <th key={g.key} colSpan={4} scope="colgroup" className={g.key === 'conv' ? css.groupStart : undefined} data-testid={`meter-group-${g.key}`}>
                {g.label}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">feature</th>
            {GROUPS.map((g) => (
              <Fragment key={g.key}>
                <th scope="col" className={g.key === 'conv' ? css.groupStart : undefined}>
                  tokens in / out
                </th>
                <th scope="col">cost</th>
                <th scope="col">latency</th>
                <th scope="col">calls</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURE_ROWS.map((name) => (
            <FeatureRow key={name} name={name} last={last[name] || fallback.last[name]} conv={meter[name] || fallback[name]} mult={mult} fusedSendCost={fusedSendCost} />
          ))}
          <tr data-testid="meter-row-total" className={css.total}>
            <td className={css.feature}>{LABELS.total}</td>
            <td colSpan={4} className={css.blank} />
            <Cells name="total" group="conv" row={total} />
          </tr>
        </tbody>
      </table>
      <div className={css.foot}>
        <span data-testid="meter-truncated" className={total.truncated > 0 ? css.trunc : undefined}>
          truncated replies: {fmtInt(total.truncated)}
        </span>
        <span>last = the most recent run of each feature · this conversation = every persisted turn · latency = feature wall clock</span>
      </div>
    </div>
  )
}
