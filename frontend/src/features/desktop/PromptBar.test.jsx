import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './index.jsx' // registers the `panes` slice
import PromptBar, { errorCode, formatResult, resultTitle } from './PromptBar.jsx'
import { initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useSlice } from '../../state/store.jsx'
import { fakeTriplex } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Probe() {
  const p = useSlice('panes')
  return <div data-testid="probe">{`${p.mode}:${p.active}:${p.sending}`}</div>
}

function mount(fake, over = {}) {
  return renderWithStore(
    <>
      <PromptBar api={fake} />
      <Probe />
    </>,
    { preloaded: { panes: { ...initialPanes(), ...over } } },
  )
}

const composer = () => screen.getByTestId('prompt-composer')
const sendBtn = () => screen.getByTestId('prompt-send')
const type = (text) => fireEvent.change(composer(), { target: { value: text } })
const enter = (init = {}) => fireEvent.keyDown(composer(), { key: 'Enter', code: 'Enter', ...init })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('PromptBar: pure helpers', () => {
  test('formatResult / resultTitle / errorCode', () => {
    expect(formatResult({ ok: true, ms: 1234, composerSelector: '#prompt-textarea' })).toBe('✓ 1.2 s · #prompt-textarea')
    expect(formatResult({ ok: true, ms: 80 })).toBe('✓ 0.1 s')
    expect(formatResult({ ok: false, code: 'send_not_found' })).toBe('✗ send_not_found')
    expect(formatResult({ ok: false })).toBe('✗ error')
    expect(formatResult(null)).toBe('')
    expect(resultTitle({ ok: false, code: 'x', message: 'no send button', sendSelector: "button[aria-label='Submit']", url: 'https://grok.com/' })).toBe(
      "no send button\nsend: button[aria-label='Submit']\nurl: https://grok.com/",
    )
    expect(errorCode(new Error("Error invoking remote method 'prompt:send': Error: bad_request"))).toBe('bad_request')
    expect(errorCode(new Error('bad_request'))).toBe('bad_request')
    expect(errorCode('')).toBe('ipc_error')
    expect(errorCode(null)).toBe('ipc_error')
  })
})

