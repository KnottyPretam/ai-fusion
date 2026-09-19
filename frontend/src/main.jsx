import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'
import TooltipLayer from './components/TooltipLayer.jsx'

// FROZEN (integrator). The Electron preload (desktop/preload/renderer.cjs) exposes `window.triplex`
// through contextBridge; when it is present the desktop shell renders instead of the web app.
// Without it the web app is byte-for-byte what it was: App.jsx and its Playwright run are untouched.
const Root = typeof window !== 'undefined' && window.triplex ? DesktopApp : App

// StrictMode double-invokes effects on purpose: it is the canary for double-subscribed streams.
// One delegated tooltip for both shells: every control that describes itself with `title` (or a
// longer `data-tip`) shows a themed bubble after a beat, placed clear of the native site views.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
    <TooltipLayer />
  </StrictMode>,
)
