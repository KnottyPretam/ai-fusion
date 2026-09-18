# DOM fixtures (hand-built, scrubbed shape) — Stage 3, workstream `capture-hardening`

Twelve fixtures: `<site>-<state>.html` for `chatgpt` / `claude` / `grok` × `composer` / `streaming`
/ `done` / `logged-out`. They exist so the selector cascades of `desktop/preload/site.cjs`
(`DEFAULT_SELECTORS`, contract §4) and the session rules (contract §3) can be exercised offline,
with no browser and no dependency: `test/unit/preload/fixtures.test.js` parses each file with the
tiny DOM in `test/unit/preload/_dom.js`, runs the REAL `createAdapter()` over it and asserts the
`health()` answer — which cascade ENTRY matched, and the session state.

## What they are, and what they are not

- **Hand-built, not recorded.** Nobody's account is in here. Every one of them was written from the
  cascades and from public markup research; the measured facts are the grok composer (2026-09-16) and
  the chatgpt capture selectors (`assistant`, `assistantText`, `stop`, `done`, 2026-09-17) — see
  *Verified vs unverified* and the lifecycle section below. A real snapshot (menu → *Save DOM
  snapshot*, `scrubDom`) goes to `~/.config/triplex-desktop/snapshots/` and is never committed.
- **Scrubbed shape** (what `scrubDom` emits, contract §3): only the attributes in
  `SNAPSHOT_KEEP_ATTRS` (`id class role contenteditable aria-label data-testid
  data-message-author-role data-lexical-editor type disabled placeholder translate`), every text
  node replaced by `…`, no `script`/`style`/`link`/`meta`/`img`/`svg`/`iframe`/`video`/`audio`.
  `test/unit/preload/fixture-lint.test.js` enforces that shape, and the lint (`@`, `/c/`, `/chat/`,
  a uuid, `googleusercontent`, `x.com/`) on top of it.
- **Reformatted for review.** `scrubDom` emits one line; these are indented, so the whitespace
  between tags is the only difference from a scrubber fixed point (the shape test re-scrubs the
  parsed file and checks the result is stable).
- **No layout, no CSS.** The fixtures carry no styles, so `isVisible`/`isClickable` treat every
  element as visible and `toMarkdown` preserves no whitespace. A fixture answers "does the cascade
  find it?", never "is it on screen?" — the visibility rules are covered by the Playwright
  `adapters` project against the fake site, where real CSS applies.

## Consequences of the scrubbed shape (worth knowing before trusting a fixture)

