// Module resolve hook: `import ... from 'electron'` → test/unit/main/_fake-electron.mjs.
// Registered by _register-fake-electron.mjs (node --import) so main/main.js runs without a binary.
const FAKE = new URL('./_fake-electron.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: FAKE, shortCircuit: true }
  return nextResolve(specifier, context)
}
