// chromium-flags.js — the TRIPLEX_CHROMIUM_FLAGS allow-list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFlags, flagsFromEnv, applyFlags } from '../../../main/chromium-flags.js'

test('parseFlags: every allowed flag passes, in order, as {name, value}', () => {
  const r = parseFlags('--ignore-gpu-blocklist --disable-gpu --disable-gpu-compositing --use-gl=egl --enable-features=A,B --disable-features=C')
  assert.equal(r.ok, true)
  assert.deepEqual(r.flags, [
    { name: 'ignore-gpu-blocklist', value: undefined },
    { name: 'disable-gpu', value: undefined },
    { name: 'disable-gpu-compositing', value: undefined },
    { name: 'use-gl', value: 'egl' },
    { name: 'enable-features', value: 'A,B' },
    { name: 'disable-features', value: 'C' },
  ])
})

test('parseFlags: --remote-debugging-port is refused (and nothing after it is parsed)', () => {
  const r = parseFlags('--disable-gpu --remote-debugging-port=9222 --ignore-gpu-blocklist')
  assert.equal(r.ok, false)
  assert.equal(r.rejected, '--remote-debugging-port=9222')
  assert.deepEqual(r.flags, [{ name: 'disable-gpu', value: undefined }])
})

test('parseFlags: near misses are refused too', () => {
  for (const bad of ['--disable-gpu=1', '--use-gl', '--use-gl=', '--no-sandbox', '--disable-web-security', 'disable-gpu', '--ignore-gpu-blocklist=true', '--enable-features']) {
    const r = parseFlags(bad)
    assert.equal(r.ok, false, bad)
    assert.equal(r.rejected, bad)
  }
})

test('parseFlags: empty / undefined / whitespace → ok with no flags', () => {
  for (const raw of ['', undefined, null, '   \n\t ']) assert.deepEqual(parseFlags(raw), { ok: true, flags: [] })
})

test('flagsFromEnv: TRIPLEX_DISABLE_GPU=1 adds --disable-gpu once; a rejected flag still refuses', () => {
  assert.deepEqual(flagsFromEnv({ TRIPLEX_DISABLE_GPU: '1' }), { ok: true, flags: [{ name: 'disable-gpu', value: undefined }] })
  assert.deepEqual(flagsFromEnv({ TRIPLEX_DISABLE_GPU: '1', TRIPLEX_CHROMIUM_FLAGS: '--disable-gpu' }), { ok: true, flags: [{ name: 'disable-gpu', value: undefined }] })
  assert.deepEqual(flagsFromEnv({}), { ok: true, flags: [] })
  const r = flagsFromEnv({ TRIPLEX_DISABLE_GPU: '1', TRIPLEX_CHROMIUM_FLAGS: '--remote-debugging-port=1' })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, '--remote-debugging-port=1')
})

test('applyFlags calls appendSwitch with and without a value', () => {
  const calls = []
  applyFlags({ appendSwitch: (...a) => calls.push(a) }, parseFlags('--disable-gpu --use-gl=egl').flags)
  assert.deepEqual(calls, [['disable-gpu'], ['use-gl', 'egl']])
  assert.doesNotThrow(() => applyFlags(null, []))
})