1. **`href` and `src` are dropped**, so every href-based rule is invisible to a fixture:
   chatgpt/claude reach `logged_out` through their `data-testid` login buttons, but **grok's
   `loggedOut` cascade is href-only** (`a[href*='/sign-in']`, `a[href*='accounts.x.ai']`), so
   `grok-logged-out.html` can only answer `session: 'unknown'` (no composer, nothing matched). The
   live rule still works through `loggedOutUrl` (the pane's URL); Stage 4 confirms it, and a
   `data-testid`-shaped entry for grok would make the DOM rule reachable offline too.
2. **`aria-live` is not kept** (`role` is), so a banner that only carries `aria-live` cannot be
   reproduced; `chatgpt-streaming.html` uses `role="status"` instead and proves an alert-like
   container full of `…` never trips the `errorText` rule.
3. **Text is `…`**, so a code block's *header* language ("python", "json") is scrubbed away. The
   `language-xxx` class on the `<code>` survives, so `toMarkdown` still fences with a language; the
   header itself shows up as a stray `…` paragraph in `claude-done` / `grok-done`. The
   header-as-language path is covered by the snippet tests and by the fake site instead. (From S7 a
   bare-token block before a fence is only folded in as its header when the fence names no other
   language, or the same one — and never when it is a heading, a list, a table or a quote — so a
   one-token *content* block is kept; `…` fails `MD_LANG_RE` either way.)
4. **`iframe` is dropped**, so a Cloudflare challenge (`iframe[src*='challenges.cloudflare.com']`)
   cannot be a fixture either — there is deliberately no `-challenge` fixture. The fake site's
   `?state=challenge` covers it.

## Verified vs unverified

| fixture markup | status |
|---|---|
| grok composer: `div.tiptap.ProseMirror[contenteditable][role=textbox][aria-label="Ask Grok anything"]` in a `form`, a hidden helper `textarea` beside it, `button[aria-label="Enter voice mode"]` while empty, `button[type=submit][data-testid=chat-submit][aria-label=Submit]` once it holds text | **measured live** on grok.com, signed in, 2026-09-16 (`docs/decisions.md`, `S5` row) |
| chatgpt composer (`#prompt-textarea.ProseMirror[contenteditable]`), send (`button[data-testid=send-button]`, `#composer-submit-button`) | unverified — research-level, contract §4; Stage 4 confirms |
| chatgpt **`assistant`** (`[data-message-author-role=assistant]`), **`assistantText`** (`.markdown`), **`stop`** (`button[data-testid=stop-button]`, aria-label **"Stop answering"**), **`done`** (`button[data-testid=copy-turn-action-button]`) | **VERIFIED live** on chatgpt.com, signed in, **2026-09-17** — with the reply LIFECYCLE below. `.whitespace-pre-wrap` did **not** match anywhere on the page (`.markdown` and `.prose` did); it is kept as the last `assistantText` entry because an entry that matches nothing costs nothing |
| chatgpt code block: header text + a copy button INSIDE the `pre`, `code.language-xxx` | unverified |
| chatgpt logged out: `button[data-testid=login-button]` | unverified |
| claude composer (`div.ProseMirror[contenteditable]`), send (`button[aria-label="Send message"]`), stop (`button[aria-label="Stop response"]`), assistant (`.font-claude-response`), user turn (`[data-testid=user-message]`) | unverified |
| claude reply text: `assistantText` is deliberately **empty** — the whole `.font-claude-response` container is captured. An inner markdown selector would truncate the capture if it were wrong, and nothing has been measured; the fixtures keep an inner `div.grid-cols-1` so a Stage 4 entry can be added against them | unverified, on purpose |
| claude code block: a header div before the `pre`, `code.language-xxx`, copy button after it | unverified |
| claude logged out: `button[data-testid=login-with-google]` | unverified |
| grok assistant (`div[id^=response-]`), text (`.response-content-markdown`), stop (`button[aria-label=Stop]`), user bubble (`.message-bubble`) | unverified |
| grok code block: a header row (language + copy button) before the `pre` | unverified |
| grok logged out: sign-in links only (see consequence 1) | unverified |

`id="response-uuid"` in the grok fixtures is what `scrubValue` makes of `id="response-<uuid>"` — the
literal word, not an id.

## The chatgpt reply lifecycle, measured 2026-09-17 (why the fixtures cannot show it)

Timed on chatgpt.com with a real logged-in session, from the submit:

| ≈t | what the DOM does |
|---|---|
| 1 s | a SHORT **placeholder** assistant turn is mounted: about **12 characters** and **no `.markdown` child**, while `button[data-testid="stop-button"]` (aria-label "Stop answering") is visible |
| 2 s | that placeholder is **UNMOUNTED**: `document.querySelectorAll('[data-message-author-role="assistant"]')` returns **ZERO** for roughly **10 s**, and the stop button stays visible the whole time |
| 13 s | the **real** reply container is mounted, with a `.markdown` child carrying the answer |
| 14 s | the stop button disappears and a **second** `button[data-testid="copy-turn-action-button"]` appears (one already exists for the user's own turn while the reply streams) |

Two capture rules come straight out of that, and they are what `observe` in `desktop/preload/site.cjs`
now does (see its header, and the regression tests in `test/unit/preload/observe.test.js` +
`test/adapters/observe.spec.js`): a container that is no longer **connected** is dropped — holding the
detached placeholder freezes the captured text on it, so `stop_gone`/`quiet` would hand back a
12-character "answer" and the `done` marker could never match — and the **first-token deadline applies
only until a container has been seen once**, with the gap bounded by the overall capture budget.

These fixtures are single SNAPSHOTS, so they can show the placeholder's shape but never the sequence; a
`-placeholder` fixture would only restate what `chatgpt-streaming.html` already proves about the
cascade. The lifecycle is reproduced instead by the fake site's `?remountMs` / `?placeholderMs`
(`test/fake-site/site.js`), where real CSS and real timers apply.

The same session also showed the chat URL of that first reply to be a PLACEHOLDER
`https://chatgpt.com/c/WEB:<uuid>`, replaced later by the real `https://chatgpt.com/c/<uuid>`; the
placeholder 404s back to the home page when revisited. Hence `chatgpt.chatUrlPattern` ends the id at
the segment (`(?:[?#]|$)`, contract §4) — the placeholder matches nothing, so main never records a link
that does not work. The fake site replays it with `?webUrlMs`.

## Adding one

1. Take a real snapshot on the live page (menu → *Save DOM snapshot*) — it is already scrubbed.
2. Delete everything that is not needed for the rule you want to pin, keep the ancestors that carry
   `id`/`class`/`role`, and indent it.
3. Add the expected `health()` answer to `EXPECTED` in `test/unit/preload/fixtures.test.js`, and a
   row above saying what was measured and when.
4. Run `node --test 'test/unit/**/*.test.js'`. The lint and the shape test refuse anything that
   still carries identity or an attribute outside the allow-list.

## claude.ai and grok.com — verified live 2026-09-17 (read-only, settled chats, no prompts sent)

Read from the user's own completed chats with a logged-in probe, so these are facts, not research:

| | claude.ai | grok.com |
|---|---|---|
| `assistant` | `.font-claude-response:not(#markdown-artifact)` matched (1 container) | `div[id^='response-']` matched (2 containers) |
| reply text | container `innerText` 2754 chars; `.prose` holds 2717 of them (our `assistantText` is empty, so the innerText fallback is what runs — it works) | `.response-content-markdown` 5588 chars, our first entry — exact |
| `stop` | **no match on a settled page**, and no visible button whose testid/aria mentions "stop" | **no match on a settled page**, same |
| `done` | our cascade is empty; the page does carry `button[data-testid='action-bar-copy']` (aria "Copy") next to thumbs-up/down and Retry | our cascade is empty; the copy controls carry aria only ("Copy", "Copy response", "Regenerate"), no testid |

The `stop` result is the load-bearing one: a FALSE POSITIVE there is what freezes a capture (the sample
keeps saying "still replying" and the budget is the only way out), and neither site produces one.
Both sites captured successfully in live runs (claude 2880 and 3489 chars, grok 7068), so the
stop-gone / quiet path demonstrably ends their captures.

NOT verified, deliberately: what either page looks like WHILE streaming — that needs a prompt sent
into the user's own account. `claude`'s `action-bar-copy` is therefore a CANDIDATE `done` marker, not
an adopted one: if that action bar is also present during streaming it would end a capture early, and
the current cascade already works. Adopt it only after watching one live reply.
