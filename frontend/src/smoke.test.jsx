import { render, screen } from '@testing-library/react'
import App from './App.jsx'

test('app renders the six pane slots', () => {
  render(<App />)
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'analyze-pane', 'fusion-pane', 'cost-meter']) {
    expect(screen.getByTestId(id)).toBeInTheDocument()
  }
})
