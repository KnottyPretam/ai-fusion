// desktop/main/chromium-flags.js — the TRIPLEX_CHROMIUM_FLAGS allow-list (contract §5).
// Pure module: `parseFlags(str)` never touches Electron; main.js appends the accepted switches to
// `app.commandLine` before `ready` and refuses to start on the first rejected flag.
//
//   allowed: --ignore-gpu-blocklist  --disable-gpu  --disable-gpu-compositing
//            --use-gl=<v>  --enable-features=<v>  --disable-features=<v>
//   TRIPLEX_DISABLE_GPU=1 is the same as adding --disable-gpu.

export const ALLOWED_FLAGS = Object.freeze(['--ignore-gpu-blocklist', '--disable-gpu', '--disable-gpu-compositing'])
export const ALLOWED_VALUE_FLAGS = Object.freeze(['--use-gl', '--enable-features', '--disable-features'])

export const ALLOWED_DESCRIPTION = `${ALLOWED_FLAGS.join(' ')} ${ALLOWED_VALUE_FLAGS.map((f) => `${f}=*`).join(' ')}`

/**
 * parseFlags(raw) → `{ok: true, flags: [{name, value}]}` for an all-allowed whitespace-separated
 * list, or `{ok: false, rejected: '<flag>', flags: [...accepted so far]}` on the first flag outside
 * the allow-list. `name` has no leading dashes (the form `app.commandLine.appendSwitch` takes);
 * `value` is undefined for bare switches. Empty / undefined input → `{ok: true, flags: []}`.
 */
export function parseFlags(raw) {
  const tokens = String(raw === undefined || raw === null ? '' : raw)
    .split(/\s+/)
    .filter(Boolean)
  const flags = []
  for (const token of tokens) {
    const eq = token.indexOf('=')
    const head = eq === -1 ? token : token.slice(0, eq)
    const value = eq === -1 ? undefined : token.slice(eq + 1)
    if (eq === -1 && ALLOWED_FLAGS.includes(head)) {
      flags.push({ name: head.slice(2), value: undefined })
      continue
    }
    if (eq !== -1 && ALLOWED_VALUE_FLAGS.includes(head) && value !== '') {
      flags.push({ name: head.slice(2), value })
      continue
    }
    return { ok: false, rejected: token, flags }
  }
  return { ok: true, flags }
}

/**
 * The switches to apply for a whole environment: `TRIPLEX_CHROMIUM_FLAGS` parsed by `parseFlags`
 * plus `--disable-gpu` when `TRIPLEX_DISABLE_GPU=1` (de-duplicated). Same result shape.
 */
export function flagsFromEnv(env = {}) {
  const parsed = parseFlags(env.TRIPLEX_CHROMIUM_FLAGS)
  if (!parsed.ok) return parsed
  const flags = parsed.flags.slice()
  if (String(env.TRIPLEX_DISABLE_GPU || '') === '1' && !flags.some((f) => f.name === 'disable-gpu')) {
    flags.push({ name: 'disable-gpu', value: undefined })
  }
  return { ok: true, flags }
}

/** Append every `{name, value}` to a commandLine-like object (`appendSwitch(name[, value])`). */
export function applyFlags(commandLine, flags) {
  if (!commandLine || typeof commandLine.appendSwitch !== 'function') return
  for (const { name, value } of flags || []) {
    if (value === undefined) commandLine.appendSwitch(name)
    else commandLine.appendSwitch(name, value)
  }
}