describe('PromptBar: composer and Send', () => {
  test('Enter sends {targets, text} through sendPrompt; the composer clears when every target succeeded', async () => {
    const fake = fakeTriplex()
    mount(fake)
    type('hello `x` "y" ${z}\nline2')
    enter()
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    expect(fake.sendPrompt).toHaveBeenCalledWith({ targets: ['claude', 'chatgpt', 'grok'], text: 'hello `x` "y" ${z}\nline2' })
    await waitFor(() => expect(composer()).toHaveValue(''))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false')
  })

  test('Shift+Enter does not send; an IME composition does not send', () => {
    const fake = fakeTriplex()
    mount(fake)
    type('draft')
    enter({ shiftKey: true })
    enter({ isComposing: true })
    enter({ keyCode: 229 })
    expect(fake.sendPrompt).not.toHaveBeenCalled()
    expect(composer()).toHaveValue('draft')
  })

  test('Send is disabled while empty, while no target is checked, and while sending', async () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn().title).toMatch(/type a prompt/)
    type('   ')
    expect(sendBtn()).toBeDisabled()
    enter()
    expect(fake.sendPrompt).not.toHaveBeenCalled()
    type('go')
    expect(sendBtn()).toBeEnabled()
    for (const slot of ['claude', 'chatgpt', 'grok']) fireEvent.click(screen.getByTestId(`prompt-target-${slot}`))
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn().title).toMatch(/at least one target/)
    enter()
    expect(fake.sendPrompt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('prompt-target-grok'))
    expect(sendBtn()).toBeEnabled()
  })

  test('a subset of targets is sent as a subset; the checkboxes persist in the slice', () => {
    const fake = fakeTriplex()
    mount(fake, { targets: { claude: false, chatgpt: true, grok: true } })
    expect(screen.getByTestId('prompt-target-claude')).not.toBeChecked()
    expect(screen.getByTestId('prompt-target-chatgpt')).toBeChecked()
    type('subset')
    fireEvent.click(sendBtn())
    expect(fake.sendPrompt).toHaveBeenCalledWith({ targets: ['chatgpt', 'grok'], text: 'subset' })
  })

  test('locks while the send is in flight, then unlocks; a result line per target', async () => {
    const d = deferred()
    const fake = fakeTriplex({ sendPrompt: vi.fn(() => d.promise) })
    mount(fake)
    type('lock me')
    enter()
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn()).toHaveTextContent('Sending…')
    expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'true')
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(screen.getByTestId(`prompt-result-${slot}`)).toHaveAttribute('data-ok', 'pending')
    // Enter during a send is ignored
    enter()
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    await act(async () => {
      d.resolve({
        results: {
          claude: { ok: true, ms: 1234, composerSelector: 'div[contenteditable=\'true\'].ProseMirror', sendSelector: "button[aria-label='Send message']" },
          chatgpt: { ok: false, code: 'send_not_found', message: 'no visible send button', ms: 18000 },
          grok: { ok: true, ms: 80, composerSelector: "textarea[aria-label='Ask Grok anything']" },
        },
      })
    })
    expect(sendBtn()).toBeEnabled()
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false')
    expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent("Claude ✓ 1.2 s · div[contenteditable='true'].ProseMirror")
    expect(screen.getByTestId('prompt-result-claude')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('prompt-result-chatgpt')).toHaveTextContent('ChatGPT ✗ send_not_found')
    expect(screen.getByTestId('prompt-result-chatgpt')).toHaveAttribute('data-ok', 'false')
    expect(screen.getByTestId('prompt-result-chatgpt').title).toContain('no visible send button')
    expect(screen.getByTestId('prompt-result-grok')).toHaveTextContent("Grok ✓ 0.1 s · textarea[aria-label='Ask Grok anything']")
    // one target failed → the text is kept for a retry
    expect(composer()).toHaveValue('lock me')
  })

  test('text typed during the send is never clobbered by the clear', async () => {
    const d = deferred()
    const fake = fakeTriplex({ sendPrompt: vi.fn(() => d.promise) })
    mount(fake)
    type('first')
    enter()
    type('second draft')
    await act(async () => {
      d.resolve({ results: { claude: { ok: true, ms: 1 }, chatgpt: { ok: true, ms: 1 }, grok: { ok: true, ms: 1 } } })
    })
    expect(composer()).toHaveValue('second draft')
  })

  test('a rejected sendPrompt (bad_request) becomes a ✗ line per target and unlocks', async () => {
    const fake = fakeTriplex({ sendPrompt: vi.fn(async () => { throw new Error("Error invoking remote method 'prompt:send': Error: bad_request") }) })
    mount(fake, { targets: { claude: true, chatgpt: false, grok: false } })
    type('x')
    enter()
    await waitFor(() => expect(sendBtn()).toBeEnabled())
    expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('Claude ✗ bad_request')
    expect(screen.queryByTestId('prompt-result-chatgpt')).toBeNull()
    expect(composer()).toHaveValue('x')
  })

  test('a target missing from the results, or a stub without sendPrompt, is a ✗ line rather than a hang', async () => {
    const fake = fakeTriplex({ sendPrompt: vi.fn(async () => ({ results: { claude: { ok: true, ms: 5 } } })) })
    const first = mount(fake, { targets: { claude: true, chatgpt: true, grok: false } })
    type('partial')
    enter()
    await waitFor(() => expect(sendBtn()).toBeEnabled())
    expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('✓')
    expect(screen.getByTestId('prompt-result-chatgpt')).toHaveTextContent('ChatGPT ✗ no_result')
    first.unmount()
    renderWithStore(<PromptBar api={{}} />, { preloaded: { panes: { ...initialPanes(), targets: { claude: true, chatgpt: false, grok: false } } } })
    type('no api')
    enter()
    await waitFor(() => expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('✗ unavailable'))
    expect(sendBtn()).toBeEnabled()
  })

  test('typing with the keyboard (userEvent) works and Enter sends once', async () => {
    const user = userEvent.setup()
    const fake = fakeTriplex()
    mount(fake)
    await user.type(composer(), 'typed{Shift>}{Enter}{/Shift}more')
    expect(composer()).toHaveValue('typed\nmore')
    expect(fake.sendPrompt).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    expect(fake.sendPrompt.mock.calls[0][0].text).toBe('typed\nmore')
  })
})

