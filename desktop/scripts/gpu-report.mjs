// desktop/scripts/gpu-report.mjs — print Chromium's GPU feature status and basic GPU info as JSON.
//
//   cd desktop && npx electron scripts/gpu-report.mjs
//   TRIPLEX_CHROMIUM_FLAGS='--ignore-gpu-blocklist' npx electron scripts/gpu-report.mjs
//   TRIPLEX_DISABLE_GPU=1 npx electron scripts/gpu-report.mjs
//
// Honours the same allow-listed TRIPLEX_CHROMIUM_FLAGS / TRIPLEX_DISABLE_GPU as main.js so the
// report reflects the flag set that will be recorded in docs/decisions.md. Exits 0 on success.

import { app } from 'electron'

const ALLOW = /^--(ignore-gpu-blocklist|disable-gpu|disable-gpu-compositing)$|^--(use-gl|enable-features|disable-features)=.+$/

for (const flag of String(process.env.TRIPLEX_CHROMIUM_FLAGS || '').split(/\s+/).filter(Boolean)) {
  if (!ALLOW.test(flag)) {
    console.error(`[gpu-report] TRIPLEX_CHROMIUM_FLAGS: "${flag}" is not allow-listed`)
    app.exit(2)
    break
  }
  const eq = flag.indexOf('=')
  if (eq === -1) app.commandLine.appendSwitch(flag.slice(2))
  else app.commandLine.appendSwitch(flag.slice(2, eq), flag.slice(eq + 1))
}
if (process.env.TRIPLEX_DISABLE_GPU === '1') app.disableHardwareAcceleration()

app
  .whenReady()
  .then(async () => {
    const report = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      flags: process.env.TRIPLEX_CHROMIUM_FLAGS || '',
      disableGpu: process.env.TRIPLEX_DISABLE_GPU === '1',
      featureStatus: app.getGPUFeatureStatus(),
      gpuInfo: await app.getGPUInfo('basic'),
    }
    console.log(JSON.stringify(report, null, 2))
    app.exit(0)
  })
  .catch((e) => {
    console.error(String((e && e.stack) || e))
    app.exit(1)
  })
