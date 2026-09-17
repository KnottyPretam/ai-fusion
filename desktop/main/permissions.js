// desktop/main/permissions.js — per-partition permission policy (contract §5).
// Pure module: `decide(permission)` is the rule; `applyPermissionPolicy(session)` installs it on a
// session-like object (Electron's `session.fromPartition(...)` or a fake).
//
//   ALLOWED = clipboard-sanitized-write, fullscreen; everything else (media, geolocation,
//   notifications, midi, hid, serial, usb, pointerLock, openExternal, …) is denied, and every
//   device request (HID / serial / USB pickers) is refused.

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
