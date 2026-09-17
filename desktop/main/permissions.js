// desktop/main/permissions.js — per-partition permission policy (contract §5).
// Pure module: `decide(permission)` is the rule; `applyPermissionPolicy(session)` installs it on a
// session-like object (Electron's `session.fromPartition(...)` or a fake);
// `attachDeviceChooserPolicy(webContents)` cancels the one device picker that is NOT a session
// permission — Web Bluetooth's `select-bluetooth-device` — on a webContents-like object.
//
//   ALLOWED = clipboard-sanitized-write, fullscreen; everything else (media, geolocation,
//   notifications, midi, hid, serial, usb, pointerLock, openExternal, …) is denied, and every
//   device request (HID / serial / USB pickers) is refused. `navigator.bluetooth.requestDevice()`
//   is gated by the webContents event instead: a listener that does not preventDefault lets
//   Electron pick the first device, so ours prevents and answers '' (= cancel).

export const ALLOWED = Object.freeze(['clipboard-sanitized-write', 'fullscreen'])

const ALLOWED_SET = new Set(ALLOWED)

/** True only for the two allow-listed permissions; any non-string is denied. */
export function decide(permission) {
  return typeof permission === 'string' && ALLOWED_SET.has(permission)
}

/**
 * Install the request / check / device handlers on `ses`. The handlers ignore the requesting
 * webContents and origin on purpose: the rule is per permission name, identical for every page.
 */
export function applyPermissionPolicy(ses) {
  if (!ses) return
  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(decide(permission))
    })
  }
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_webContents, permission) => decide(permission))
  }
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false)
  }
}

const chooserPoliced = new WeakSet()

/**
 * Cancel every Web Bluetooth device request on `wc` (`select-bluetooth-device` → preventDefault +
 * callback('')). Idempotent: the renderer window, the site views and the process-wide backstop in
 * main.js may all call it; only the first call installs the listener. Returns the handler (or
 * null when nothing was installed).
 */
export function attachDeviceChooserPolicy(wc) {
  if (!wc || typeof wc.on !== 'function') return null
  if (chooserPoliced.has(wc)) return null
  const onSelectBluetoothDevice = (event, _devices, callback) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (typeof callback === 'function') {
      try {
        callback('')
      } catch (_e) {
        /* the request is already gone */
      }
    }
  }
  wc.on('select-bluetooth-device', onSelectBluetoothDevice)
  chooserPoliced.add(wc)
  return onSelectBluetoothDevice
}

/** True once `attachDeviceChooserPolicy` ran on this webContents. */
export function hasDeviceChooserPolicy(wc) {
  return !!wc && typeof wc === 'object' && chooserPoliced.has(wc)
}
