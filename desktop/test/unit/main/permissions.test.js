// permissions.js — media / geolocation / notifications denied, clipboard-sanitized-write allowed,
// the Bluetooth device chooser cancelled per webContents.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, ALLOWED, applyPermissionPolicy, attachDeviceChooserPolicy, hasDeviceChooserPolicy } from '../../../main/permissions.js'
import { fakeSession, fakeWebContents } from './_fakes.js'

test('decide: only clipboard-sanitized-write and fullscreen are allowed', () => {
  assert.deepEqual([...ALLOWED], ['clipboard-sanitized-write', 'fullscreen'])
  assert.equal(decide('clipboard-sanitized-write'), true)
  assert.equal(decide('fullscreen'), true)
  for (const denied of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'hid', 'serial', 'usb', 'clipboard-read', 'display-capture', 'idle-detection', 'window-management', 'unknown']) {
    assert.equal(decide(denied), false, denied)
  }
  assert.equal(decide(undefined), false)
  assert.equal(decide(null), false)
  assert.equal(decide({ toString: () => 'fullscreen' }), false)
})

test('applyPermissionPolicy installs request / check / device handlers that follow decide()', () => {
  const ses = fakeSession('persist:chatgpt')
  applyPermissionPolicy(ses)
  const answers = []
  ses.requestHandler({}, 'media', (ok) => answers.push(['media', ok]), { requestingUrl: 'https://chatgpt.com/' })
  ses.requestHandler({}, 'geolocation', (ok) => answers.push(['geolocation', ok]))
  ses.requestHandler({}, 'notifications', (ok) => answers.push(['notifications', ok]))
  ses.requestHandler({}, 'clipboard-sanitized-write', (ok) => answers.push(['clipboard-sanitized-write', ok]))
  assert.deepEqual(answers, [['media', false], ['geolocation', false], ['notifications', false], ['clipboard-sanitized-write', true]])
  assert.equal(ses.checkHandler({}, 'media', 'https://chatgpt.com', {}), false)
  assert.equal(ses.checkHandler({}, 'fullscreen', 'https://chatgpt.com', {}), true)
  assert.equal(ses.deviceHandler({ deviceType: 'hid', origin: 'https://chatgpt.com' }), false)
})

test('applyPermissionPolicy tolerates a session without a device handler and a null session', () => {
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
  assert.doesNotThrow(() => applyPermissionPolicy(ses))
  assert.doesNotThrow(() => applyPermissionPolicy(null))
})

test('attachDeviceChooserPolicy: select-bluetooth-device is prevented and cancelled (callback \'\'); idempotent per webContents', () => {
  const wc = fakeWebContents()
  assert.equal(hasDeviceChooserPolicy(wc), false)
  const handler = attachDeviceChooserPolicy(wc)
  assert.equal(typeof handler, 'function')
  assert.equal(attachDeviceChooserPolicy(wc), null, 'a second call installs nothing')
  assert.equal(wc.listenerCount('select-bluetooth-device'), 1)
  assert.equal(hasDeviceChooserPolicy(wc), true)
  const ev = { prevented: false, preventDefault() { this.prevented = true } }
  let chosen = null
  wc.emit('select-bluetooth-device', ev, [{ deviceId: 'd1', deviceName: 'Speaker' }, { deviceId: 'd2', deviceName: 'Watch' }], (id) => { chosen = id })
  assert.equal(ev.prevented, true, 'without preventDefault Electron picks the first device')
  assert.equal(chosen, '', 'an empty id cancels the request')
  assert.equal(attachDeviceChooserPolicy(null), null)
  assert.equal(attachDeviceChooserPolicy({}), null)
  assert.doesNotThrow(() => handler({ preventDefault() {} }, [], () => { throw new Error('request already gone') }))
  assert.doesNotThrow(() => handler(undefined, undefined, undefined))
})
