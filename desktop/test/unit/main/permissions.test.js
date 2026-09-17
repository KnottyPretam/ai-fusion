// permissions.js — media / geolocation / notifications denied, clipboard-sanitized-write allowed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, ALLOWED, applyPermissionPolicy } from '../../../main/permissions.js'
import { fakeSession } from './_fakes.js'

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
