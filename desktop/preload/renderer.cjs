'use strict'
// desktop/preload/renderer.cjs — exposes `window.triplex` to the renderer (contract §2, Stage 1–3 surface).
//
// Sandboxed preload (`sandbox:true`, `contextIsolation:true`): only 'electron' is requirable.
// `ipcRenderer` itself is never exposed; every method maps to exactly one channel:
//
//   invoke 'panes:getInfo'      ()                       → info
//   send   'panes:layout'       (layout)                 layout = {[slot|'analyst']: {x,y,width,height}|null}
//   send   'panes:active'       ({mode, active})
//   invoke 'panes:newChat'      (targets)                targets = slot[]
//   invoke 'panes:reload'       (slot)
//   invoke 'panes:openExternal' (slot)
//   invoke 'panes:inspect'      (slot)                   no-op unless dev
//   invoke 'panes:focus'        (slot)
//   invoke 'panes:zoom'         (slot, direction)        direction ∈ 'in'|'out'|'reset' → {factor}
//   on     'panes:health'       cb(slot, health)
//   on     'panes:shortcut'     cb({name})
//   on     'panes:zoom'         cb({slot, factor})
//   Stage 2:
//   invoke 'panes:getCapture'   ()                       → {[slot]: boolean}
//   invoke 'panes:setCapture'   (slot, on)
//   on     'panes:bridge'       cb({connected, since?})
//   on     'panes:turn'         cb({slot, phase, code?})  phase ∈ idle|typing|submitted|replying|done|error
//   invoke 'panes:openChats'    (convId|null)             → {[slot]: 'navigated'|'new'|'kept'}
//   invoke 'panes:signOut'      (slot)                   clearStorageData for that partition only, then newChatUrl
//   invoke 'panes:snapshot'     (slot)                   → {path}   (scrubbed HTML under userData/snapshots/)
//   Export (a step → files):
//   invoke 'panes:export'       ({conversationId, turnId, formats, title?, turnType?})
//                               formats = a non-empty subset of ['md','html','pdf']; ONE save dialog per call,
//                               so all three formats are one dialog and three files beside each other
//   Stage 3:
//   invoke 'panes:setAnalyst'   (slot|null)              choose the hidden analyst page's login (null = none)
//   invoke 'panes:showAnalyst'  (visible:boolean)        reveal / hide the analyst view as a fourth tab
//   on     'panes:analyst'      cb({slot, visible, health})
//   Theme:
//   invoke 'panes:setTheme'     ('light'|'dark'|'system')  persists settings.theme + nativeTheme → {theme}
//   on     'panes:theme'        cb({theme})               replayed like health/zoom/bridge
//
// Main validates every payload and rejects violations with Error('bad_request').

const { contextBridge, ipcRenderer } = require('electron')

// Kept in sync with desktop/package.json by the integrator (a sandboxed preload cannot read it).
const VERSION = '0.1.0'
const SLOTS = Object.freeze(['claude', 'chatgpt', 'grok'])

function subscribe(channel) {
  return (cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function')
    const listener = (_event, ...args) => {
      cb(...args)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

const api = Object.freeze({
  version: VERSION,
  slots: SLOTS,
  getInfo: () => ipcRenderer.invoke('panes:getInfo'),
  setLayout: (layout) => {
    ipcRenderer.send('panes:layout', layout)
  },
  setActive: (state) => {
    ipcRenderer.send('panes:active', state)
  },
  newChat: (targets) => ipcRenderer.invoke('panes:newChat', targets),
  reload: (slot) => ipcRenderer.invoke('panes:reload', slot),
  openExternal: (slot) => ipcRenderer.invoke('panes:openExternal', slot),
  inspect: (slot) => ipcRenderer.invoke('panes:inspect', slot),
  focusPane: (slot) => ipcRenderer.invoke('panes:focus', slot),
  zoom: (slot, direction) => ipcRenderer.invoke('panes:zoom', slot, direction),
  onHealth: subscribe('panes:health'),
  onShortcut: subscribe('panes:shortcut'),
  onZoom: subscribe('panes:zoom'),
  // Stage 2 (PromptBar sends through POST /send; the bridge drives the views):
  getCapture: () => ipcRenderer.invoke('panes:getCapture'),
  setCapture: (slot, on) => ipcRenderer.invoke('panes:setCapture', slot, on),
  onBridge: subscribe('panes:bridge'),
  onTurn: subscribe('panes:turn'),
  openChats: (convId) => ipcRenderer.invoke('panes:openChats', convId),
  signOut: (slot) => ipcRenderer.invoke('panes:signOut', slot),
  saveDomSnapshot: (slot) => ipcRenderer.invoke('panes:snapshot', slot),
  exportTurn: (req) => ipcRenderer.invoke('panes:export', req),
  // Stage 3 (handlers arrive with analyst-view; until then main rejects them as unregistered):
  setAnalyst: (slot) => ipcRenderer.invoke('panes:setAnalyst', slot),
  showAnalyst: (visible) => ipcRenderer.invoke('panes:showAnalyst', visible),
  onAnalyst: subscribe('panes:analyst'),
  // Theme (settings.json is authoritative; the renderer mirrors it into localStorage for the first paint):
  setTheme: (theme) => ipcRenderer.invoke('panes:setTheme', theme),
  onTheme: subscribe('panes:theme'),
})

contextBridge.exposeInMainWorld('triplex', api)
