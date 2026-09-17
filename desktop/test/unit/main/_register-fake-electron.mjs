// `node --import ./test/unit/main/_register-fake-electron.mjs main/main.js` — installs the
// resolve hook that substitutes the fake Electron module (main-wiring.test.js).
import { register } from 'node:module'

register('./_hooks-fake-electron.mjs', import.meta.url)
