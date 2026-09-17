import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'

// FROZEN (integrator). The Electron preload (desktop/preload/renderer.cjs) exposes `window.triplex`
// through contextBridge; when it is present the desktop shell renders instead of the web app.
// Without it the web app is byte-for-byte what it was: App.jsx and its Playwright run are untouched.
const Root = typeof window !== 'undefined' && window.triplex ? DesktopApp : App

// StrictMode double-invokes effects on purpose: it is the canary for double-subscribed streams.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
