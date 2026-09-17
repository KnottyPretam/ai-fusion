// desktop/test/unit/preload/_fixture-lint.js — the DOM-fixture lint (not a test: node --test only
// collects *.test.js). Shared by fixture-lint.test.js (scans desktop/test/fixtures/dom/*.html) and
// by the adapters spec (a `snapshot` result must pass it before it may be committed as a fixture).
//
// A scrubbed real-DOM snapshot must carry no identity: an e-mail (`@`), a chat path (`/c/`,
// `/chat/`), a uuid (chat / message ids), an avatar host (`googleusercontent`) or a profile link
// (`x.com/`). The patterns are deliberately blunt — a false positive costs a manual edit, a false
// negative ships someone's account into the repo.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** desktop/test/fixtures/dom — may not exist yet (the lint then passes vacuously, but it still looks). */
export const FIXTURES_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'dom')

export const LINT_PATTERNS = Object.freeze([
  { name: 'at-sign (an e-mail address)', re: /@/ },
  { name: 'chat path /c/', re: /\/c\// },
  { name: 'chat path /chat/', re: /\/chat\// },
  { name: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'googleusercontent (an avatar host)', re: /googleusercontent/i },
  { name: 'x.com/ (a profile link)', re: /x\.com\//i },
])

/** Every `{name, line}` finding in `text` (1-based line numbers); `[]` when it is clean. */
export function lintText(text) {
  const findings = []
  const lines = String(text).split('\n')
  lines.forEach((line, i) => {
    for (const { name, re } of LINT_PATTERNS) if (re.test(line)) findings.push({ name, line: i + 1 })
  })
  return findings
}

/** The *.html files under `dir`, sorted; `[]` when the directory does not exist. */
export function listFixtures(dir = FIXTURES_DIR) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (_e) {
    return []
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.html'))
    .sort()
    .map((n) => path.join(dir, n))
}

/** Lint every fixture under `dir`: `{files, findings: [{file, name, line}]}`. */
export function lintFixtures(dir = FIXTURES_DIR) {
  const files = listFixtures(dir)
  const findings = []
  for (const file of files) {
    for (const f of lintText(fs.readFileSync(file, 'utf8'))) findings.push({ file: path.basename(file), ...f })
  }
  return { files, findings }
}