describe('PromptBar: auto-reveal and New chat everywhere', () => {
  test('a logged_out result reveals that tab in tabs mode', async () => {
    const fake = fakeTriplex({
      sendPrompt: vi.fn(async () => ({
        results: { claude: { ok: true, ms: 1 }, chatgpt: { ok: true, ms: 1 }, grok: { ok: false, code: 'logged_out', message: 'sign in first', ms: 0 } },
      })),
    })
    mount(fake, { mode: 'tabs', active: 'chatgpt' })
    type('reveal')
    enter()
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tabs:grok:false'))
    expect(screen.getByTestId('prompt-result-grok')).toHaveTextContent('Grok ✗ logged_out')
  })

  test('challenge and blocked reveal too; the first attention slot in SLOT order wins', async () => {
    for (const [code, expected] of [
      ['challenge', 'claude'],
      ['blocked', 'claude'],
    ]) {
      const fake = fakeTriplex({
        sendPrompt: vi.fn(async () => ({ results: { claude: { ok: false, code, ms: 0 }, chatgpt: { ok: true, ms: 1 }, grok: { ok: false, code: 'logged_out', ms: 0 } } })),
      })
      const { unmount } = mount(fake, { mode: 'tabs', active: 'chatgpt' })
      type(code)
      enter()
      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`tabs:${expected}:false`))
      unmount()
    }
  })

  test('other failures never switch the tab, and split mode never switches', async () => {
    const fake = fakeTriplex({ sendPrompt: vi.fn(async () => ({ results: { claude: { ok: false, code: 'send_not_found', ms: 0 }, chatgpt: { ok: true, ms: 1 }, grok: { ok: true, ms: 1 } } })) })
    const first = mount(fake, { mode: 'tabs', active: 'chatgpt' })
    type('x')
    enter()
    await waitFor(() => expect(sendBtn()).toBeEnabled())
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:chatgpt:false')
    first.unmount()
    const fake2 = fakeTriplex({ sendPrompt: vi.fn(async () => ({ results: { claude: { ok: false, code: 'logged_out', ms: 0 }, chatgpt: { ok: true, ms: 1 }, grok: { ok: true, ms: 1 } } })) })
    mount(fake2, { mode: 'split', active: 'chatgpt' })
    type('y')
    enter()
    await waitFor(() => expect(fake2.sendPrompt).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('logged_out'))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false')
  })

  test('New chat everywhere passes the selected targets and is disabled with none', () => {
    const fake = fakeTriplex()
    mount(fake, { targets: { claude: true, chatgpt: false, grok: true } })
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    expect(fake.newChat).toHaveBeenCalledWith(['claude', 'grok'])
    fireEvent.click(screen.getByTestId('prompt-target-claude'))
    fireEvent.click(screen.getByTestId('prompt-target-grok'))
    expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
    expect(fake.newChat).toHaveBeenCalledTimes(1)
  })

  test('a rejected newChat never surfaces', async () => {
    const fake = fakeTriplex({ newChat: vi.fn(async () => { throw new Error('bad_request') }) })
    mount(fake)
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('prompt-newchat')).toBeEnabled()
  })
})
