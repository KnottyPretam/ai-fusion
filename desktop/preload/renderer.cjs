'use strict'
// desktop/preload/renderer.cjs — exposes `window.triplex` to the renderer (contract §2, Stage 1 surface).
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
//   invoke 'prompt:send'        ({targets, text})        → {results}        (Stage 1 only)
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
  // Stage 1 only (removed in Stage 2):
  sendPrompt: (req) => ipcRenderer.invoke('prompt:send', req),
})

contextBridge.exposeInMainWorld('triplex', api)
