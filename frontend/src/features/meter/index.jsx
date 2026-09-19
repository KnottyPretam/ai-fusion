// CostMeter (W12): footer meter — tokens / $ / latency / calls per feature, in two groups: the
// LAST invocation of each feature (PLAN §7) and the cumulative figures for this conversation
// (plus a Total row, the truncation count and the persistent cost-cap warning). Fusion's
// multiplier — the last Fusion's cost divided by the cost of the Send it fused — sits on the
// Fusion row so it is impossible to miss and never shrinks as the conversation grows.
// Stage 3 (renderer-drawer): desktop mode — `desktop` prop, defaulting to "window.triplex exists"
// (the Electron preload's contextBridge surface) — drops the COST column, Fusion's multiplier badge
// and the cost-cap warning (`data-mode="desktop"`): a web session is billed by the site, not by
// Triplex, and a local Ollama call is free. Tokens stay: `ollama.sanitize_payload` asks for usage,
// so an Ollama analyst reports real prompt / completion counts (a web session reports 0 / 0), and
// hiding them would hide the only context-pressure figure the desktop app has. The web app is
// byte-identical.
import { Fragment } from 'react'
import { registerSlice } from '../../state/registry.js'
import { useSlice } from '../../state/store.jsx'
import { FEATURE_ROWS, initialMeter, meterReducer } from './slice.js'
import css from './meter.module.css'
import { APP_NAME } from '../../branding.js'

registerSlice('meter', meterReducer, initialMeter)

const LABELS = { send: 'Send', analyze: 'Analyze', fusion: 'Fusion', total: 'Total' }
const GROUPS = [
  { key: 'last', label: 'last invocation' },
  { key: 'conv', label: 'this conversation' },
]

/** True under the Electron renderer (desktop/preload/renderer.cjs exposes `window.triplex`). */
export function isDesktop() {
  return typeof window !== 'undefined' && !!window.triplex
}

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

// The four cells of one group (three in desktop mode: no cost). Test ids: meter-<row>-<col>
// for the last-invocation group and meter-<row>-conv-<col> for the conversation group.
function Cells({ name, group, row, badge, desktop = false }) {
  const id = group === 'last' ? `meter-${name}` : `meter-${name}-conv`
  const first = group === 'conv' ? css.groupStart : undefined
  return (
    <>
      <td className={first} data-testid={`${id}-tokens`}>
        {fmtInt(row.prompt_tokens)} / {fmtInt(row.completion_tokens)}
        {row.reasoning_tokens > 0 && <span className={css.muted}> (+{fmtInt(row.reasoning_tokens)} reasoning)</span>}
      </td>
      {desktop ? null : (
        <td data-testid={`${id}-cost`}>
          {fmtUsd(row.cost_usd)}
          {badge}
        </td>
      )}
      <td data-testid={`${id}-latency`}>{fmtMs(row.latency_ms)}</td>
      <td data-testid={`${id}-calls`}>{fmtInt(row.calls)}</td>
    </>
  )
}

function FeatureRow({ name, last, conv, mult, fusedSendCost, desktop = false }) {
  const badge =
    !desktop && name === 'fusion' && mult !== null ? (
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
      <Cells name={name} group="last" row={last} badge={badge} desktop={desktop} />
      <Cells name={name} group="conv" row={conv} desktop={desktop} />
    </tr>
  )
}

export default function CostMeter({ desktop = isDesktop() }) {
  const meter = useSlice('meter') || initialMeter()
  const fallback = initialMeter()
  const last = meter.last || fallback.last
  const fusedSendCost = meter.fusedSendCost || 0
  const lastFusion = last.fusion || fallback.last.fusion
  const mult = lastFusion.calls > 0 && fusedSendCost > 0 ? lastFusion.cost_usd / fusedSendCost : null
  const total = meter.total || fallback.total
  const cols = desktop ? 3 : 4
  return (
    <div className={css.meter} data-testid="meter" data-mode={desktop ? 'desktop' : 'web'}>
      {!desktop && meter.costCapExceeded && (
        <div className={css.warn} role="alert" data-testid="meter-cost-cap">
          Session cost cap exceeded (SESSION_COST_CAP_USD): live model calls are being refused.
        </div>
      )}
      <table className={css.table}>
        <thead>
          <tr className={css.group}>
            <th />
            {GROUPS.map((g) => (
              <th key={g.key} colSpan={cols} scope="colgroup" className={g.key === 'conv' ? css.groupStart : undefined} data-testid={`meter-group-${g.key}`}>
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
                {desktop ? null : <th scope="col">cost</th>}
                <th scope="col">latency</th>
                <th scope="col">calls</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURE_ROWS.map((name) => (
            <FeatureRow key={name} name={name} last={last[name] || fallback.last[name]} conv={meter[name] || fallback[name]} mult={mult} fusedSendCost={fusedSendCost} desktop={desktop} />
          ))}
          <tr data-testid="meter-row-total" className={css.total}>
            <td className={css.feature}>{LABELS.total}</td>
            <td colSpan={cols} className={css.blank} />
            <Cells name="total" group="conv" row={total} desktop={desktop} />
          </tr>
        </tbody>
      </table>
      <div className={css.foot}>
        <span data-testid="meter-truncated" className={total.truncated > 0 ? css.trunc : undefined}>
          truncated replies: {fmtInt(total.truncated)}
        </span>
        <span>
          {desktop
            ? `last = the most recent run of each feature · this conversation = every persisted turn · latency = feature wall clock · a web session reports no tokens and is billed by the site, not by ${APP_NAME}; a local Ollama analyst reports its tokens at no cost`
            : 'last = the most recent run of each feature · this conversation = every persisted turn · latency = feature wall clock'}
        </span>
      </div>
    </div>
  )
}
