// Council (2026-09-27): in desktop mode the cost column, Fusion's multiplier and the cap alert come
// back as soon as a council member (or the analyst) of the open conversation is on OpenRouter — a
// token agent is metered like the web app's. All-web / all-local councils keep the no-cost table.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen } from '@testing-library/react'
import CostMeter, { anyOnOpenRouter, transportOf } from './index.jsx'
import { initialMeter, meterReducer } from './slice.js'
import { applyEvents, renderWithStore, sample } from '../../state/testing.jsx'

afterEach(() => vi.unstubAllGlobals())

const WEB = { slots: { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' } }, analyst_model: 'web:chatgpt:analyst', max_iterations: 2, materiality_min: 'medium', grounded: false }
const LOCAL = { ...WEB, slots: { ...WEB.slots, qwen: { model: 'ollama:qwen3', effort: 'off' } }, analyst_model: 'ollama:hermes3' }
const MIXED = { ...WEB, slots: { ...WEB.slots, gemini: { model: 'google/gemini-2.5-pro', effort: 'medium' } } }
const OR_ANALYST = { ...WEB, analyst_model: 'openai/gpt-5' }

function meterState() {
  const s = applyEvents('send', [sample.turnStart(), sample.slotStart('claude'), sample.slotDone('claude', { cost_usd: 0.003 }), sample.slotStart('gemini'), sample.slotDone('gemini', { cost_usd: 0.002 }), sample.turnDone()])
  return s.meter
}
const cols = () => [...screen.getByTestId('meter').querySelectorAll('thead tr')[1].querySelectorAll('th')].map((th) => th.textContent)

describe('anyOnOpenRouter', () => {
  test('a member or the analyst on an OpenRouter slug; never web: / ollama:', () => {
    expect(transportOf('google/gemini-2.5-pro')).toBe('openrouter')
    expect(anyOnOpenRouter(WEB)).toBe(false)
    expect(anyOnOpenRouter(LOCAL)).toBe(false)
    expect(anyOnOpenRouter(MIXED)).toBe(true)
    expect(anyOnOpenRouter(OR_ANALYST)).toBe(true)
    expect(anyOnOpenRouter(null)).toBe(false)
    expect(anyOnOpenRouter({ slots: {} })).toBe(false)
  })
})

describe('CostMeter in desktop mode', () => {
  test('all-web / all-local: no cost column (data-cost=false); a member on OpenRouter brings cost, the multiplier and the cap alert back', () => {
    const meter = { ...meterState(), costCapExceeded: true }
    const { unmount } = renderWithStore(<CostMeter desktop />, { preloaded: { meter, slotConfig: LOCAL } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'desktop')
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'false')
    expect(screen.queryByTestId('meter-send-cost')).toBeNull()
    expect(screen.queryByTestId('meter-cost-cap')).toBeNull()
    expect(cols()).toEqual(['feature', 'tokens in / out', 'latency', 'calls', 'tokens in / out', 'latency', 'calls'])
    unmount()
    renderWithStore(<CostMeter desktop />, { preloaded: { meter, slotConfig: MIXED } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'desktop')
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'true')
    expect(screen.getByTestId('meter-group-last')).toHaveAttribute('colspan', '4')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00500')
    expect(screen.getByTestId('meter-cost-cap')).toHaveTextContent(/cost cap exceeded/i)
    expect(cols()).toEqual(['feature', 'tokens in / out', 'cost', 'latency', 'calls', 'tokens in / out', 'cost', 'latency', 'calls'])
    expect(screen.getByTestId('meter')).toHaveTextContent('an OpenRouter agent is metered with the saved key')
  })

  test('an OpenRouter analyst alone brings the cost column back; the showCost prop overrides both ways', () => {
    const meter = meterState()
    const { unmount } = renderWithStore(<CostMeter desktop />, { preloaded: { meter, slotConfig: OR_ANALYST } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'true')
    unmount()
    const { unmount: u2 } = renderWithStore(<CostMeter desktop showCost={false} />, { preloaded: { meter, slotConfig: MIXED } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'false')
    u2()
    renderWithStore(<CostMeter desktop showCost />, { preloaded: { meter, slotConfig: WEB } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'true')
  })

  test('the web app is untouched: cost always, whatever the config', () => {
    renderWithStore(<CostMeter desktop={false} />, { preloaded: { meter: meterState(), slotConfig: WEB } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'web')
    expect(screen.getByTestId('meter')).toHaveAttribute('data-cost', 'true')
    expect(screen.getByTestId('meter-send-cost')).toBeInTheDocument()
    expect(meterReducer(initialMeter(), { type: 'noop' })).toEqual(initialMeter())
  })
})
