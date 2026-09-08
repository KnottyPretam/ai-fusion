// CostMeter (W12): footer meter — tokens / $ / latency / calls per feature for the current
// conversation, a total, the truncation count and the persistent cost-cap warning. Fusion's
// multiplier (its cost relative to Send) is shown inline so it is impossible to miss.
import { registerSlice } from '../../state/registry.js'
import { useSlice } from '../../state/store.jsx'
import { FEATURE_ROWS, initialMeter, meterReducer } from './slice.js'
import css from './meter.module.css'

registerSlice('meter', meterReducer, initialMeter)

const LABELS = { send: 'Send', analyze: 'Analyze', fusion: 'Fusion', total: 'Total' }

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

function Row({ name, row, sendCost }) {
  const isTotal = name === 'total'
  const mult = name === 'fusion' && row.calls > 0 && sendCost > 0 ? row.cost_usd / sendCost : null
  return (
    <tr data-testid={`meter-row-${name}`} className={isTotal ? css.total : undefined}>
      <td className={`${css.feature} ${css[name] || ''}`}>{LABELS[name]}</td>
      <td data-testid={`meter-${name}-tokens`}>
        {fmtInt(row.prompt_tokens)} / {fmtInt(row.completion_tokens)}
        {row.reasoning_tokens > 0 && <span className={css.muted}> (+{fmtInt(row.reasoning_tokens)} reasoning)</span>}
      </td>
      <td data-testid={`meter-${name}-cost`}>
        {fmtUsd(row.cost_usd)}
        {mult !== null && (
          <span className={css.mult} data-testid="meter-fusion-multiplier" title="Fusion cost divided by Send cost">
            ×{mult.toFixed(1)} vs Send
          </span>
        )}
      </td>
      <td data-testid={`meter-${name}-latency`}>{fmtMs(row.latency_ms)}</td>
      <td data-testid={`meter-${name}-calls`}>{fmtInt(row.calls)}</td>
    </tr>
  )
}

export default function CostMeter() {
  const meter = useSlice('meter') || initialMeter()
  const fallback = initialMeter()
  const sendCost = (meter.send || fallback.send).cost_usd
  return (
    <div className={css.meter} data-testid="meter">
      {meter.costCapExceeded && (
        <div className={css.warn} role="alert" data-testid="meter-cost-cap">
          Session cost cap exceeded (SESSION_COST_CAP_USD): live model calls are being refused.
        </div>
      )}
      <table className={css.table}>
        <thead>
          <tr>
            <th>feature</th>
            <th>tokens in / out</th>
            <th>cost</th>
            <th>latency</th>
            <th>calls</th>
          </tr>
        </thead>
        <tbody>
          {[...FEATURE_ROWS, 'total'].map((name) => (
            <Row key={name} name={name} row={meter[name] || fallback[name]} sendCost={sendCost} />
          ))}
        </tbody>
      </table>
      <div className={css.foot}>
        <span data-testid="meter-truncated" className={(meter.total || fallback.total).truncated > 0 ? css.trunc : undefined}>
          truncated replies: {fmtInt((meter.total || fallback.total).truncated)}
        </span>
        <span>latency = feature wall clock, cumulative for this conversation</span>
      </div>
    </div>
  )
}
