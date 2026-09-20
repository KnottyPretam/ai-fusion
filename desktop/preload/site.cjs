'use strict'
// desktop/preload/site.cjs — the site adapter (contracts §2 message protocol, §3 interface, §4 selectors).
//
// Self-contained on purpose: this file runs as a *sandboxed* Electron preload
// (`sandbox:true`, `contextIsolation:true`), where `require` only resolves 'electron' and a few
// Node built-ins, never sibling files. The same file is injected verbatim into a plain Chrome
// page by the Playwright `adapters` project (with `window.__triplexFakeIpc` installed first)
// and `require`d by `node --test` for its pure exports. The whole body is one IIFE so that,
// injected into a page's main world, it leaves no global bindings behind.
//
// Rules: nothing is ever assigned to `window`/`globalThis` for the page; the prompt text is always
// a message field (never interpolated into code); the adapter never clears the composer on
// failure; one op in flight per view (a second one answers `busy`); `ms`/`ts` are integers.
//
// Boot environments (contract §3: boots when `process.versions.electron` or `window.__triplexFakeIpc` exists):
//   * Electron preload — `require('electron').ipcRenderer` is the IPC, ALWAYS: whenever
//     `process.versions.electron` exists a page global is never consulted (so a site that defined
//     `window.__triplexFakeIpc` could not capture the adapter even if this file ran in its main
//     world; a failing `require('electron')` boots nothing). `adapter:config` is answered by main
//     from the sender id (`site:null` = stay inert, e.g. an SSO popup).
//   * Playwright (test/adapters/*.spec.js) — outside Electron only: the spec installs the fake IPC
//     with `page.addInitScript` BEFORE injecting this file. Its exact shape, the only surface this file touches:
//       window.__triplexFakeIpc = {
//         invoke(channel, ...args) → Promise   // invoke('adapter:config') resolves {site: slot|null, selectors, dev}
//         on(channel, handler)                 // registers handler(event, msg) for channel 'triplex:adapter'
//         send(channel, payload)               // receives 'triplex:adapter:result' and 'triplex:adapter:health'
//       }
//     The spec delivers a main → preload message by calling the handler it received through `on`
//     (its helper `request(msg)` does that and resolves with the matching 'triplex:adapter:result').
//   * node --test — no `window`, never boots; `module.exports` exposes the pure parts.
//
// Stage 1 (site-adapters): the full adapter — selectors v1 with session detection (scoped: chat
// content is never a wall or banner), `findFirst` over the document + open shadow roots,
// `waitForComposer`, the idempotent verified insertion cascade, submit polling with confirmation,
// `ready`, `insertAndSubmit`, `countMessages`/`countAssistant`, cancel, busy, health on change +
// 10 s heartbeat, requests parked during boot.
//
// Stage 2 (capture-adapters): selectors v2 (`stop`/`assistant`/`assistantText`/`done`/`quietMs`/
// `settleMs` (S10)/`firstTokenMs`/`captureTimeoutMs` per site, contract §4), the `observe` op (final-text capture:
// a new assistant container beyond `baselineCount`, done by done-selector | stop-gone | quiet,
// `timeout` with the partial text, MutationObserver throttled to 100 ms + a 300 ms poll), the
// `snapshot` op (`scrubDom`), `errorText` → `site_error` carrying only the matched phrase, and the
// `config` hot reload (re-merge onto the defaults, health re-run). Readings taken where the contract
// is silent (also listed in the S6 build log):
//   * `DEFAULT_SELECTORS.version` stays 1: v2 is additive per site, and main's loader pins the
//     version check (an override carrying `version: 2` warns and is otherwise applied).
//   * observe: `timeoutMs` overrides `captureTimeoutMs`, `quietMs` overrides `quietMs`, an optional
//     `firstTokenMs` overrides `firstTokenMs` (the first-token wait is capped by the budget) and an
//     optional `settleMs` overrides `settleMs` (S10); a missing `baselineCount` means the current
//     `countAssistant()`. `expect: 'json'` (S10) says what KIND of answer this turn is waiting for.
//   * "the done selector on the last container" = a VISIBLE, clickable `done` match (not `opacity:0`
//     or `pointer-events:none` — a hover-revealed action bar is not a marker) that is the last
//     container, inside it, or after it in document order (an older turn's copy button never
//     counts) and OUTSIDE its reply body (S9: not inside an `assistantText` block, not inside a
//     `pre`/`code` — a code block's own copy control is part of the message, and chatgpt mounts one
//     the moment a fenced block opens; see `insideReplyBody`), and only while NO stop button is
//     visible: the site's own "still replying" signal wins over a marker (a finished tool turn's
//     action bar while the answer is still streaming).
//   * "stop button seen then gone" = seen during THIS observe; while it is visible the reply is
//     never quiet; when it was never seen (the reply finished before observe started) quiet applies.
//   * an end signal (done selector, stop gone) never resolves on the sample that saw it and is never
//     LATCHED (S9): every further sample re-reads the stop button, and a visible one WITHDRAWS the
//     signal (a sample that missed a button mid-re-render or mid-transition used to end the capture
//     on the next lull, mid-reply); the capture resolves once the text has not moved for SETTLE_MS
//     (four throttle ticks — a 100 ms lull between token batches is ordinary mid-stream) with the
//     signal still standing; past the budget the latest text is returned with that doneBy, not
//     `timeout`. `quiet` goes through the same machinery (its own stillness requirement is already
//     met, so it costs one settle window) so that a stop button can take it back too.
//   * cadence: a mutation tick only reads the thread; the session (wall / challenge / banner) is
//     re-checked on the 300 ms poll and on any sample about to give a terminal answer (a reply
//     frozen by a banner is `site_error`, never `stop_gone`); every sample walks the open shadow
//     roots at most once (`sampled()` shares one `openShadowRoots(document)` per sample); the
//     MutationObserver is re-scoped from the document to the reply's parent (the thread) once the
//     reply container is known — a container appended elsewhere is still caught by the poll.
//   * EVERY end signal needs non-blank text (S10; only `quiet` asked for it before): an empty container
//     waits for the budget (`timeout`, partial "").
//   * the text is normalised (CRLF → LF, NBSP → space) and never trimmed.
//   * a banner mid-reply is `site_error` whose message is the configured `errorText` phrase that
//     matched — never the banner's or the page's text; a wall / challenge mid-reply answers
//     `logged_out` / `challenge`; the partial text rides along on those and on `cancelled` when it is
//     non-blank, and always on `timeout`.
//   * snapshot: comments, doctype and whitespace-only text nodes are dropped (a non-blank text node
//     becomes `…`), `<template>` content is not serialised, open shadow roots are emitted as
//     `<template shadowrootmode="open">`, and kept attribute VALUES have every identity token
//     replaced WHOLE (a uuid → `uuid`, an e-mail address → `email`, an `@handle` → `handle`,
//     `x.com/<profile…>` → `x-com/profile`, `/c/<id>` and `/chat/<id>` → `/c-/id` / `/chat-/id`,
//     `googleusercontent` → `img-host`) — never just the delimiter the fixture lint
//     (`test/unit/preload/_fixture-lint.js`) keys on, so nothing of an account survives and the
//     output passes the lint by construction.
//   * `config`: a full config is re-merged onto DEFAULT_SELECTORS (every key present, unknown keys
//     dropped with the usual warnings); a bare site block is taken as-is.
//
// Stage 3 (capture-hardening): `toMarkdown(el)` (contract §3) — the captured text is the reply's
// rendered MARKDOWN, not its innerText — and `replyText`'s cascade hardened around it (prefer the
// markdown container the `assistantText` cascade points at, fall back to innerText). Readings taken
// where the contract is silent (also listed in `test/fixtures/dom/README.md` and the S7 build log):
//   * whitespace: inline runs are collapsed the way the browser renders them, EXCEPT where the page
//     preserves whitespace — a `pre`, or a computed `white-space` of pre / pre-wrap / pre-line /
//     break-spaces (ChatGPT's `.whitespace-pre-wrap` plain-text turns, every composer) — which is
//     copied verbatim. Without a view (a fake document, `node --test`) nothing is preserved.
//   * a block's edges are trimmed (a markdown document has no leading or trailing blank space); the
//     inside of a preserved run is never touched, and a node the walk cannot read (no `childNodes`)
//     renders to `''`, so `blockText` answers with innerText exactly as Stage 2 did.
//   * markdown is NOT escaped: a reply that contains `*` or a backtick is captured as it reads on
//     the page. The captured text is quoted data for an analyst prompt, never re-rendered by Triplex,
//     and escaping would break the byte-for-byte fenced JSON the analyst replies with.
//   * code blocks: the body is the `code` descendants of the `pre` (else the `pre` itself) joined by
//     newlines, one trailing newline dropped, and a BLOCK child inside it is a line of its own (a
//     highlighter that wraps each line in a `div` keeps its lines, an empty one its blank line); the
//     language is the first of a `language-`/`lang-`/`highlight-` class, a `data-language` attribute,
//     a bare token left in the `pre` once the code and the chrome are removed (ChatGPT renders its
//     header inside the `pre`), or a bare-token block immediately before the block holding the `pre`
//     (a header rendered outside it) — that last one ONLY when the fence names no other language, or
//     the same one, and never a heading / list / table / quote, so a one-token paragraph (`### 2000`,
//     a `**app.py**` label) stays content. The fence is always one backtick longer than the longest
//     fence line inside the body, and an inline code span is delimited and padded the same way
//     (CommonMark), so a reply that shows backticks reads back with them.
//   * a MathML formula (KaTeX's accessible copy, hidden by clip and not by `display:none`) is
//     captured ONCE: its `application/x-tex` annotation as `$…$` (`$$…$$` when `display="block"`),
//     else its glyph run. An image is its alt text as `![alt]()` (no URL, contract §3); no alt, nothing.
//   * chrome: `button`, `select`, `input`, `textarea`, media and `script`/`style` subtrees are
//     dropped everywhere, as is any block whose whole text is one of MD_CHROME_TEXT ("Copy code",
//     "Edit", "Read aloud"…) and anything `hidden`, `aria-hidden="true"`, `display:none` or
//     `visibility:hidden`. A link renders as its text; the URL is dropped (contract §3) — citations
//     ride on the Analyze/Fusion prompts, not on the capture.
//
// S7 review — two capture bugs MEASURED live on chatgpt.com with a real logged-in session on
// 2026-09-17 (recorded here, and in `test/fixtures/dom/README.md`, so the next reader does not have to
// re-measure; replayed offline by the fake site's `?remountMs` / `?placeholderMs` / `?webUrlMs` and
// pinned by `test/adapters/observe.spec.js` + `test/unit/preload/observe.test.js`):
//   1. The reply container is mounted, UNMOUNTED and mounted again. After a submit a SHORT placeholder
//      assistant turn appears within ~1 s (about 12 characters, and NO `.markdown` child) while
//      `button[data-testid="stop-button"]` (aria-label "Stop answering") is visible; at ~2 s that
//      placeholder is unmounted, so `document.querySelectorAll('[data-message-author-role="assistant"]')`
//      returns ZERO for roughly 10 s while the stop button stays up; at ~13 s the real container is
//      mounted with a `.markdown` child carrying the answer; at ~14 s the stop button disappears and a
//      second `button[data-testid="copy-turn-action-button"]` appears (one already exists for the
//      user's own turn while the reply streams). Consequences for `observe`: a container that is no
//      longer connected is DROPPED (holding the detached node freezes the text at the placeholder and
//      makes the `done` marker unmatchable, so the capture could only ever end by timeout on the
//      placeholder's text), the first-token deadline applies only until a container has been seen ONCE,
//      and the gap is bounded by the overall budget like any other unfinished reply.
//      `.whitespace-pre-wrap` did NOT match anywhere on the current page — `.markdown` and `.prose`
//      do — so `assistantText` keeps it only as a harmless last fallback.
//      Two follow-ups from the S7 review of that fix, both about WHICH container the answer comes from
//      when a count is no longer trustworthy: `observe` snapshots the containers present when it starts
//      and picks the last one OUTSIDE that snapshot (`length > baselineCount` only picks a container
//      until one has been followed), so an earlier turn — its text and its own copy-turn marker — is
//      never reported as this turn's reply; and `submit` samples `assistantCount` ONCE, before the first
//      attempt, lowering it if a container went away but never raising it, so the placeholder that
//      appears while a submission is being confirmed cannot inflate that baseline and make the capture
//      answer `reply_not_found` with the answer on screen.
//   2. The chat URL of that first reply is a PLACEHOLDER `https://chatgpt.com/c/WEB:<uuid>`, replaced
//      later by the real `https://chatgpt.com/c/<uuid>`; revisiting the placeholder 404s back to the
//      home page. `chatgpt.chatUrlPattern` therefore ends the id at the segment (`(?:[?#]|$)`), so the
//      placeholder matches nothing and main records only the real link.
//
// S8 capture fidelity — a claude.ai defect MEASURED on 2026-09-18 from a real Send (the persisted
// SendTurn of conversation 413b0a4a): the answer was correct but its FIRST line, claude's thinking
// summary, was captured TWICE —
//     "Choosing the strongest language for safety-critical flight control.\n\n
//      Choosing the strongest language for safety-critical flight control.\n\n**Ada/SPARK**\n\n…"
// — and two web-search turns from the same session showed the same widget doing it with its tool
// label ("Searched the webBosch BMI088 gyroscope range ±2000 dps datasheet\n\nSearched the web\n\n…",
// "Searched the web\n\nSearched the web\n\n…"). chatgpt and grok captured cleanly in those same runs.
// The code path: `observe` reads ONE container per sample (`text = normalizeText(replyText(container))`)
// and claude's `assistantText` cascade was EMPTY, so `replyText` fell through to `blockText(container)`
// = `toMarkdown('.font-claude-response')` — the whole TURN, thinking/tool widget included. A single
// `toMarkdown` pass renders every node exactly once (`mdBlockEntries` walks `childNodes` once and
// neither `mdInline` nor `mdRawText` re-descends), so the line is in the DOM twice: claude renders the
// summary in the row you see AND in the collapsed panel, and a panel collapsed by height/clip is not
// `display:none`, `visibility:hidden`, `hidden` or `aria-hidden` — the only four things `mdHidden`
// drops. (It is NOT the `assistant` cascade matching a parent and a child: `assistantContainers()`
// de-duplicates by identity and `observe` follows exactly ONE node — the LAST fresh one in document
// order — so a nested pair would TRUNCATE a capture, never double it; the 2026-09-17 probe also found
// exactly one match, `.font-claude-message` matching nothing.)
// The fix is `claude.assistantText: ['.prose']` (see DEFAULT_SELECTORS): the body is read from the
// markdown container the probe measured, so the widget is excluded by STRUCTURE — never by matching
// the text of a "thinking" line — and the cascade fallback keeps the whole container whenever `.prose`
// is absent, so the rule can add a duplicate header back but can never drop the answer. Replayed
// offline by the fake site's `?thinking=1` (claude) and pinned by `test/adapters/observe.spec.js`,
// `test/unit/preload/markdown.test.js` and `test/unit/preload/selectors.test.js`.
//
// S10 — the capture ended mid-reply once the answers got LONG. Evidence from a real Analyze on
// 2026-09-20, after the user raised the reasoning effort inside chatgpt and claude (the three replies
// it compared were 4992 / 13677 / 8583 characters): both analyst attempts came back as fragments the
// bridge reported as `ok` — "```JSON\n{\n```" (13 characters, after 78.5 s) and `{"agre` (6, after
// 13.3 s) — and Analyze degraded with `parse_error: no JSON object found in the response`. Four rules
// follow, and the first three are about the same thing: an end signal is evidence about ONE sample of a
// DOM that re-renders, and none of them may be trusted over a body that is not there yet.
//   1. `done_selector` and `stop_gone` need non-blank text, as `quiet` always did. A signal with nothing
//      captured means the reply has not STARTED; ending there reports a zero-character reply as `ok`.
//   2. The stillness clocks are FROZEN while there is no container, and `findStop()` is sampled in that
//      gap too. Both halves matter on chatgpt, whose reply container is unmounted for ~10 s mid-stream
//      (measured 2026-09-17, above): the clocks used to run on, so a pending signal matured while the
//      page could not be read, and the withdraw guard was blind exactly where the site was most plainly
//      still replying — the button stays visible across the whole gap.
//   3. A container SWAP resets the stillness state. The replacement usually renders the same prefix, so
//      the sample after a swap would otherwise read "unchanged for quietMs" and end on that prefix.
//   4. `expect: 'json'` — when the caller knows the answer is a JSON document (main sends it for the
//      analyst page), no end signal resolves until the braces BALANCE (`looksComplete`), and the budget
//      still ends it with whatever is there, after one final re-read of the container. A shape is
//      evidence that a document is whole; a lull never was.
// `settleMs` became a per-site selector in the same pass (chatgpt 1200, everyone else the four throttle
// ticks S9 introduced), and main sends the analyst view a multiple of it. Pinned by the S10 block of
// `test/unit/preload/observe.test.js`, the long-fenced-reply spec in `test/adapters/observe.spec.js`
// (fake site `?replyChars` / `?lulls`) and `test/unit/main/orchestrator.test.js`.

;(() => {
  'use strict'

  const SLOTS = Object.freeze(['claude', 'chatgpt', 'grok'])

  const SESSION_STATES = Object.freeze(['ok', 'logged_out', 'challenge', 'blocked', 'unknown'])
  /** Session states that reject an op before any DOM write (contract §3). */
  const REJECT_STATES = Object.freeze(['logged_out', 'challenge', 'blocked'])
  /** Result codes the adapter mints (contract §2); anything else is reported as `site_error`. */
  const RESULT_CODES = Object.freeze([
    'composer_not_found',
    'send_not_found',
    'not_submitted',
    'reply_not_found',
    'timeout',
    'cancelled',
    'busy',
    'site_error',
    'logged_out',
    'challenge',
    'blocked',
  ])

  const HEALTH_HEARTBEAT_MS = 10000
  const HEALTH_POLL_MS = 1500
  const HEALTH_MUTATION_THROTTLE_MS = 400
  /** Contract §3: the send cascade is polled every 150 ms (the composer wait uses the same tick). */
  const SEND_POLL_MS = 150
  const CONFIRM_POLL_MS = 100
  /** Contract §3: insertion is verified by the composer text ending with the last 20 characters. */
  const VERIFY_TAIL_CHARS = 20
  /** After an insertion, let the editor's own reconciliation frame run before reading back. */
  const INSERT_SETTLE_MS = 60
  const MAX_SHADOW_DEPTH = 8
  /** Upper bound on the parent/host walk of `containsDeep` (a real thread is nowhere near this deep). */
  const MAX_ANCESTOR_HOPS = 512
  /** Stage 2 observe cadence: a DOM mutation triggers a check at most every 100 ms; a poll runs every 300 ms regardless. */
  const OBSERVE_THROTTLE_MS = 100
  const OBSERVE_POLL_MS = 300
  /** snapshot (contract §2/§3): elements dropped with their subtrees, and the only attributes kept (emitted in DOM order). */
  const SNAPSHOT_DROP_TAGS = Object.freeze(['script', 'style', 'link', 'meta', 'img', 'svg', 'iframe', 'video', 'audio'])
  const SNAPSHOT_KEEP_ATTRS = Object.freeze([
    'id',
    'class',
    'role',
    'contenteditable',
    'aria-label',
    'data-testid',
    'data-message-author-role',
    'data-lexical-editor',
    'type',
    'disabled',
    'placeholder',
    'translate',
  ])
  const VOID_TAGS = Object.freeze(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  /** What every non-blank text node becomes in a snapshot. */
  const TEXT_PLACEHOLDER = '\u2026'

  /**
   * What `countMessages()` counts: every element matching one of these generic message containers
   * — user AND assistant turns — de-duplicated, in the document and its open shadow roots. It is a
   * monotonic "a message was appended" signal used to confirm a submission (the user turn appears),
   * not a reply count; 0 when nothing matches. The same list defines "inside a chat message" for
   * the session rules: text and links rendered inside one of these never count as a wall or banner.
   * A v2 `assistant` cascade (Stage 2) is counted in addition when present.
   */
  const MESSAGE_SELECTORS = Object.freeze([
    '[data-message-author-role]', // chatgpt (and the fake site): user + assistant turns
    "[data-testid='user-message']", // claude user turns
    '.font-claude-message', // claude assistant turns (older markup)
    '.font-claude-response', // claude assistant turns
    "div[id^='response-']", // grok assistant turns
    '.message-bubble', // grok user/assistant bubbles
  ])
  const MESSAGE_SELECTOR = MESSAGE_SELECTORS.join(', ')

  /**
   * What `countAssistant()` counts: assistant-role containers only (+ a v2 `assistant` cascade).
   * This is the `assistantCount` handed to main (contract §2/§3) — Stage 2's observe baseline — so
   * the user's own turn, appended after the sample, is never mistaken for the reply.
   */
  const ASSISTANT_SELECTORS = Object.freeze([
    "[data-message-author-role='assistant']", // chatgpt
    '.font-claude-response', // claude
    '.font-claude-message', // claude (older markup)
    "div[id^='response-']", // grok
  ])

  /**
   * Where `errorText` (contract §4) is looked for: alert-like containers only, never the whole
   * body — a reply or prompt that merely mentions "rate limit" or "Something went wrong" is chat
   * content, not a banner. Containers inside a message, or wrapping the thread/composer, are skipped.
   */
  const ALERT_SELECTORS = Object.freeze(["[role='alert']", "[role='status']", "[role='dialog']", "[role='alertdialog']", '[aria-live]'])

  /**
   * The Cloudflare interstitial's exact tab title. `challengeTitle` is a substring rule and the
   * sites put the conversation title in the tab title, so a substring hit only counts when it is
   * this exact title, or corroborated by a missing composer / a `challenge` element.
   */
  const CLOUDFLARE_CHALLENGE_TITLES = Object.freeze(['Just a moment...', 'Just a moment\u2026'])

  /**
   * Selector config — contract §4 verbatim: the v1 keys, plus the v2 keys (`stop`, `assistant`,
   * `assistantText`, `done`, `quietMs`, `settleMs`, `firstTokenMs`, `captureTimeoutMs`) added per site in
   * Stage 2 (`settleMs` in S10). `version` stays 1: v2 is additive, and an override file written against
   * v1 keeps working (main's loader warns on any other version). Override: <userData>/selectors.json.
   * Empty `stop` + `done` ⇒ quiet detection (claude and grok have no done marker; their stop
   * buttons are the done signal, quiet the fallback).
   */
  const DEFAULT_SELECTORS = {
    version: 1,
    chatgpt: {
    // chatUrlPattern ends the id at the segment: chatgpt.com mounts a PLACEHOLDER url
    // `/c/WEB:<uuid>` while the first reply streams and only then replaces it with the real
    // `/c/<uuid>` (measured 2026-09-17). The placeholder matched the open-ended pattern and was
    // recorded as the conversation's chat link, which 404s back to the home page on a revisit.
      chatUrlPattern: '^https://chatgpt\\.com/c/[A-Za-z0-9-]+(?:[?#]|$)',
      composer: [
        '#prompt-textarea',
        "div[contenteditable='true'].ProseMirror",
        "div[role='textbox'][aria-label='Chat with ChatGPT']",
        "div[contenteditable='true'][role='textbox']",
      ],
      send: [
        "button[data-testid='send-button']",
        '#composer-submit-button',
        "button[aria-label='Send prompt']",
        "button[aria-label='Send message']",
        'button.composer-submit-button-color',
      ],
      loggedOut: ["a[href*='/auth/login']", "button[data-testid='login-button']"],
      loggedOutUrl: ['/auth/login', 'auth.openai.com', 'auth0.openai.com'],
      challenge: ["iframe[src*='challenges.cloudflare.com']", '#challenge-running', '#challenge-form'],
      challengeTitle: ['Just a moment'],
      errorText: ['Unusual activity has been detected', "You've reached", 'Something went wrong'],
      composerWaitMs: 15000,
      sendWaitMs: 18000,
      submitVerifyMs: 5000,
      // v2 (Stage 2)
      stop: ["button[data-testid='stop-button']", "button[aria-label='Stop streaming']", "button[aria-label='Stop answering']"],
      assistant: ["[data-message-author-role='assistant']"],
      assistantText: ['.markdown', '.whitespace-pre-wrap'],
      done: ["button[data-testid='copy-turn-action-button']"],
      quietMs: 2500,
      // S10: three times the 400 ms every other site uses. A chosen value, not a measurement, and the
      // reason is the failure of 2026-09-20: chatgpt re-renders the WHOLE markdown body on every token
      // batch, and while it composes a long fenced JSON document at a raised effort the gaps between
      // two renders are seconds, not frames. 400 ms of stillness is not evidence that such a reply has
      // finished — it is the ordinary pause while the next batch is being thought about.
      settleMs: 1200,
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
    },
    claude: {
      chatUrlPattern: '^https://claude\\.ai/chat/[0-9a-f-]+',
      composer: [
        "div[contenteditable='true'].ProseMirror",
        "div[contenteditable='true'][data-testid]",
        "div[contenteditable='true']",
      ],
      send: ["button[aria-label='Send message']", "button[aria-label*='Send Message']", "button[aria-label*='Send']"],
      loggedOut: ["a[href*='/login']", "button[data-testid='login-with-google']"],
      loggedOutUrl: ['/login'],
      challenge: ["iframe[src*='challenges.cloudflare.com']"],
      challengeTitle: ['Just a moment'],
      errorText: ['unusual activity', 'rate limit'],
      composerWaitMs: 15000,
      sendWaitMs: 18000,
      submitVerifyMs: 5000,
      // v2 (Stage 2)
      stop: ["button[aria-label='Stop response']", "button[aria-label*='Stop']"],
      assistant: ['.font-claude-response:not(#markdown-artifact)', '.font-claude-message'],
      // The reply BODY, not the whole turn (S8, contract §4 change request). Measured live on
      // 2026-09-17 (read-only probe, docs/desktop-verification.md item 28): inside
      // `.font-claude-response` a `.prose` element holds 2717 of the container's 2754 innerText
      // characters — the rendered answer; the 37 outside it are the turn's own chrome. With this
      // cascade EMPTY the capture was the whole container, and a real Send on 2026-09-18 showed what
      // that costs: claude renders a thinking / tool-use summary line TWICE (the row on screen plus
      // the collapsed panel's own copy — neither `display:none`, `visibility:hidden`, `hidden` nor
      // `aria-hidden`, which is all `mdHidden` drops), so the captured reply began
      // "<summary>\n\n<summary>\n\n<answer>" ("Searched the web" twice on a web-search turn).
      // Reading the body from `.prose` removes that chrome by STRUCTURE, never by matching its text,
      // and it cannot lose the answer: `replyText` joins EVERY `.prose` match and falls back to the
      // whole container when none matches (exactly the old behaviour). One entry on purpose — a
      // second, looser guess (`.grid-cols-1`) would be consulted only when `.prose` is gone and
      // could then match a SMALL grid inside the answer, which would silently truncate the capture.
      assistantText: ['.prose'],
      done: [],
      quietMs: 2500,
      settleMs: 400, // four throttle ticks: a 100 ms lull between two token batches is ordinary mid-stream
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
    },
    grok: {
      chatUrlPattern: '^https://grok\\.com/(c|chat)/[A-Za-z0-9-]+(?:[?#]|$)',
      // Verified live on grok.com (signed in, 2026-09-16; contract §4): the composer is a
      // TipTap/ProseMirror div inside a <form>. A hidden 14 px helper <textarea> also exists on the
      // page, so a bare `textarea` entry must NEVER be a fallback — it matched the helper, the
      // insertion "verified" against it and the prompt vanished.
      composer: [
        "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']",
        "div[role='textbox'][aria-label='Ask Grok anything']",
        "div.ProseMirror[contenteditable='true']",
        "textarea[aria-label='Ask Grok anything']",
        "textarea[placeholder*='Grok']",
        "div[contenteditable='true'][data-lexical-editor='true']",
      ],
      // Rendered only once the editor holds text (an "Enter voice mode" button occupies the slot
      // while it is empty): `submit()` polls this cascade AFTER the insertion, never before.
      send: ["button[data-testid='chat-submit']", "button[aria-label='Submit']", "button[type='submit']"],
      loggedOut: ["a[href*='/sign-in']", "a[href*='accounts.x.ai']"],
      loggedOutUrl: ['accounts.x.ai', '/sign-in'],
      challenge: ["iframe[src*='challenges.cloudflare.com']"],
      challengeTitle: ['Just a moment'],
      errorText: ['unusual activity'],
      composerWaitMs: 15000,
      sendWaitMs: 18000,
      submitVerifyMs: 5000,
      // v2 (Stage 2)
      stop: ["button[aria-label='Stop']", "button[aria-label*='Stop']"],
      assistant: ["div[id^='response-']"],
      assistantText: ['.response-content-markdown'],
      done: [],
      quietMs: 2500,
      settleMs: 400, // four throttle ticks: a 100 ms lull between two token batches is ordinary mid-stream
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
    },
  }

  // ---------------------------------------------------------------------------------------------
  // Pure helpers (no DOM)
  // ---------------------------------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone)
    if (isPlainObject(v)) {
      const out = {}
      for (const k of Object.keys(v)) out[k] = clone(v[k])
      return out
    }
    return v
  }

  function kindOf(v) {
    if (Array.isArray(v)) return 'array'
    if (v === null) return 'null'
    return typeof v
  }

  /**
   * Merge a selectors override into the defaults: per site, per key, the override REPLACES the
   * default value. Unknown sites/keys and type mismatches are skipped and reported in `warnings`.
   * Returns `{merged, warnings}`; `defaults` is never mutated.
   */
  function mergeSelectors(defaults, override) {
    const merged = clone(defaults)
    const warnings = []
    if (override === undefined || override === null) return { merged, warnings }
    if (!isPlainObject(override)) {
      warnings.push('override: expected a JSON object')
      return { merged, warnings }
    }
    for (const site of Object.keys(override)) {
      const block = override[site]
      if (site === 'version') {
        if (block !== defaults.version) warnings.push(`version: expected ${defaults.version}, got ${JSON.stringify(block)}`)
        continue
      }
      if (!isPlainObject(defaults[site])) {
        warnings.push(`${site}: unknown site`)
        continue
      }
      if (!isPlainObject(block)) {
        warnings.push(`${site}: expected an object`)
        continue
      }
      for (const key of Object.keys(block)) {
        if (!Object.prototype.hasOwnProperty.call(defaults[site], key)) {
          warnings.push(`${site}.${key}: unknown key`)
          continue
        }
        const want = kindOf(defaults[site][key])
        const got = kindOf(block[key])
        if (want !== got) {
          warnings.push(`${site}.${key}: expected ${want}, got ${got}`)
          continue
        }
        if (want === 'array' && !block[key].every((x) => typeof x === 'string')) {
          warnings.push(`${site}.${key}: expected a list of strings`)
          continue
        }
        merged[site][key] = clone(block[key])
      }
    }
    return { merged, warnings }
  }

  function hostMatches(hostname, host) {
    if (typeof hostname !== 'string' || typeof host !== 'string') return false
    const a = hostname.toLowerCase().replace(/\.$/, '')
    const b = host.toLowerCase().replace(/\.$/, '')
    return a === b || a.endsWith('.' + b)
  }

  /** Map a hostname (or a subdomain of a listed host) to a slot via `sites[slot].hosts`; null when unknown. */
  function siteFor(hostname, sites) {
    if (!sites || typeof hostname !== 'string') return null
    const order = SLOTS.filter((s) => s in sites).concat(Object.keys(sites).filter((s) => !SLOTS.includes(s)))
    for (const slot of order) {
      const hosts = sites[slot] && sites[slot].hosts
      if (Array.isArray(hosts) && hosts.some((h) => hostMatches(hostname, h))) return slot
    }
    return null
  }

  /** Pick the per-site block out of either a full selectors config or an already-narrowed block. */
  function siteSelectors(selectors, site) {
    if (isPlainObject(selectors) && site && isPlainObject(selectors[site])) return selectors[site]
    if (isPlainObject(selectors) && Array.isArray(selectors.composer)) return selectors
    return site && DEFAULT_SELECTORS[site] ? DEFAULT_SELECTORS[site] : null
  }

  /** CRLF → LF and NBSP → space; everything else byte-for-byte. */
  function normalizeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
  }

  function squash(s) {
    return normalizeText(s).replace(/\s+/g, '')
  }

  /**
   * Insertion verification (contract §3): `actual` must end with the last `n` characters of
   * `expected`. Compared with whitespace removed on both sides, because editors legitimately
   * re-render whitespace (paragraphs for newlines, NBSP for runs of spaces) while every
   * non-whitespace character must survive verbatim.
   */
  function tailMatches(actual, expected, n = VERIFY_TAIL_CHARS) {
    const tail = squash(expected).slice(-n)
    return squash(actual).endsWith(tail)
  }

  function isBlank(s) {
    return normalizeText(s).trim() === ''
  }

  /** A non-negative integer from `v`, else `fallback`. */
  function nonNegativeInt(v, fallback) {
    const n = Number(v)
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
  }

  /**
   * Does `text` already hold the KIND of answer the caller is waiting for? (S10, contract §3 `expect`.)
   *
   * `expect === 'json'` — true once the text contains a BALANCED `{…}` object, fenced or bare. The scan
   * is string-aware: a brace inside a JSON string is data, and a backslash escapes the next character,
   * so `{"a": "} not the end"` is not complete. A `}` with nothing open is a stray closer (prose, a
   * fence's own text) and closes nothing. Anything else — a missing or unknown kind — is always true, so
   * a capture that expects nothing behaves exactly as it always did.
   *
   * Why the capture needs this at all: every end signal is a reading of ONE sample of a DOM that
   * re-renders, and on 2026-09-20 two analyst captures came back as ````JSON\n{\n```` (13 characters) and
   * `{"agre` (6) — stamped as finished replies, then reported to the user as a parse error. When the
   * answer is a document with a shape, the shape is the evidence that it is whole; a lull is not.
   */
  function looksComplete(text, expect) {
    if (expect !== 'json') return true
    const s = typeof text === 'string' ? text : ''
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        if (depth > 0) inString = true // a quote outside every object is prose, not a JSON string
      } else if (ch === '{') depth += 1
      else if (ch === '}' && depth > 0) {
        depth -= 1
        if (depth === 0) return true
      }
    }
    return false
  }

  function isResultCode(code) {
    return typeof code === 'string' && RESULT_CODES.includes(code)
  }

  /** The usable entries of a selector cascade: non-empty strings, in order; `[]` for anything else. */
  function nonEmptyCascade(cascade) {
    return Array.isArray(cascade) ? cascade.filter((s) => typeof s === 'string' && s !== '') : []
  }

  class AdapterError extends Error {
    constructor(code, message, partial) {
      super(message || code)
      this.name = 'AdapterError'
      this.code = isResultCode(code) ? code : 'site_error'
      if (partial !== undefined) this.partial = partial
    }
  }

  // ---------------------------------------------------------------------------------------------
  // DOM helpers (take the root/element as arguments; testable with plain fake objects)
  // ---------------------------------------------------------------------------------------------

  function queryOne(root, selector) {
    try {
      return (root && typeof root.querySelector === 'function' && root.querySelector(selector)) || null
    } catch (_e) {
      return null // an invalid selector in an override never breaks the cascade
    }
  }

  function queryAll(root, selector) {
    try {
      if (!root || typeof root.querySelectorAll !== 'function') return []
      return Array.from(root.querySelectorAll(selector))
    } catch (_e) {
      return []
    }
  }

  /** Every OPEN shadow root under `root`, nested ones included (closed roots are unreachable by design). */
  function openShadowRoots(root, depth = 0, out = []) {
    for (const el of queryAll(root, '*')) {
      if (el && el.shadowRoot) {
        out.push(el.shadowRoot)
        if (depth < MAX_SHADOW_DEPTH) openShadowRoots(el.shadowRoot, depth + 1, out)
      }
    }
    return out
  }

  function resolveRoots(root, roots) {
    if (typeof roots === 'function') return roots()
    if (Array.isArray(roots)) return roots
    return openShadowRoots(root)
  }

  /** querySelector over `root`, then over its open shadow roots (`roots`: array, lazy function or omitted). */
  function deepQuerySelector(root, selector, roots) {
    const hit = queryOne(root, selector)
    if (hit) return hit
    for (const sr of resolveRoots(root, roots)) {
      const h = queryOne(sr, selector)
      if (h) return h
    }
    return null
  }

  /** querySelectorAll over `root` and its open shadow roots, document order per root. */
  function deepQuerySelectorAll(root, selector, roots) {
    const out = queryAll(root, selector)
    for (const sr of resolveRoots(root, roots)) out.push(...queryAll(sr, selector))
    return out
  }

  /**
   * `ancestor` contains `el` in the FLATTENED tree: `contains` plus the shadow hops `contains` does
   * not make. `deepQuerySelectorAll` searches open shadow roots, so two matches of the same cascade
   * entry can be a host and a node inside its shadow root — and a plain `contains` says no, which
   * would make `replyText` concatenate a node with its own ancestor (the same text twice).
   */
  function containsDeep(ancestor, el) {
    if (!ancestor || !el || ancestor === el) return false
    if (safeTrue(() => typeof ancestor.contains === 'function' && ancestor.contains(el) === true)) return true
    let node = el
    for (let hops = 0; hops < MAX_ANCESTOR_HOPS; hops += 1) {
      let next = null
      try {
        next = node.parentNode || node.host || null // a shadow root has no parentNode; it has a host
      } catch (_e) {
        return false
      }
      if (!next || next === node) return false
      if (next === ancestor) return true
      if (safeTrue(() => typeof ancestor.contains === 'function' && ancestor.contains(next) === true)) return true
      node = next
    }
    return false
  }

  /** The element's computed style through `win`, else its own document's view; null without one. */
  function computedStyle(el, win) {
    const view = win || (el.ownerDocument && el.ownerDocument.defaultView) || null
    return view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) || null : null
  }

  /**
   * Rendered (a non-empty box) and not hidden by CSS: `display:none`, `visibility:hidden` or
   * `opacity:0` (a hover-revealed action bar, grok's invisible helper textarea). Elements without
   * layout APIs (fakes) count as visible.
   */
  function isVisible(el, win) {
    if (!el) return false
    try {
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
      if (typeof el.getBoundingClientRect === 'function') {
        // Playwright's rule: a collapsed 0×0 box (an overflow-hidden or animated-out duplicate) is not visible
        const r = el.getBoundingClientRect()
        if (r && (r.width === 0 || r.height === 0)) return false
      }
      const cs = computedStyle(el, win)
      if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || String(cs.opacity) === '0')) return false
    } catch (_e) {
      /* treat as visible */
    }
    return true
  }

  /** Visible AND reachable by a click: a painted button under `pointer-events:none` is not one the user could press (the send / stop / done filters). */
  function isClickable(el, win) {
    if (!isVisible(el, win)) return false
    try {
      const cs = computedStyle(el, win)
      if (cs && cs.pointerEvents === 'none') return false
    } catch (_e) {
      /* treat as clickable */
    }
    return true
  }

  /** `fn()` returned true; a throwing `fn` (no attribute API, an unsupported pseudo-class) counts as false. */
  function safeTrue(fn) {
    try {
      return fn() === true
    } catch (_e) {
      return false
    }
  }

  /** Not `disabled` (property, attribute or `:disabled` — a disabled <fieldset> ancestor counts) and not `aria-disabled="true"`. */
  function isEnabled(el) {
    if (!el) return false
    if (el.disabled === true) return false
    if (safeTrue(() => typeof el.matches === 'function' && el.matches(':disabled'))) return false
    if (safeTrue(() => typeof el.hasAttribute === 'function' && el.hasAttribute('disabled'))) return false
    if (safeTrue(() => typeof el.getAttribute === 'function' && String(el.getAttribute('aria-disabled')).toLowerCase() === 'true')) return false
    return true
  }

  function tagOf(el) {
    return el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  }

  function isTextField(el) {
    const t = tagOf(el)
    return t === 'TEXTAREA' || t === 'INPUT'
  }

  /** The composer's current text: `value` for text fields, rendered text (innerText, else textContent) otherwise. */
  function readText(el) {
    if (!el) return ''
    try {
      if (isTextField(el)) return String(el.value === null || el.value === undefined ? '' : el.value)
      const t = typeof el.innerText === 'string' ? el.innerText : el.textContent
      return String(t === null || t === undefined ? '' : t)
    } catch (_e) {
      return ''
    }
  }

  // ---------------------------------------------------------------------------------------------
  // DOM snapshot scrubbing (contract §3 `scrubDom`; Stage 2)
  // ---------------------------------------------------------------------------------------------

  function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /**
   * Kept attribute values are structure, but on the real sites a few carry identity (a chat or
   * message uuid inside an id, an e-mail address or an X handle in a label or a placeholder, an
   * avatar host in a class). Every identity TOKEN is replaced whole — the address with its local
   * part and domain, the profile path, the chat id — never just the delimiter the fixture lint
   * keys on, so nothing of the account survives and the lint passes by construction; the bare
   * delimiter rules at the end only cover a token-less leftover (`/c/` at the end of a value).
   */
  function scrubValue(v) {
    return String(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'uuid')
      .replace(/googleusercontent/gi, 'img-host')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, 'email') // the whole address, local part and domain
      .replace(/@[\w.+-]+/g, 'handle') // a bare @handle
      .replace(/@/g, '(at)') // a stray at-sign
      .replace(/x\.com\/[^\s"'<>]*/gi, 'x-com/profile') // a profile link, path included
      .replace(/\/(c|chat)\/[^\s"'<>/]+/g, '/$1-/id') // a chat id
      .replace(/\/(c|chat)\//g, '/$1-/') // a token-less chat path
  }

  function tagNameOf(node) {
    const n = typeof node.localName === 'string' && node.localName !== '' ? node.localName : String(node.nodeName || node.tagName || '')
    return n.toLowerCase()
  }

  /** `[name, value]` pairs from a NamedNodeMap / array of `{name, value}`, or a plain object (fakes). */
  function attrsOf(node) {
    const a = node.attributes
    if (!a) return []
    if (typeof a.length === 'number') {
      return Array.from(a, (x) => [String(x.name).toLowerCase(), x.value === null || x.value === undefined ? '' : String(x.value)])
    }
    if (isPlainObject(a)) return Object.keys(a).map((k) => [k.toLowerCase(), String(a[k])])
    return []
  }

  function childrenOf(node) {
    const c = node.childNodes
    return c && typeof c.length === 'number' ? Array.from(c) : []
  }

  function scrubNode(node, out) {
    if (!node || typeof node.nodeType !== 'number') return
    const type = node.nodeType
    if (type === 3) {
      const s = typeof node.data === 'string' ? node.data : typeof node.nodeValue === 'string' ? node.nodeValue : ''
      if (s.trim() !== '') out.push(TEXT_PLACEHOLDER)
      return
    }
    if (type === 11) {
      for (const c of childrenOf(node)) scrubNode(c, out)
      return
    }
    if (type !== 1) return // comments, doctype, processing instructions, cdata: dropped
    const tag = tagNameOf(node)
    if (SNAPSHOT_DROP_TAGS.includes(tag)) return
    out.push('<' + tag)
    for (const [name, value] of attrsOf(node)) {
      if (SNAPSHOT_KEEP_ATTRS.includes(name)) out.push(' ' + name + '="' + escapeAttr(scrubValue(value)) + '"')
    }
    out.push('>')
    if (VOID_TAGS.includes(tag)) return
    if (node.shadowRoot) {
      out.push('<template shadowrootmode="open">')
      scrubNode(node.shadowRoot, out)
      out.push('</template>')
    }
    for (const c of childrenOf(node)) scrubNode(c, out)
    out.push('</' + tag + '>')
  }

  /**
   * scrubDom(document) → string (contract §3): the page's structure and nothing else — every
   * `script|style|link|meta|img|svg|iframe|video|audio` dropped with its subtree, only
   * SNAPSHOT_KEEP_ATTRS kept (values passed through `scrubValue`), every non-blank text node
   * replaced by `…`, whitespace-only text / comments / doctype dropped, open shadow roots inlined
   * as `<template shadowrootmode="open">`. Accepts a Document (its documentElement) or any node.
   */
  function scrubDom(doc) {
    const root = doc && doc.documentElement ? doc.documentElement : doc
    const out = []
    scrubNode(root, out)
    return '<!doctype html>\n' + out.join('') + '\n'
  }

  // ---------------------------------------------------------------------------------------------
  // Rendered markdown (contract §3 `toMarkdown`; Stage 3)
  // ---------------------------------------------------------------------------------------------

  /** Elements whose subtree is never reply content: chrome, media, scripts and form controls. */
  const MD_SKIP_TAGS = Object.freeze([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'math',
    'canvas',
    'video',
    'audio',
    'iframe',
    'img',
    'picture',
    'source',
    'track',
    'button',
    'select',
    'option',
    'input',
    'textarea',
    'dialog',
  ])
  /** Block-level tags: everything else is inline (see `mdBlocks`). */
  const MD_BLOCK_TAGS = Object.freeze([
    'address',
    'article',
    'aside',
    'blockquote',
    'dd',
    'details',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
  ])
  /**
   * Code-block chrome: the copy/edit affordances the chat UIs render inside the block (mostly
   * `<button>`s — already dropped — but a bare `<span>`/`<div>` label is just as common). A block
   * whose whole text is one of these is dropped, and they are stripped from a code block's header
   * before the language is read out of it.
   */
  const MD_CHROME_TEXT = Object.freeze([
    'copy',
    'copy code',
    'copy to clipboard',
    'copied',
    'copied!',
    'edit',
    'download',
    'share',
    'run',
    'wrap',
    'unwrap',
    'wrap lines',
    'retry',
    'regenerate',
    'expand',
    'collapse',
    'good response',
    'bad response',
    'read aloud',
  ])
  /** `white-space` computed values that keep runs of spaces and newlines (the `pre` tag always does). */
  const MD_PRESERVE_WS = Object.freeze(['pre', 'pre-wrap', 'pre-line', 'break-spaces'])
  /** A code-block header is a bare language token, never a sentence. */
  const MD_LANG_RE = /^[A-Za-z0-9+#._-]{1,24}$/
  /** Tags that are reply CONTENT even when their whole text is one bare token: never a fence's header. */
  const MD_NEVER_HEADER_TAGS = Object.freeze(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'table', 'blockquote', 'pre'])

  function mdNodeType(n) {
    return n && typeof n.nodeType === 'number' ? n.nodeType : 0
  }

  function mdChildren(n) {
    if (!n || typeof n !== 'object') return []
    const c = n.childNodes
    return c && typeof c.length === 'number' ? Array.from(c) : []
  }

  function mdAttr(el, name) {
    if (!safeTrue(() => typeof el.getAttribute === 'function')) return ''
    const v = el.getAttribute(name)
    return v === null || v === undefined ? '' : String(v)
  }

  function mdClasses(el) {
    const raw = mdAttr(el, 'class') || (typeof el.className === 'string' ? el.className : '')
    return raw.split(/\s+/).filter((s) => s !== '')
  }

  function mdIsChrome(s) {
    return MD_CHROME_TEXT.includes(String(s).trim().toLowerCase().replace(/\s+/g, ' '))
  }

  /** The style bag of `el` through its own document's view; cached per render, null without one. */
  function mdStyle(el, ctx) {
    if (ctx.styles.has(el)) return ctx.styles.get(el)
    let cs = null
    try {
      cs = computedStyle(el, ctx.win)
    } catch (_e) {
      cs = null
    }
    ctx.styles.set(el, cs)
    return cs
  }

  /** A `pre` always preserves; otherwise the computed `white-space` decides (no view means collapse). */
  function mdPreserves(el, ctx, inherited) {
    if (tagNameOf(el) === 'pre') return true
    const cs = mdStyle(el, ctx)
    if (!cs) return inherited
    const ws = String(cs.whiteSpace === undefined || cs.whiteSpace === null ? '' : cs.whiteSpace).trim()
    if (ws === '') return inherited
    return MD_PRESERVE_WS.includes(ws)
  }

  /** Rendered away: `display:none`, `visibility:hidden`, `hidden` or `aria-hidden="true"`. */
  function mdHidden(el, ctx) {
    if (safeTrue(() => typeof el.hasAttribute === 'function' && el.hasAttribute('hidden'))) return true
    if (mdAttr(el, 'aria-hidden').toLowerCase() === 'true') return true
    const cs = mdStyle(el, ctx)
    return !!(cs && (cs.display === 'none' || cs.visibility === 'hidden'))
  }

  function mdSkip(el, ctx) {
    return MD_SKIP_TAGS.includes(tagNameOf(el)) || mdHidden(el, ctx)
  }

  function mdIsBlock(el) {
    return MD_BLOCK_TAGS.includes(tagNameOf(el))
  }

  /**
   * The raw text of a subtree — the body of a fenced block: newlines from `<br>` and from every
   * BLOCK child (a highlighter that wraps each code line in a `div` / `.cm-line` keeps its lines,
   * an empty one its blank line), chrome dropped, a formula or an image rendered by itself.
   */
  function mdRawText(node, ctx) {
    if (mdNodeType(node) === 3) {
      const s = typeof node.data === 'string' ? node.data : typeof node.nodeValue === 'string' ? node.nodeValue : ''
      return normalizeText(s)
    }
    if (mdNodeType(node) !== 1) return ''
    if (mdSelfRendered(node)) return mdSelfRender(node, ctx)
    if (mdSkip(node, ctx)) return ''
    if (tagNameOf(node) === 'br') return '\n'
    let out = ''
    let open = false // the previous child was a block: it ended its own line
    for (const c of mdChildren(node)) {
      if (mdNodeType(c) === 1 && !mdSelfRendered(c) && mdSkip(c, ctx)) continue
      const block = mdNodeType(c) === 1 && mdIsBlock(c)
      const text = mdRawText(c, ctx)
      if (!block && text === '') continue
      if ((block || open) && out !== '') out += '\n'
      out += text
      open = block
    }
    return out
  }

  /** An element the walk renders ITSELF instead of descending into (all of them are in MD_SKIP_TAGS). */
  function mdSelfRendered(el) {
    const tag = tagNameOf(el)
    return tag === 'math' || tag === 'img' || tag === 'picture'
  }

  /** A formula / an image, ONCE, wherever the walk meets it; a hidden one renders to `''`. */
  function mdSelfRender(node, ctx) {
    if (mdHidden(node, ctx)) return ''
    return tagNameOf(node) === 'math' ? mdMath(node, ctx) : mdImage(node)
  }

  /**
   * The TeX source of a MathML formula (`annotation[encoding="application/x-tex"]`), `''` without one.
   * Its text is read DIRECTLY: the annotation is the source copy by design and the UA hides it
   * (MathML Core renders only `semantics`' first child), so the usual hidden-subtree rule must not
   * apply to it.
   */
  function mdTexOf(math) {
    let out = ''
    const walk = (n) => {
      if (out !== '' || mdNodeType(n) !== 1) return
      if (tagNameOf(n) === 'annotation') {
        const enc = mdAttr(n, 'encoding').toLowerCase()
        if (enc === '' || enc.includes('tex')) {
          let raw = ''
          try {
            raw = typeof n.textContent === 'string' ? n.textContent : ''
          } catch (_e) {
            raw = ''
          }
          out = normalizeText(raw).replace(/\s+/g, ' ').trim()
        }
        return
      }
      for (const c of mdChildren(n)) walk(c)
    }
    walk(math)
    return out
  }

  /** A formula's own glyph run (the MathML characters), the `annotation` subtrees left out. */
  function mdMathGlyphs(math, ctx) {
    let out = ''
    const walk = (n) => {
      const type = mdNodeType(n)
      if (type === 3) {
        out += mdRawText(n, ctx)
        return
      }
      if (type !== 1 || tagNameOf(n) === 'annotation') return
      if (tagNameOf(n) !== 'math' && mdSkip(n, ctx)) return
      for (const c of mdChildren(n)) walk(c)
    }
    for (const c of mdChildren(math)) walk(c)
    return out.replace(/\s+/g, ' ').trim()
  }

  /**
   * A formula ONCE: its TeX source when the MathML carries one (KaTeX's accessible copy is hidden by
   * clip, not by `display:none`, so the walk sees both the glyph run and the annotation) — `$…$`,
   * `$$…$$` for `display="block"` — else the glyph run.
   */
  function mdMath(math, ctx) {
    const tex = mdTexOf(math)
    if (tex === '') return mdMathGlyphs(math, ctx)
    return mdAttr(math, 'display').toLowerCase() === 'block' ? '$$' + tex + '$$' : '$' + tex + '$'
  }

  /** An image is its alt text (`![alt]()`); the URL is dropped like a link's, and no alt is nothing. */
  function mdImage(node) {
    const img = tagNameOf(node) === 'img' ? node : queryOne(node, 'img')
    const alt = img ? mdAttr(img, 'alt').replace(/\s+/g, ' ').trim() : ''
    return alt === '' ? '' : '![' + alt + ']()'
  }

  /**
   * A code span, delimited the way CommonMark requires: a run of backticks longer than any run
   * inside the body, plus a space of padding when the body starts or ends with one — so a body that
   * itself shows backticks (a reply about markdown) reads back with them intact.
   */
  function mdCodeSpan(body) {
    if (body === '') return ''
    const longest = (body.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0)
    const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
    return '`'.repeat(longest + 1) + pad + body + pad + '`'.repeat(longest + 1)
  }

  /** Inline markdown for one node (emphasis, inline code, a link as its text; the URL is dropped). */
  function mdInline(node, ctx) {
    if (mdNodeType(node) === 3) {
      const s = normalizeText(typeof node.data === 'string' ? node.data : typeof node.nodeValue === 'string' ? node.nodeValue : '')
      return ctx.preserve ? s : s.replace(/\s+/g, ' ')
    }
    if (mdNodeType(node) !== 1) return ''
    if (mdSelfRendered(node)) return mdSelfRender(node, ctx)
    if (mdSkip(node, ctx)) return ''
    const tag = tagNameOf(node)
    if (tag === 'br') return '\n'
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') return mdCodeSpan(mdRawText(node, ctx).replace(/\s+/g, ' ').trim())
    const inner = mdInlineChildren(node, { ...ctx, preserve: mdPreserves(node, ctx, ctx.preserve) })
    if (inner.trim() === '') return inner
    if (tag === 'strong' || tag === 'b') return '**' + inner + '**'
    if (tag === 'em' || tag === 'i') return '_' + inner + '_'
    if (tag === 'del' || tag === 's' || tag === 'strike') return '~~' + inner + '~~'
    return inner
  }

  function mdInlineChildren(el, ctx) {
    let out = ''
    for (const c of mdChildren(el)) out += mdInline(c, ctx)
    return out
  }

  /** One element's whole inline text (a heading, a table cell, a list item's own line). */
  function mdInlineOf(el, ctx) {
    const inner = mdInlineChildren(el, { ...ctx, preserve: mdPreserves(el, ctx, ctx.preserve) })
    return mdTidy(inner, ctx.preserve)
  }

  /** Trim the blank edges of a rendered block, never its inside. */
  function mdTidy(s, preserve) {
    return preserve ? s.replace(/^\n+|[ \t\n]+$/g, '') : s.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
  }

  /** `language-json` / `lang-py` / `data-language` on the code or its `pre`. */
  function mdLanguageOf(el) {
    for (const c of mdClasses(el)) {
      const m = /^(?:language|lang|highlight)-(.+)$/.exec(c)
      if (m && MD_LANG_RE.test(m[1])) return m[1]
    }
    for (const name of ['data-language', 'data-lang', 'data-code-language']) {
      const v = mdAttr(el, name).trim()
      if (v !== '' && MD_LANG_RE.test(v)) return v
    }
    return ''
  }

  /** A code block's header text when it sits INSIDE the `pre`: everything but the code and the chrome. */
  function mdHeaderLanguage(pre, code, ctx) {
    let raw = ''
    const walk = (node) => {
      if (node === code) return
      if (mdNodeType(node) === 3) {
        raw += mdRawText(node, ctx)
        return
      }
      // every `code` is body (a `pre` may render one per line), never a language label
      if (mdNodeType(node) !== 1 || tagNameOf(node) === 'code' || mdSkip(node, ctx)) return
      for (const c of mdChildren(node)) walk(c)
    }
    for (const c of mdChildren(pre)) walk(c)
    const token = raw
      .split(/\s+/)
      .filter((s) => s !== '' && !mdIsChrome(s))
      .join(' ')
      .trim()
    return token !== '' && MD_LANG_RE.test(token) && !mdIsChrome(token) ? token : ''
  }

  /**
   * The `code` bodies of a `pre`, in document order — a nested `code` stays folded into its parent
   * (it is already part of that body), and the open shadow roots are searched when the `pre` itself
   * holds none.
   */
  function mdCodesIn(pre) {
    const codes = queryAll(pre, 'code')
    if (codes.length > 1) {
      const outer = codes.filter((c) => !codes.some((o) => o !== c && safeTrue(() => typeof o.contains === 'function' && o.contains(c) === true)))
      if (outer.length > 0) return outer
    }
    if (codes.length > 0) return codes
    const deep = deepQuerySelector(pre, 'code')
    return deep ? [deep] : []
  }

  /** The fence's own info string — the code's class, its `pre`'s, or a header INSIDE the `pre`; `''` when it has none. */
  function fenceLanguage(pre, ctx, codes) {
    if (!pre) return ''
    const list = codes || mdCodesIn(pre)
    const code = list[0] || pre
    return mdLanguageOf(code) || mdLanguageOf(pre) || mdHeaderLanguage(pre, code, ctx)
  }

  /** `pre` as a fenced block: every `code` descendant is body; the language comes from it, its `pre`, an in-block header or the wrapper header. */
  function mdFence(pre, ctx) {
    const codes = mdCodesIn(pre)
    const code = codes[0] || pre
    const body = (codes.length > 1 ? codes.map((c) => mdRawText(c, ctx)).join('\n') : mdRawText(code, ctx)).replace(/\n+$/, '')
    const lang = fenceLanguage(pre, ctx, codes) || ctx.pendingLang || ''
    // the delimiter is always one backtick longer than the longest fence line inside the body
    const inside = (body.match(/^[ \t]*`{3,}/gm) || []).reduce((n, run) => Math.max(n, run.trim().length), 0)
    const ticks = '`'.repeat(Math.max(3, inside + 1))
    return ticks + lang + '\n' + body + '\n' + ticks
  }

  /** `ul`/`ol` as `- ` / `1. ` items; a nested list is indented by the marker's width. */
  function mdList(el, ctx) {
    const ordered = tagNameOf(el) === 'ol'
    const startAttr = parseInt(mdAttr(el, 'start'), 10)
    let n = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1
    const lines = []
    for (const li of mdChildren(el)) {
      if (mdNodeType(li) !== 1 || tagNameOf(li) !== 'li' || mdSkip(li, ctx)) continue
      const marker = ordered ? `${n++}. ` : '- '
      // A nested list hangs directly off its item's line (a tight list); any other block is a
      // paragraph inside the item and keeps its blank line.
      const entries = mdBlockEntries(li, { ...ctx, preserve: mdPreserves(li, ctx, ctx.preserve), pendingLang: '' })
      const body = entries.reduce((acc, e, i) => (i === 0 ? e.text : acc + (e.tag === 'ul' || e.tag === 'ol' ? '\n' : '\n\n') + e.text), '')
      const indented = body
        .split('\n')
        .map((line, i) => (i === 0 ? marker + line : line === '' ? '' : ' '.repeat(marker.length) + line))
        .join('\n')
      lines.push(body === '' ? marker.trimEnd() : indented)
    }
    return lines.join('\n')
  }

  /** `table` as GFM pipes: the first row holding a `th` (else the first row) is the header. */
  function mdTable(el, ctx) {
    const rows = []
    const collect = (node) => {
      for (const c of mdChildren(node)) {
        if (mdNodeType(c) !== 1 || mdSkip(c, ctx)) continue
        const tag = tagNameOf(c)
        if (tag === 'tr') rows.push(c)
        else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') collect(c)
      }
    }
    collect(el)
    if (rows.length === 0) return ''
    const cellsOf = (tr) =>
      mdChildren(tr)
        .filter((c) => mdNodeType(c) === 1 && (tagNameOf(c) === 'td' || tagNameOf(c) === 'th') && !mdSkip(c, ctx))
        .map((c) => mdInlineOf(c, ctx).replace(/\|/g, '\\|').replace(/\n+/g, ' '))
    const headerIndex = rows.findIndex((tr) => mdChildren(tr).some((c) => mdNodeType(c) === 1 && tagNameOf(c) === 'th'))
    const headRow = headerIndex === -1 ? 0 : headerIndex
    const head = cellsOf(rows[headRow])
    const width = rows.reduce((w, tr) => Math.max(w, cellsOf(tr).length), head.length)
    const pad = (cells) => {
      const out = cells.slice(0, width)
      while (out.length < width) out.push('')
      return '| ' + out.join(' | ') + ' |'
    }
    const lines = [pad(head), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |']
    rows.forEach((tr, i) => {
      if (i !== headRow) lines.push(pad(cellsOf(tr)))
    })
    return lines.join('\n')
  }

  /**
   * The blocks an element renders to, each tagged with the tag that produced it (the tag is what
   * lets `mdList` keep a nested list tight against its item): a heading, a fence, a list, a table,
   * a quote, else its children's blocks.
   */
  function mdBlock(el, ctx) {
    const tag = tagNameOf(el)
    const inner = { ...ctx, preserve: mdPreserves(el, ctx, ctx.preserve) }
    const one = (text) => (text === '' ? [] : [{ tag, text }])
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) {
      const text = mdInlineOf(el, inner)
      return text === '' ? [] : [{ tag, text: '#'.repeat(Number(heading[1])) + ' ' + text.replace(/\n+/g, ' ') }]
    }
    if (tag === 'hr') return [{ tag, text: '---' }]
    if (tag === 'pre') return [{ tag, text: mdFence(el, inner) }]
    if (tag === 'ul' || tag === 'ol') return one(mdList(el, inner))
    if (tag === 'table') return one(mdTable(el, inner))
    if (tag === 'blockquote') {
      const body = mdBlocks(el, { ...inner, pendingLang: '' }).join('\n\n')
      return one(
        body === ''
          ? ''
          : body
              .split('\n')
              .map((line) => (line === '' ? '>' : '> ' + line))
              .join('\n'),
      )
    }
    return mdBlockEntries(el, inner)
  }

  /** The bare language label of a code-block header; `''` when the element is content. */
  function mdHeaderToken(el, ctx) {
    const token = mdRawText(el, ctx).trim().replace(/\s+/g, ' ')
    if (token === '' || mdIsChrome(token) || !MD_LANG_RE.test(token)) return ''
    return token
  }

  /** The `pre` `el` is or holds (the light DOM only: this runs once per block child, so it stays a single native query). */
  function mdPreIn(el) {
    return tagNameOf(el) === 'pre' ? el : queryOne(el, 'pre')
  }

  /** `el` is or holds a `pre`. */
  function mdHasPre(el) {
    return mdPreIn(el) !== null
  }

  /** The first element child after `from` that is not chrome; null when there is none. */
  function mdNextElement(children, from) {
    for (let i = from; i < children.length; i += 1) {
      const n = children[i]
      if (mdNodeType(n) === 1) return n
    }
    return null
  }

  /**
   * An element's blocks: runs of inline children become one paragraph, block children render
   * themselves. A bare language label directly before a block holding a `pre` (a code-block header
   * rendered outside the `pre`) is carried into the fence instead of becoming a paragraph, and a
   * block whose whole text is copy/edit chrome is dropped.
   */
  function mdBlockEntries(el, ctx) {
    const out = []
    let inline = []
    const flush = () => {
      if (inline.length === 0) return
      const text = mdTidy(inline.map((n) => mdInline(n, ctx)).join(''), ctx.preserve)
      inline = []
      if (text.trim() !== '') out.push({ tag: 'p', text })
    }
    const children = mdChildren(el)
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i]
      const type = mdNodeType(child)
      if (type === 3) {
        inline.push(child)
        continue
      }
      if (type !== 1) continue
      if (mdSkip(child, ctx) && !mdSelfRendered(child)) continue
      if (!mdIsBlock(child)) {
        inline.push(child)
        continue
      }
      flush()
      if (!mdHasPre(child)) {
        // A bare language label directly before the block that holds the `pre` is that fence's
        // language (the subtree is only walked when a code block really follows) — but ONLY when the
        // fence has no language of its own, or the very same one: a one-token block a fence already
        // names differently (`### 2000`, a `**app.py**` label) is CONTENT and is emitted as a block,
        // and a heading / list / table / quote is content whatever the fence says.
        const next = mdNextElement(children, i + 1)
        if (next && !mdSkip(next, ctx) && mdHasPre(next) && !MD_NEVER_HEADER_TAGS.includes(tagNameOf(child))) {
          const token = mdHeaderToken(child, ctx)
          const lang = token === '' ? '' : fenceLanguage(mdPreIn(next), ctx)
          if (token !== '' && (lang === '' || lang.toLowerCase() === token.toLowerCase())) {
            ctx.pendingLang = token
            continue
          }
        }
      }
      const entries = mdBlock(child, ctx)
      // a block that renders to one paragraph of copy/edit chrome is chrome, not content
      if (entries.length === 1 && entries[0].tag === 'p' && mdIsChrome(entries[0].text)) continue
      for (const entry of entries) if (entry.text !== '') out.push(entry)
      ctx.pendingLang = ''
    }
    flush()
    return out
  }

  /** The block strings of `el` (see `mdBlockEntries`). */
  function mdBlocks(el, ctx) {
    return mdBlockEntries(el, ctx).map((e) => e.text)
  }

  /**
   * toMarkdown(el) → string (contract §3, Stage 3): the rendered markdown of a reply container —
   * `pre`/`code` as fenced blocks with the language from a `language-xxx` class or the block's own
   * header, "Copy code" chrome stripped, headings as `#`, nested lists as `-` / `1.`, tables as GFM
   * pipes, links as their text (the URL is dropped), `strong`/`em` as `**` / `_`, paragraphs
   * separated by a blank line and inline whitespace collapsed — except where the page preserves it
   * (`pre`, or a computed `white-space` of pre / pre-wrap / pre-line / break-spaces), which is
   * copied verbatim. Never throws and never reaches the network; `''` for a node with no children
   * (the caller then falls back to the rendered text — see `replyText`).
   */
  function toMarkdown(el, { window: win } = {}) {
    if (!el || typeof el !== 'object') return ''
    try {
      const view = win || (el.ownerDocument && el.ownerDocument.defaultView) || null
      const ctx = { styles: new Map(), win: view, preserve: false, pendingLang: '' }
      if (mdNodeType(el) === 3) return mdTidy(mdInline(el, ctx), false)
      ctx.preserve = mdNodeType(el) === 1 ? mdPreserves(el, ctx, false) : false
      const tag = tagNameOf(el)
      if (mdNodeType(el) === 1 && mdSelfRendered(el)) return mdTidy(mdInline(el, ctx), false)
      if (mdNodeType(el) === 1 && mdIsBlock(el) && tag !== 'div' && tag !== 'section' && tag !== 'article' && tag !== 'main') {
        return mdBlock(el, ctx)
          .map((e) => e.text)
          .join('\n\n')
      }
      return mdBlocks(el, ctx).join('\n\n')
    } catch (_e) {
      return ''
    }
  }

  function makeController() {
    const AC = globalThis.AbortController
    if (typeof AC === 'function') return new AC()
    const signal = { aborted: false }
    return {
      signal,
      abort() {
        signal.aborted = true
      },
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Adapter
  // ---------------------------------------------------------------------------------------------

  /**
   * createAdapter({document, window, site, selectors, now = Date.now, timers}) — contract §3.
   * `selectors` may be the full config (`{version, chatgpt, claude, grok}`, re-merged onto
   * DEFAULT_SELECTORS so every key exists) or one site's block (taken as-is).
   * `timers` ({setTimeout, clearTimeout}) is injectable for tests; `now` stamps `ts`/`ms` and
   * drives timeouts. Every async op takes an optional `{signal}` (AbortSignal-like) and rejects
   * with `AdapterError('cancelled')` once it is aborted.
   */
  function createAdapter({ document, window, site, selectors, now = Date.now, timers } = {}) {
    if (!document) throw new Error('createAdapter: document is required')
    const win = window || (document.defaultView ? document.defaultView : null)
    const setT = (timers && timers.setTimeout) || globalThis.setTimeout
    const clearT = (timers && timers.clearTimeout) || globalThis.clearTimeout

    /**
     * This site's block out of `next`: a full config is re-merged onto DEFAULT_SELECTORS (override
     * replaces per key; unknown keys are dropped; every v1/v2 key is present afterwards), a bare
     * block (`{composer: [...]}`) is used as-is, anything else is null.
     */
    function resolveSelectors(next) {
      if (isPlainObject(next) && site && isPlainObject(next[site])) {
        const merged = mergeSelectors(DEFAULT_SELECTORS, next).merged
        return isPlainObject(merged[site]) ? merged[site] : next[site]
      }
      if (isPlainObject(next) && Array.isArray(next.composer)) return next
      return null
    }
    let sel = resolveSelectors(selectors) || siteSelectors(undefined, site) || {}

    /**
     * The document's open shadow roots, walked (`querySelectorAll('*')`) at most once per SAMPLE:
     * `sampled(fn)` opens a scope in which every finder shares one walk (health(), observe's check,
     * the ready / confirmation polls); outside a scope each finder walks at most once per call.
     */
    let sample = null // {roots: ShadowRoot[]|null} while a sample runs
    function shadowRoots() {
      if (sample === null) return openShadowRoots(document)
      if (sample.roots === null) sample.roots = openShadowRoots(document)
      return sample.roots
    }
    function sampled(fn) {
      if (sample !== null) return fn() // already inside a sample: share it
      sample = { roots: null }
      try {
        return fn()
      } finally {
        sample = null
      }
    }

    const sleep = (ms) => new Promise((resolve) => setT(resolve, ms))
    const clock = () => Number(now()) || 0

    function throwIfAborted(signal) {
      if (signal && signal.aborted) throw new AdapterError('cancelled', 'cancelled by main')
    }

    /** Call `fn` every `intervalMs` until it returns a truthy value (returned) or `timeoutMs` elapses (null). */
    async function poll(fn, { intervalMs, timeoutMs, signal }) {
      const t0 = clock()
      for (;;) {
        throwIfAborted(signal)
        const r = fn()
        if (r) return r
        const left = timeoutMs - (clock() - t0)
        if (left <= 0) return null
        await sleep(Math.min(intervalMs, left))
      }
    }

    /**
     * First cascade entry with a match in the document or an open shadow root. With `visible`/
     * `clickable`/`enabled`/`accept`, the first matching ELEMENT of an entry that passes the filters
     * (an entry whose matches are all hidden, unclickable, disabled or rejected does not stop the
     * cascade). `clickable` implies `visible` and also rejects `pointer-events:none`.
     */
    function findFirst(cascade, { visible = false, clickable = false, enabled = false, accept = null } = {}) {
      if (!Array.isArray(cascade)) return null
      let roots = null
      const shadow = () => (roots === null ? (roots = shadowRoots()) : roots)
      const filtered = visible || clickable || enabled || typeof accept === 'function'
      for (const selector of cascade) {
        if (typeof selector !== 'string' || selector === '') continue
        if (!filtered) {
          const el = deepQuerySelector(document, selector, shadow)
          if (el) return { el, selector }
          continue
        }
        for (const el of deepQuerySelectorAll(document, selector, shadow)) {
          if (clickable ? !isClickable(el, win) : visible && !isVisible(el, win)) continue
          if (enabled && !isEnabled(el)) continue
          if (accept && !accept(el)) continue
          return { el, selector }
        }
      }
      return null
    }

    function anyMatch(cascade) {
      return findFirst(cascade) !== null
    }

    function href() {
      try {
        return String((win && win.location && win.location.href) || (document.location && document.location.href) || '')
      } catch (_e) {
        return ''
      }
    }

    function host() {
      try {
        return String((win && win.location && win.location.hostname) || (document.location && document.location.hostname) || '')
      } catch (_e) {
        return ''
      }
    }

    function title() {
      try {
        return String(document.title || '')
      } catch (_e) {
        return ''
      }
    }

    /** True when `el` sits inside a rendered chat message (MESSAGE_SELECTORS); elements without `closest` (fakes) count as outside. */
    function insideMessage(el) {
      try {
        return !!(el && typeof el.closest === 'function' && el.closest(MESSAGE_SELECTOR))
      } catch (_e) {
        return false
      }
    }

    /** True when `container` wraps the thread or the composer: a layout region (an `aria-live` app root), not a banner. */
    function wrapsChat(container, composerEl) {
      if (queryOne(container, MESSAGE_SELECTOR)) return true
      try {
        return !!(composerEl && container !== composerEl && typeof container.contains === 'function' && container.contains(composerEl))
      } catch (_e) {
        return false
      }
    }

    /**
     * The rendered text of every alert-like container (ALERT_SELECTORS, document + open shadow
     * roots) that is neither inside a chat message nor wrapping the thread/composer. Replaces the
     * whole-body scan: chat content never counts as a banner, and no layout is forced on the body.
     */
    function alertTexts(composerEl) {
      const roots = shadowRoots()
      const seen = new Set()
      const out = []
      for (const selector of ALERT_SELECTORS) {
        for (const el of deepQuerySelectorAll(document, selector, roots)) {
          if (seen.has(el)) continue
          seen.add(el)
          if (insideMessage(el) || wrapsChat(el, composerEl)) continue
          const t = readText(el)
          if (t !== '') out.push(t)
        }
      }
      return out
    }

    function includesAny(haystack, needles, { ci = false } = {}) {
      if (!Array.isArray(needles) || !haystack) return false
      const h = ci ? haystack.toLowerCase() : haystack
      return needles.some((n) => typeof n === 'string' && n !== '' && h.includes(ci ? n.toLowerCase() : n))
    }

    /**
     * The first configured `errorText` phrase found (case-insensitively) in an alert-like container
     * outside the chat — returned VERBATIM FROM THE CONFIG, never the banner's text, so an error
     * message built from it carries no page content. Null when nothing matches.
     */
    function matchedErrorPhrase(composerEl) {
      const phrases = nonEmptyCascade(sel.errorText)
      if (phrases.length === 0) return null
      for (const text of alertTexts(composerEl)) {
        const h = text.toLowerCase()
        const hit = phrases.find((p) => h.includes(p.toLowerCase()))
        if (hit) return hit
      }
      return null
    }

    /** A rendered match first (a hidden or collapsed editor earlier in the DOM never wins), else any match (presence during mount). */
    function findComposer() {
      return findFirst(sel.composer, { visible: true }) || findFirst(sel.composer)
    }

    function findSend() {
      return findFirst(sel.send)
    }

    /** The send button the adapter would click: visible, clickable and enabled, document + open shadow roots. */
    function findSendButton() {
      return findFirst(sel.send, { clickable: true, enabled: true })
    }

    function hasStopCascade() {
      return Array.isArray(sel.stop) && sel.stop.some((s) => typeof s === 'string' && s !== '')
    }

    /** The stop button the user could press (visible and clickable); null without a stop cascade. */
    function findStop() {
      return hasStopCascade() ? findFirst(sel.stop, { clickable: true }) : null
    }

    /**
     * Contract §4 rules, in order: loggedOutUrl → challengeTitle → challenge → loggedOut → errorText → ok/unknown.
     * Scope: `challengeTitle` counts only as the exact Cloudflare title or when corroborated (no
     * composer, or a `challenge` element); `loggedOut` must be visible and outside a chat message;
     * `errorText` is looked for in alert-like containers only (see ALERT_SELECTORS), never in the
     * thread or the composer — a reply that mentions "rate limit" or links to /login stays `ok`.
     */
    function sessionState() {
      if (includesAny(href(), sel.loggedOutUrl)) return 'logged_out'
      const composer = findComposer()
      const t = title()
      const challengeEl = anyMatch(sel.challenge)
      if (includesAny(t, sel.challengeTitle) && (challengeEl || !composer || CLOUDFLARE_CHALLENGE_TITLES.includes(t.trim()))) return 'challenge'
      if (challengeEl) return 'challenge'
      if (findFirst(sel.loggedOut, { visible: true, accept: (el) => !insideMessage(el) })) return 'logged_out'
      if (matchedErrorPhrase(composer ? composer.el : null) !== null) return 'blocked'
      return composer ? 'ok' : 'unknown'
    }

    /** Health (contract §1): `reply` = an assistant container exists (v2 `assistant` cascade + ASSISTANT_SELECTORS); `stop` = a visible stop button, null only without a stop cascade. One sample: one shadow-root walk. */
    function health() {
      return sampled(() => {
        const composer = findComposer()
        const send = findSend()
        const stop = hasStopCascade() ? findStop() : null
        const reply = findFirst(assistantCascade().concat(ASSISTANT_SELECTORS))
        return {
          composer: composer !== null,
          send: send !== null,
          reply: reply !== null,
          stop: hasStopCascade() ? stop !== null : null,
          session: sessionState(),
          matched: {
            composer: composer ? composer.selector : null,
            send: send ? send.selector : null,
            reply: reply ? reply.selector : null,
            stop: stop ? stop.selector : null,
            error: null,
          },
          url: href(),
          host: host(),
          title: title(),
          ts: Math.round(clock()),
        }
      })
    }

    function countDistinct(cascades) {
      const seen = new Set()
      const roots = shadowRoots()
      for (const selector of cascades) {
        if (typeof selector !== 'string' || selector === '') continue
        for (const el of deepQuerySelectorAll(document, selector, roots)) seen.add(el)
      }
      return seen.size
    }

    const assistantCascade = () => (Array.isArray(sel.assistant) ? sel.assistant : [])

    /** See MESSAGE_SELECTORS: every rendered message, user and assistant (+ a v2 `assistant` cascade) — the submit-confirmation signal. */
    function countMessages() {
      return countDistinct(assistantCascade().concat(MESSAGE_SELECTORS))
    }

    /** See ASSISTANT_SELECTORS: assistant turns only (+ a v2 `assistant` cascade) — the `assistantCount` reported to main. */
    function countAssistant() {
      return countDistinct(assistantCascade().concat(ASSISTANT_SELECTORS))
    }

    /** Document-order comparator over compareDocumentPosition; 0 without the API (fakes keep insertion order). */
    function docOrder(a, b) {
      try {
        if (a === b || typeof a.compareDocumentPosition !== 'function') return 0
        const p = a.compareDocumentPosition(b)
        if (p & 4) return -1 // b follows a
        if (p & 2) return 1 // b precedes a
      } catch (_e) {
        /* fall through */
      }
      return 0
    }

    /** Every assistant container (the same set `countAssistant()` counts), de-duplicated, in document order. */
    function assistantContainers() {
      const seen = new Set()
      const out = []
      const roots = shadowRoots()
      for (const selector of assistantCascade().concat(ASSISTANT_SELECTORS)) {
        if (typeof selector !== 'string' || selector === '') continue
        for (const el of deepQuerySelectorAll(document, selector, roots)) {
          if (seen.has(el)) continue
          seen.add(el)
          out.push(el)
        }
      }
      return out.length > 1 ? out.sort(docOrder) : out
    }

    /** `el` is `container` itself, inside it, or later in document order — an older turn's marker never counts. */
    function onOrAfter(container, el) {
      if (container === el) return true
      try {
        if (typeof container.contains === 'function' && container.contains(el)) return true
        if (typeof container.compareDocumentPosition === 'function') return (container.compareDocumentPosition(el) & 4) !== 0
      } catch (_e) {
        /* fall through */
      }
      return false
    }

    /** `el` is inside a `pre` or `code` element that is under `container` — a code block's own chrome. */
    function insideCodeBlock(container, el) {
      let node = el
      for (let hops = 0; hops < MAX_ANCESTOR_HOPS; hops += 1) {
        if (!node || node === container) return false
        const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
        if (tag === 'pre' || tag === 'code') return true
        let next = null
        try {
          next = node.parentNode || node.host || null // a shadow root has no parentNode; it has a host
        } catch (_e) {
          return false
        }
        if (!next || next === node) return false
        node = next
      }
      return false
    }

    /**
     * `el` is inside the rendered MESSAGE rather than the turn's chrome: inside one of the
     * container's `assistantText` body blocks, or inside a `pre`/`code` under it.
     *
     * WHY (S9, measured live on 2026-09-18): a real Analyze degraded with `parse_error` on two
     * captures that were FRAGMENTS of a reply still being typed — "```JSON\n{\n```" (13 characters)
     * and `{"agre` (6). Since the analyst prompt asks a web session for a ```json fence, chatgpt
     * opens a code block at the FIRST character of the answer — and it renders a copy control on
     * that block as soon as it opens, inside the `pre`. `findDone` accepted it (`onOrAfter` counts a
     * descendant of the container) and the capture ended on one character of JSON. A
     * turn-completion marker is chrome and chrome is never inside the message body: chatgpt's action
     * bar is a SIBLING of `.markdown` inside the assistant article (test/fixtures/dom/chatgpt-done.html),
     * claude's `action-bar-copy` sits outside `.prose` and grok's copy controls outside
     * `.response-content-markdown`. When the `assistantText` cascade matches nothing the body is not
     * a distinguishable subtree, so only the `pre`/`code` rule applies — a container with no body
     * element (chatgpt's placeholder turn) keeps behaving exactly as before.
     */
    function insideReplyBody(container, el, blocks) {
      if (!el || el === container) return false
      if (insideCodeBlock(container, el)) return true
      for (const block of blocks || replyBlocks(container)) if (block === el || containsDeep(block, el)) return true
      return false
    }

    /**
     * A visible, clickable `done` match on or after `container` and OUTSIDE its reply body (the "done
     * selector on the last container"); null without a done cascade. See `insideReplyBody` for the
     * body rule and why a code block's copy control is not a done marker.
     */
    function findDone(container) {
      const cascade = nonEmptyCascade(sel.done)
      if (cascade.length === 0) return null
      const blocks = replyBlocks(container)
      return findFirst(cascade, { clickable: true, accept: (el) => onOrAfter(container, el) && !insideReplyBody(container, el, blocks) })
    }

    /**
     * One block's text: its rendered MARKDOWN (Stage 3 `toMarkdown` — fenced code with its
     * language, headings, nested lists, GFM tables, links as their text, copy chrome stripped),
     * falling back to the rendered text (innerText, else textContent) whenever the markdown render
     * is blank — a container the walk cannot read (no `childNodes`: a shadow host, a fake) still
     * captures its text.
     */
    function blockText(el) {
      const md = toMarkdown(el, { window: win })
      return isBlank(md) ? readText(el) : md
    }

    /**
     * A container's reply text: EVERY match of the first `assistantText` entry that matches, in
     * document order (a match nested in another is skipped — `containsDeep`, so a shadow-root
     * descendant of another match never has its text captured twice), joined by a blank line — a
     * turn rendered as several blocks (a summary before the answer, text around a tool block) is
     * captured whole, not truncated to its first block; without a match the container itself.
     * The markdown container is preferred (that is what the `assistantText` cascade points at) and
     * innerText is the fallback — see `blockText`. That fallback is why a site whose cascade matches
     * nothing still captures its reply: it can never be the reason an answer goes missing, only the
     * reason the turn's chrome rides along (the S8 note in this file's header: claude's doubled
     * thinking summary, which is why `claude.assistantText` stopped being empty).
     */
    function replyText(container) {
      const blocks = replyBlocks(container)
      return blocks.length > 0 ? blocks.map(blockText).join('\n\n') : blockText(container)
    }

    /**
     * The reply BODY blocks of `container`: every match of the first `assistantText` entry that
     * matches, in document order, a match nested in another dropped (`containsDeep`) — exactly the
     * set `replyText` reads. `[]` when no entry matches: the text then comes from the container
     * itself and the body is not a distinguishable subtree (see `insideReplyBody`).
     */
    function replyBlocks(container) {
      for (const selector of nonEmptyCascade(sel.assistantText)) {
        const hits = deepQuerySelectorAll(container, selector)
        if (hits.length === 0) continue
        return hits.filter((el) => !hits.some((other) => other !== el && containsDeep(other, el)))
      }
      return []
    }

    function cascadeText(cascade) {
      return Array.isArray(cascade) ? cascade.join(', ') : String(cascade)
    }

    function stateError(state) {
      const why = {
        logged_out: 'the site shows its login wall',
        challenge: 'the site is showing a browser challenge',
        blocked: 'the site reports unusual activity or an error banner',
      }
      return new AdapterError(state, `${state}: ${why[state] || 'session is not ok'}`)
    }

    /** A wall / challenge / banner that appeared meanwhile is the reason, not "no composer": throw it. */
    function throwIfRejected() {
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
    }

    /** Wait for the composer to exist (every 150 ms up to `timeoutMs`, default `composerWaitMs`). */
    async function waitForComposer(timeoutMs, { signal } = {}) {
      const ms = nonNegativeInt(timeoutMs, nonNegativeInt(sel.composerWaitMs, 15000))
      const found = await poll(() => findComposer(), { intervalMs: SEND_POLL_MS, timeoutMs: ms, signal })
      if (!found) {
        throwIfRejected()
        throw new AdapterError('composer_not_found', `no composer within ${ms} ms (tried: ${cascadeText(sel.composer)})`)
      }
      return found
    }

    /**
     * Session gate shared by ready/insertAndSubmit: a wall/challenge/error state rejects at once
     * (no DOM write); `unknown` (page still loading) waits for the composer, then re-checks.
     */
    async function requireSessionOk({ timeoutMs, signal } = {}) {
      const first = sessionState()
      if (REJECT_STATES.includes(first)) throw stateError(first)
      const found = await waitForComposer(timeoutMs, { signal })
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
      if (state !== 'ok') throw new AdapterError('composer_not_found', 'the composer disappeared while checking the session')
      return found
    }

    // ---- insertion --------------------------------------------------------------------------

    function focusEl(el) {
      try {
        if (typeof el.focus === 'function') el.focus()
      } catch (_e) {
        /* focus is best effort */
      }
    }

    function ctor(name) {
      const C = (win && win[name]) || globalThis[name]
      return typeof C === 'function' ? C : null
    }

    function makeEvent(name, fallbackName, type, init) {
      const C = ctor(name)
      if (C) {
        try {
          return new C(type, init)
        } catch (_e) {
          /* fall through to the plain event */
        }
      }
      const F = fallbackName ? ctor(fallbackName) : null
      return F ? new F(type, init) : null
    }

    function dispatch(el, ev) {
      if (!ev) return false
      try {
        el.dispatchEvent(ev)
        return true
      } catch (_e) {
        return false
      }
    }

    function inputEvent(text) {
      return makeEvent('InputEvent', 'Event', 'input', { bubbles: true, cancelable: false, composed: true, inputType: 'insertText', data: text })
    }

    /** contenteditable: focus, explicit Range collapsed at the end, execCommand('insertText'), then InputEvent('input'). */
    function insertViaExecCommand(el, text) {
      const doc = el.ownerDocument || document
      const view = doc.defaultView || win
      focusEl(el)
      const range = doc.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const selection = view && typeof view.getSelection === 'function' ? view.getSelection() : doc.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const ok = doc.execCommand('insertText', false, text) === true
      dispatch(el, inputEvent(text))
      return ok
    }

    /** contenteditable fallback: a synthetic paste carrying a DataTransfer with text/plain. */
    function insertViaPaste(el, text) {
      const DT = ctor('DataTransfer')
      if (!DT) return false
      const dt = new DT()
      dt.setData('text/plain', text)
      focusEl(el)
      const ev = makeEvent('ClipboardEvent', null, 'paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt })
      return dispatch(el, ev)
    }

    /** <textarea>/<input>: the native prototype value setter (bypasses React's instance tracker) + input. */
    function insertViaNativeValue(el, text) {
      const proto = ctor(tagOf(el) === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement')
      const desc = proto && proto.prototype ? Object.getOwnPropertyDescriptor(proto.prototype, 'value') : null
      focusEl(el)
      const next = readText(el) + text
      if (desc && typeof desc.set === 'function') desc.set.call(el, next)
      else el.value = next
      dispatch(el, inputEvent(text))
      return true
    }

    /**
     * Insert `text` at the end of the composer with the verified cascade (contract §3):
     * contenteditable → execCommand, else synthetic paste; text field → native value setter.
     * Idempotent: a composer that already holds exactly `text` (the leftover of a failed attempt —
     * nothing is ever cleared) is left alone and reported `already_present`, so a retry never
     * submits the prompt doubled. Otherwise each attempt is verified after INSERT_SETTLE_MS: the
     * composer must now hold the previous text followed by `text` (whitespace-insensitive — strictly
     * stronger than the §3 tail-20 rule, which it implies), so a no-op insertion is a failed attempt
     * and falls through to the next method, and finally to `site_error`.
     */
    async function insertText(text, { signal } = {}) {
      if (typeof text !== 'string') throw new AdapterError('site_error', 'insertText: text must be a string')
      const found = findComposer()
      if (!found) throw new AdapterError('composer_not_found', `no composer (tried: ${cascadeText(sel.composer)})`)
      const el = found.el
      const before = squash(readText(el))
      if (before === squash(text)) return { method: 'already_present' }
      const expected = before + squash(text)
      const attempts = []
      const attempt = async (method, fn) => {
        let ran = false
        let threw = null
        try {
          ran = fn() === true
        } catch (e) {
          threw = String((e && e.message) || e)
        }
        await sleep(INSERT_SETTLE_MS)
        throwIfAborted(signal)
        const current = findComposer()
        if (squash(readText(current ? current.el : el)) === expected) return true
        attempts.push(`${method}: ${threw ? `threw ${threw}` : ran ? 'ran' : 'did not run'}; the composer text is not the previous text followed by the inserted text`)
        return false
      }
      if (isTextField(el)) {
        if (await attempt('nativeValue', () => insertViaNativeValue(el, text))) return { method: 'nativeValue' }
      } else {
        if (await attempt('execCommand', () => insertViaExecCommand(el, text))) return { method: 'execCommand' }
        if (await attempt('paste', () => insertViaPaste(el, text))) return { method: 'paste' }
      }
      throw new AdapterError('site_error', `insertText: ${attempts.join('; ')}`)
    }

    // ---- submission -------------------------------------------------------------------------

    function clickEl(el) {
      try {
        if (typeof el.click === 'function') {
          el.click()
          return true
        }
      } catch (_e) {
        /* fall through */
      }
      return dispatch(el, makeEvent('MouseEvent', 'Event', 'click', { bubbles: true, cancelable: true, composed: true }))
    }

    /** One Enter: keydown / keypress / keyup, composed:true, on the composer. */
    function pressEnter(el) {
      focusEl(el)
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const init = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: type === 'keypress' ? 13 : 0,
          bubbles: true,
          cancelable: true,
          composed: true,
        }
        dispatch(el, makeEvent('KeyboardEvent', 'Event', type, init))
      }
    }

    /**
     * stop button | composer emptied | countMessages() grew, polled every 100 ms up to `verifyMs`.
     * The third signal keeps its contract name `assistant_count` (§2 `confirmedBy`) although it is
     * the message count (user turns included) that grows when a submission lands.
     */
    function confirmSubmission(verifyMs, baseline, signal) {
      return poll(
        () =>
          sampled(() => {
            if (findStop()) return 'stop_button'
            const c = findComposer()
            if (c && isBlank(readText(c.el))) return 'composer_cleared'
            if (countMessages() > baseline) return 'assistant_count'
            return null
          }),
        { intervalMs: CONFIRM_POLL_MS, timeoutMs: verifyMs, signal },
      )
    }

    /**
     * Submit what is in the composer (contract §3): poll the send cascade every 150 ms up to
     * `timeoutMs` (default `sendWaitMs`) for a visible, enabled button, click it and confirm within
     * `submitVerifyMs`; else one Enter on the composer and confirm again. The confirmation baseline
     * is the `countMessages()` sample taken immediately before each action.
     *
     * `assistantCount` — the observe baseline main sends back (contract §2/§3) — is the
     * `countAssistant()` sample taken ONCE, before the FIRST submit attempt, and it is never RAISED
     * afterwards: chatgpt.com mounts a short placeholder assistant turn about a second after the
     * submit (measured 2026-09-17), i.e. INSIDE `submitVerifyMs`, so re-sampling for the Enter
     * fallback after the click's confirmation window would count that placeholder, hand main a
     * baseline of N+1 and — because the placeholder is unmounted again and the real reply remounts at
     * the same count — make the capture answer `reply_not_found` with the answer on screen. A second
     * sample can only LOWER the baseline (a container unmounted while the first attempt was being
     * confirmed must not keep the baseline high either), never lift it.
     */
    async function submit(timeoutMs, { signal } = {}) {
      const waitMs = nonNegativeInt(timeoutMs, nonNegativeInt(sel.sendWaitMs, 18000))
      const verifyMs = nonNegativeInt(sel.submitVerifyMs, 5000)
      const button = await poll(() => findSendButton(), { intervalMs: SEND_POLL_MS, timeoutMs: waitMs, signal })
      let assistantCount = countAssistant() // before ANY submit attempt: nothing this turn mounted can be in it
      if (button) {
        const baseline = countMessages()
        clickEl(button.el)
        const confirmedBy = await confirmSubmission(verifyMs, baseline, signal)
        if (confirmedBy) return { method: 'click', sendSelector: button.selector, confirmedBy, assistantCount }
      }
      const composer = findComposer()
      if (composer) {
        assistantCount = Math.min(assistantCount, countAssistant()) // only ever lower, never raise
        const baseline = countMessages()
        pressEnter(composer.el)
        const confirmedBy = await confirmSubmission(verifyMs, baseline, signal)
        if (confirmedBy) return { method: 'enter', sendSelector: button ? button.selector : null, confirmedBy, assistantCount }
      }
      if (!button) {
        throw new AdapterError('send_not_found', `no visible, enabled send button within ${waitMs} ms (tried: ${cascadeText(sel.send)}); Enter did not submit either`)
      }
      throw new AdapterError('not_submitted', `clicked ${button.selector} and pressed Enter, but no stop button, emptied composer or new message confirmed the submission within ${verifyMs} ms`)
    }

    /** ready op (contract §2): session ok, composer present and no stop button, within `timeoutMs`. */
    async function ready(timeoutMs, { signal } = {}) {
      const ms = nonNegativeInt(timeoutMs, nonNegativeInt(sel.composerWaitMs, 15000))
      const first = sessionState()
      if (REJECT_STATES.includes(first)) throw stateError(first)
      const t0 = clock()
      const found = await poll(
        () =>
          sampled(() => {
            const c = findComposer()
            return c && !findStop() ? c : null
          }),
        { intervalMs: SEND_POLL_MS, timeoutMs: ms, signal },
      )
      if (!found) {
        throwIfRejected()
        if (findComposer()) throw new AdapterError('timeout', `the stop button is still visible after ${Math.round(clock() - t0)} ms (the site is still replying)`)
        throw new AdapterError('composer_not_found', `no composer within ${ms} ms (tried: ${cascadeText(sel.composer)})`)
      }
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
      if (state !== 'ok') throw new AdapterError('composer_not_found', 'the composer disappeared while checking the session')
      return found
    }

    /** insertAndSubmit op (contract §2/§3): session gate → insertText → submit; `ms` is the whole op. */
    async function insertAndSubmit(text, { signal } = {}) {
      const t0 = clock()
      if (typeof text !== 'string' || text === '') throw new AdapterError('site_error', 'insertAndSubmit: text must be a non-empty string')
      const composer = await requireSessionOk({ signal })
      await insertText(text, { signal })
      const s = await submit(undefined, { signal })
      return {
        submitted: true,
        composerSelector: composer.selector,
        sendSelector: s.sendSelector,
        assistantCount: s.assistantCount,
        confirmedBy: s.confirmedBy,
        ms: Math.round(clock() - t0),
      }
    }

    // ---- capture (Stage 2) ------------------------------------------------------------------

    /**
     * observe op (contract §2/§3): wait for a NEW assistant container — one that was not on the page
     * when this observe started, or (fallback) one beyond `baselineCount`, the `assistantCount` main
     * took from insertAndSubmit — then follow it until the reply is done and resolve `{text, doneBy,
     * ms}` with its final text — one text, at the end (streaming re-renders are non-monotonic;
     * Decision 16).
     *
     *   which node    the containers present at observe start are snapshotted by NODE IDENTITY; the
     *                 reply is the LAST container that is not in that snapshot, and `length > baseline`
     *                 picks the last container only until one has been followed (main's baseline is
     *                 sampled before the submit, so the reply — or chatgpt's placeholder turn — may
     *                 already be mounted when the observe arrives). Once a container has been followed
     *                 only a node that mounted after this observe started replaces it, so an EARLIER
     *                 turn's container is never reported as this turn's reply: a stale (under-sampled)
     *                 baseline would otherwise hand back the PREVIOUS answer, done marker and all,
     *                 while this turn's reply is between two renders
     *   first token   a container beyond the baseline within `firstTokenMs` (capped by the budget),
     *                 else `reply_not_found` — the deadline applies only until a container has been
     *                 seen ONCE: a container that is unmounted again (chatgpt's placeholder turn,
     *                 measured 2026-09-17) is dropped and the gap counts as "still replying"
     *   done          `done_selector`  a visible, clickable `done` match on or after the last container
     *                                  and outside its reply body (`insideReplyBody`: a code block's
     *                                  own copy control is not a turn marker) while NO stop button is
     *                                  visible (the site's "still replying" signal wins over a
     *                                  finished tool turn's action bar)
     *                 `stop_gone`      a stop button was seen during this observe and is gone now
     *                 `quiet`          the text is non-blank and unchanged for `quietMs` while no stop
     *                                  button is visible (the only signal when stop + done are empty)
     *                 an end signal (done selector, stop gone, quiet) is never resolved on the sample
     *                 that saw it and never latched: every sample re-reads the stop button and a
     *                 visible one withdraws the signal, and the capture resolves once the text has not
     *                 moved for SETTLE_MS with the signal still standing — the final markdown render may
     *                 land a frame after the marker, and a sample that merely MISSED the stop button
     *                 must not end a reply that is still arriving; past the budget the latest text is
     *                 returned with that doneBy rather than `timeout`
     *   budget        `timeoutMs` (default `captureTimeoutMs`) elapsed → `timeout` with the partial text,
     *                 a gap with no container at all included (a site that unmounts its reply and never
     *                 remounts it times out; it never waits past the budget)
     *   session       a banner → `site_error` whose message is ONLY the configured phrase that matched;
     *                 a wall / challenge → `logged_out` / `challenge`; `cancelled` on abort — each with
     *                 the partial text when it is non-blank; re-checked on the poll samples only
     *   cadence       a MutationObserver throttled to OBSERVE_THROTTLE_MS plus an OBSERVE_POLL_MS poll
     *                 (the poll alone where MutationObserver does not exist); the observer watches the
     *                 document until the reply container is known, then only the reply's parent (the
     *                 thread); every sample walks the open shadow roots at most once
     *   text          the last container's `assistantText` matches (first entry that matches, every
     *                 block joined by a blank line), else the container itself, as rendered text;
     *                 CRLF → LF and NBSP → space, never trimmed
     * `quietMs` / `timeoutMs` / `firstTokenMs` in the message override the selectors; a missing
     * `baselineCount` means the current count.
     */
    function observe({ baselineCount, quietMs, timeoutMs, firstTokenMs, settleMs, expect, signal } = {}) {
      const t0 = clock()
      const given = nonNegativeInt(baselineCount, null)
      let known = null // the containers of EARLIER turns, by node identity; filled by the FIRST sample (same tick as this call, so it shares its one shadow-root walk)
      let baseline = given // null until that first sample counts the page itself (walked only when main sent no count)
      const quiet = nonNegativeInt(quietMs, nonNegativeInt(sel.quietMs, 2500))
      const budget = nonNegativeInt(timeoutMs, nonNegativeInt(sel.captureTimeoutMs, 300000))
      const firstToken = Math.min(nonNegativeInt(firstTokenMs, nonNegativeInt(sel.firstTokenMs, 90000)), budget)
      const SETTLE = Symbol('settle') // the end was seen; take one more sample before resolving
      const REREAD = Symbol('reread') // the budget is spent on an incomplete answer: one last look at the page first
      // How long the text must hold still after an end signal. Four throttle ticks, not one (S9): a
      // single 100 ms lull between two token batches is ordinary mid-stream, and resolving inside one
      // is how a capture ends on a fragment. It costs one settle window at the end of a capture that
      // takes seconds, and the budget still overrides it. Per site since S10 (`settleMs`: chatgpt holds
      // the text far longer between two renders of a long answer), and the message overrides the site.
      const settleWindow = nonNegativeInt(settleMs, nonNegativeInt(sel.settleMs, 4 * OBSERVE_THROTTLE_MS))
      // How long an answer that never takes the expected SHAPE is waited on after the site says it has
      // finished. Without this the JSON gate below holds the capture to the whole `captureTimeoutMs`
      // (five minutes) whenever a model answers a JSON request in prose — a refusal, an apology, a
      // question back — so the loud failure would arrive ten minutes late. Once the site has signalled
      // the end and the text has not moved for this long, the answer is as complete as it will get.
      const incompleteGrace = nonNegativeInt(sel.incompleteGraceMs, 20000)
      // What KIND of answer this turn is waiting for (S10): `json` refuses to resolve an end signal on a
      // document whose braces do not balance. Main sends it for the analyst page, whose reply is always a
      // JSON document; a pane send sends nothing and nothing changes for it.
      const expectKind = typeof expect === 'string' ? expect : null
      let container = null
      let text = ''
      let lastText = null
      let lastChangeAt = t0
      let lastSampleAt = t0 // the previous sample's clock: the gap between two samples is what a container gap freezes
      let seenStop = false
      let seenContainer = false // a container has been followed at least once: a later gap is a re-render, not a missing reply, and the count rule is retired
      let endSeen = null // 'done_selector' | 'stop_gone' | 'quiet' once the site signalled the end
      let endSeenAt = 0
      let rereadTaken = false // the one final re-sample an incomplete expected answer takes at its budget
      const partial = () => (isBlank(text) ? undefined : text)
      /** The LAST container (document order) that was not already on the page when this observe started; null when every one of them was. */
      const lastFresh = (containers) => {
        for (let i = containers.length - 1; i >= 0; i -= 1) if (!known.has(containers[i])) return containers[i]
        return null
      }

      /** The session gate: a banner → site_error carrying ONLY the configured phrase; a wall / challenge → that state; each with the partial. */
      const sessionGate = () => {
        const state = sessionState()
        if (state === 'blocked') {
          const composer = findComposer()
          throw new AdapterError('site_error', matchedErrorPhrase(composer ? composer.el : null) || 'blocked', partial())
        }
        if (state === 'logged_out' || state === 'challenge') throw new AdapterError(state, stateError(state).message, partial())
      }

      /**
       * One sample, sharing a single shadow-root walk. `full` (the initial run and the poll) also
       * re-checks the session; a mutation tick only reads the thread — unless it is about to give
       * a terminal answer, which never bypasses the session gate (a reply frozen by a banner is
       * `site_error`, not `stop_gone`). Throws the terminal AdapterError, returns the doneBy string,
       * SETTLE (the end was seen but the text must hold still for one more sample), or null.
       */
      const check = (full) =>
        sampled(() => {
          const now = clock()
          const sinceLast = Math.max(0, now - lastSampleAt) // how long the page went unread before this sample
          lastSampleAt = now
          if (signal && signal.aborted) throw new AdapterError('cancelled', 'cancelled by main', partial())
          if (full) sessionGate()
          const containers = assistantContainers()
          if (known === null) {
            // The first sample runs in the same tick as observe(): every container on the page now
            // belongs to an EARLIER turn, and nothing this turn mounts can be in the snapshot.
            known = new Set(containers)
            if (baseline === null) baseline = known.size
          }
          // NODE IDENTITY first, the count only until a container has been followed once: the last
          // container that was NOT on the page when this observe started is this turn's reply (the
          // two-turn / tool-call dance mounts both fresh and the last of them is the answer; the
          // measured chatgpt remount mounts a placeholder and then a DIFFERENT real node, and neither
          // is in `known`). The count rule stays as the way IN because main's baseline is sampled
          // before the submit and the reply — or the placeholder — can already be on the page when the
          // observe message arrives, in which case it is in `known` and only `length > baseline` can
          // point at it. It is retired once a container has been followed: from then on only a node
          // that mounted after this observe started may replace it, so a stale (under-sampled)
          // baseline can never make an EARLIER turn's container — text, done marker and all — the
          // answer while this turn's reply is between two renders.
          const fresh = lastFresh(containers)
          const before = container
          if (fresh) {
            container = fresh
            seenContainer = true
          } else if (!seenContainer && containers.length > baseline) {
            container = containers[containers.length - 1]
            seenContainer = true
          }
          else if (container && container.isConnected === false) container = null
          // A NEW node is a NEW reply body (S10): a site that re-renders its turn into a different
          // element must not hand the replacement the stillness the node it replaced had accumulated.
          // The two texts are usually IDENTICAL at the swap (the same prefix, re-rendered), so without
          // this the sample after a swap can see "unchanged for quietMs" and end the capture on the
          // prefix — the stale clock belongs to a node that is no longer on the page.
          if (container !== null && before !== null && container !== before) {
            lastText = null
            endSeen = null
            endSeenAt = 0
            lastChangeAt = now
          }
          // Measured on chatgpt.com (2026-09-17): the site mounts a short placeholder turn, then
          // UNMOUNTS the whole container for ~10 s before remounting the real reply. Holding the
          // detached node freezes the text at the placeholder and makes `findDone` unmatchable
          // (it is no longer in the document), so the capture could only ever end by timeout.
          // Dropping it means the gap is simply "still streaming": once a container has been seen
          // the first-token deadline no longer applies, only the overall budget.
          if (!container) {
            // Freeze the stillness clocks for as long as the DOM is missing (S10). They measure "the
            // reply has not moved", and a reply whose container is not on the page has not been READ —
            // letting a pending end signal or a quiet window mature across the measured ~10 s chatgpt
            // gap is how a capture ends on the FIRST render after the gap, which is one character.
            lastChangeAt += sinceLast
            if (endSeen !== null) endSeenAt += sinceLast
            // …and the stop button is still sampled with no container to read: it is the site saying it
            // is still replying, and it must be able to WITHDRAW a pending signal during the gap too
            // (measured on chatgpt.com 2026-09-17: the button stays visible across the whole gap, so
            // the one guard that could have stopped this capture was blind exactly where it was needed).
            if (findStop()) {
              seenStop = true
              lastChangeAt = now
              endSeen = null
            }
            if (!seenContainer && now - t0 >= firstToken) {
              throw new AdapterError(
                'reply_not_found',
                `no assistant container beyond ${baseline} within ${firstToken} ms (tried: ${cascadeText(assistantCascade().concat(ASSISTANT_SELECTORS))})`,
              )
            }
            // The gap IS bounded by the overall budget: a site that unmounts its reply and never
            // brings it back answers `timeout` with whatever text was last on the page, exactly as a
            // reply that never finishes does — it must never sit here until main's own deadline.
            if (now - t0 >= budget) {
              if (!full) sessionGate() // a terminal answer never bypasses the session check
              throw new AdapterError('timeout', `the reply was still in progress after ${budget} ms`, text)
            }
            return null
          }
          text = normalizeText(replyText(container))
          const changed = text !== lastText
          if (changed) {
            lastText = text
            lastChangeAt = now
          }
          let result = null
          const stop = findStop()
          if (stop) {
            seenStop = true
            lastChangeAt = now // the site says it is still replying: never quiet, and a marker does not count yet
            // …and it WITHDRAWS a pending end signal (S9): an end signal is one sample's reading of
            // the DOM, and a sample can miss a button that is re-rendering, animating in, or one
            // frame behind — after which `done_selector` / `stop_gone` used to be latched forever and
            // the capture resolved on the next lull, mid-reply. The site's own "still replying"
            // signal outranks a marker before the signal, so it outranks it afterwards too. It
            // re-fires by itself on the next sample once the button is really gone, and the capture
            // stays bounded by the budget exactly as a stop button that never disappears always was.
            endSeen = null
          } else if (endSeen === null && !isBlank(text)) {
            // EVERY end signal needs text (S10 — `quiet` always had the guard, the other two did not):
            // a marker or a vanished stop button over a blank body means the reply has not STARTED, and
            // ending there hands main a zero-character answer under `ok`. Keep waiting to the budget
            // instead; `reply_not_found` and `timeout` then apply exactly as they always did.
            if (findDone(container)) {
              endSeen = 'done_selector'
            } else if (seenStop) {
              endSeen = 'stop_gone'
            } else if (now - lastChangeAt >= quiet) {
              // quiet goes through the same settle/withdraw machinery as the other two (S9): it is
              // also a reading of one sample, and a stop button that appears in the settle window
              // must be able to take it back. Its own stillness requirement is already met, so this
              // costs one settle window and nothing else.
              endSeen = 'quiet'
            }
            if (endSeen !== null) endSeenAt = now
          }
          if (endSeen !== null) {
            // settling: resolve once a settle window has passed since the end signal AND since the last
            // text change (two samples a few ms apart never count as "held still"), or the budget is spent
            const still = now - endSeenAt >= settleWindow && now - lastChangeAt >= settleWindow
            // …and, when the caller said what kind of answer this is, once the answer actually has that
            // shape (S10): an end signal over half a JSON document resolves nothing, it just keeps
            // sampling. The budget always wins in the end, so a reply that is genuinely prose — or one
            // the model abandoned mid-document — can never hang here; it comes back with its own doneBy,
            // after ONE final re-read, because the last render often lands after the sample that gave up.
            const complete = looksComplete(text, expectKind)
            const gaveUp = now - t0 >= budget || (still && now - lastChangeAt >= incompleteGrace)
            if (still && complete) result = endSeen
            else if (gaveUp) {
              if (complete) result = endSeen
              else if (!rereadTaken) {
                // One last look: the final render often lands after the sample that gave up.
                rereadTaken = true
                result = REREAD
              } else {
                // The answer never took the shape the caller asked for. Returning it as a finished
                // reply is the whole defect this release is about (S10, measured 2026-09-20: a
                // 13-character fragment came back `ok` and Analyze compared it), so this FAILS, and
                // the partial travels with it for the degraded report to quote.
                if (!full) sessionGate()
                throw new AdapterError('timeout', `the reply never became a complete ${expectKind} document (${text.length} characters after ${Math.round(now - t0)} ms)`, text)
              }
            } else result = SETTLE
          }
          const spent = result === null && now - t0 >= budget
          if (!full && (typeof result === 'string' || spent)) sessionGate() // a terminal answer never bypasses the session check
          if (spent) {
            // Say WHICH of the two shapes this is. A capture that followed a container for the whole
            // budget and never read a character of it is not "still in progress" in any useful sense
            // — measured 2026-09-20, a condense call came back `timeout … chars=0` while the answer
            // was sitting in that chat, and the generic message said nothing about which.
            if (seenContainer && isBlank(text)) {
              throw new AdapterError(
                'reply_not_found',
                `a reply container was there for ${budget} ms but never held any text (the site may still be thinking)`,
              )
            }
            throw new AdapterError('timeout', `the reply was still in progress after ${budget} ms`, text)
          }
          return result
        })

      return new Promise((resolve, reject) => {
        let settled = false
        let throttle = null
        let pollTimer = null
        let mo = null
        let observed = null // what the MutationObserver watches: the document, then the reply's parent
        const onAbort = () => settle(() => reject(new AdapterError('cancelled', 'cancelled by main', partial())))
        const cleanup = () => {
          if (mo) {
            try {
              mo.disconnect()
            } catch (_e) {
              /* ignore */
            }
            mo = null
          }
          if (throttle !== null) clearT(throttle)
          if (pollTimer !== null) clearT(pollTimer)
          throttle = pollTimer = null
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
        }
        function settle(fn) {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        /** Re-point the observer at `target` (the thread once the reply container is known); a failure keeps the poll as the only trigger. */
        const observeTarget = (target) => {
          if (!mo || !target || typeof target !== 'object' || target === observed) return
          try {
            mo.disconnect()
            mo.observe(target, { childList: true, characterData: true, subtree: true, attributes: true })
            observed = target
          } catch (_e) {
            observed = null
          }
        }
        /** The next sample OBSERVE_THROTTLE_MS from now (one at a time; a due mutation sample counts). */
        const scheduleSample = () => {
          if (throttle !== null) return
          throttle = setT(() => {
            throttle = null
            run(false)
          }, OBSERVE_THROTTLE_MS)
        }
        const run = (full) => {
          if (settled) return
          let r = null
          try {
            r = check(full)
          } catch (e) {
            settle(() => reject(e))
            return
          }
          if (r === SETTLE || r === REREAD) scheduleSample()
          else if (r) {
            settle(() => resolve({ text, doneBy: r, ms: Math.round(clock() - t0) }))
            return
          }
          if (container && observed === document) observeTarget(container.parentNode || container)
        }
        const schedulePoll = () => {
          pollTimer = setT(() => {
            pollTimer = null
            run(true)
            if (!settled) schedulePoll()
          }, OBSERVE_POLL_MS)
        }
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort)
        const MO = ctor('MutationObserver')
        if (MO) {
          try {
            mo = new MO(() => {
              if (!settled) scheduleSample()
            })
            mo.observe(document, { childList: true, characterData: true, subtree: true, attributes: true })
            observed = document
          } catch (_e) {
            mo = null
          }
        }
        run(true)
        if (!settled) schedulePoll()
      })
    }

    /** snapshot op (contract §2): the scrubbed DOM — structure and selector-bearing attributes only, every text node `…`. */
    async function snapshot({ signal } = {}) {
      throwIfAborted(signal)
      return { html: scrubDom(document) }
    }

    /** Hot reload (config op): re-merge a full config onto the defaults, or take a bare block; anything else is ignored. */
    function setSelectors(next) {
      const resolved = resolveSelectors(next)
      if (resolved) sel = resolved
    }

    return {
      site: site || null,
      health,
      sessionState,
      findComposer,
      findSendButton,
      waitForComposer,
      insertText,
      submit,
      insertAndSubmit,
      countMessages,
      countAssistant,
      ready,
      url: href,
      setSelectors,
      // ---- Stage 2 --------------------------------------------------------------------------
      observe,
      snapshot,
      assistantContainers,
      replyText,
      replyBlocks,
      findDone, // exposed for the S9 unit tests: the body rule is asserted directly, not only through a capture
    }
  }

  // ---------------------------------------------------------------------------------------------
  // IPC plumbing (contract §2, "Main ↔ site preload")
  // ---------------------------------------------------------------------------------------------

  function healthKey(h) {
    // change detection ignores the timestamp
    const { ts, ...rest } = h
    return JSON.stringify(rest)
  }

  function errorResult(reqId, op, e) {
    const code = e && isResultCode(e.code) ? e.code : 'site_error'
    const res = { reqId, ok: false, op, code, message: String((e && e.message) || e || code) }
    if (e && e.partial !== undefined) res.partial = e.partial
    return res
  }

  /**
   * attachIpc(ipc, factory):
   *   ipc     — `{invoke(channel, payload) → Promise, on(channel, (event, msg) => void), send(channel, payload)}`
   *             (Electron's `ipcRenderer` or the test's `window.__triplexFakeIpc`).
   *   factory — `(config) => adapter` called once with the `adapter:config` reply when `config.site`
   *             is not null; a null site leaves the preload inert (SSO popups, unknown pages).
   * Listens on 'triplex:adapter', answers on 'triplex:adapter:result', and publishes
   * 'triplex:adapter:health' on every change plus a 10 s heartbeat. One op in flight per view:
   * a second ready/insertAndSubmit/observe/snapshot answers `busy`; `cancel{target}` aborts it.
   * Messages that arrive before `adapter:config` settles are parked and replayed in order once
   * an adapter exists (dropped when the preload stays inert), so main never waits its full
   * budget for a request that landed during boot.
   * Returns `{ready: Promise<boolean>, dispose()}` (ready resolves true when an adapter was created).
   */
  function attachIpc(ipc, factory, { setInterval: setI = globalThis.setInterval, clearInterval: clearI = globalThis.clearInterval } = {}) {
    if (!ipc || typeof ipc.invoke !== 'function' || typeof ipc.on !== 'function' || typeof ipc.send !== 'function') {
      throw new Error('attachIpc: ipc must provide invoke/on/send')
    }
    let adapter = null
    let booting = true // adapter:config not answered yet: messages are parked in `backlog`
    const backlog = []
    let inFlight = null // {reqId, op, controller}
    let lastHealthKey = null
    let lastHealthAt = 0
    let timer = null
    let mutationObserver = null
    let mutationTimer = null
    let disposed = false

    const reply = (res) => {
      try {
        ipc.send('triplex:adapter:result', res)
      } catch (_e) {
        /* the channel is gone; nothing to do */
      }
    }

    const publishHealth = (force) => {
      if (!adapter || disposed) return
      let h
      try {
        h = adapter.health()
      } catch (e) {
        return
      }
      const key = healthKey(h)
      const due = h.ts - lastHealthAt >= HEALTH_HEARTBEAT_MS
      if (force || key !== lastHealthKey || due) {
        lastHealthKey = key
        lastHealthAt = h.ts
        try {
          ipc.send('triplex:adapter:health', h)
        } catch (_e) {
          /* ignore */
        }
      }
    }

    const runOp = async (op, msg, signal) => {
      if (op === 'ready') {
        const r = await adapter.ready(msg.timeoutMs, { signal })
        return { composerSelector: r.selector }
      }
      if (op === 'insertAndSubmit') {
        const r = await adapter.insertAndSubmit(msg.text, { signal })
        return { ...r, url: adapter.url() }
      }
      if (op === 'observe') {
        const r = await adapter.observe({ ...msg, signal })
        return { ...r, url: adapter.url() }
      }
      if (op === 'snapshot') return adapter.snapshot({ signal })
      throw new AdapterError('site_error', `unknown op ${String(op)}`)
    }

    const handle = (msg) => {
      if (disposed || !msg || typeof msg !== 'object') return
      if (booting) {
        backlog.push(msg)
        return
      }
      if (!adapter) return
      const op = msg.op
      if (op === 'config') {
        // hot reload (Stage 2): re-merge the selectors, re-run health, no reply
        if (msg.selectors !== undefined) adapter.setSelectors(msg.selectors)
        publishHealth(true)
        return
      }
      const reqId = msg.reqId
      if (typeof reqId !== 'string' || reqId === '') return
      if (op === 'health') {
        let h
        try {
          h = adapter.health()
        } catch (e) {
          reply({ reqId, ok: false, op, code: 'site_error', message: String((e && e.message) || e) })
          return
        }
        reply({ reqId, ok: true, op: 'health', health: h })
        return
      }
      if (op === 'cancel') {
        const cancelled = inFlight !== null && inFlight.reqId === msg.target
        if (cancelled) inFlight.controller.abort() // the op answers `cancelled` itself and frees the slot
        reply({ reqId, ok: true, op: 'cancel', cancelled })
        return
      }
      if (op === 'ready' || op === 'insertAndSubmit' || op === 'observe' || op === 'snapshot') {
        if (inFlight !== null) {
          reply({ reqId, ok: false, op, code: 'busy', message: `op ${inFlight.op} (${inFlight.reqId}) in flight` })
          return
        }
        const controller = makeController()
        inFlight = { reqId, op, controller }
        Promise.resolve()
          .then(() => runOp(op, msg, controller.signal))
          .then(
            (res) => reply({ reqId, ok: true, op, ...res }),
            (e) => reply(errorResult(reqId, op, e)),
          )
          .then(() => {
            if (inFlight !== null && inFlight.reqId === reqId) inFlight = null
            publishHealth(false)
          })
        return
      }
      reply({ reqId, ok: false, op: String(op), code: 'site_error', message: `unknown op ${String(op)}` })
    }

    ipc.on('triplex:adapter', (_event, msg) => handle(msg))

    /** Boot is over: replay the parked messages in order when an adapter exists, drop them otherwise. */
    const settle = (created) => {
      booting = false
      const queued = backlog.splice(0)
      if (created) for (const msg of queued) handle(msg)
      return created
    }

    const ready = Promise.resolve()
      .then(() => ipc.invoke('adapter:config'))
      .then((config) => {
        if (disposed) return false
        if (!config || typeof config !== 'object' || config.site === null || config.site === undefined) return false
        adapter = factory(config)
        if (!adapter) return false
        publishHealth(true)
        timer = setI(() => publishHealth(false), HEALTH_POLL_MS)
        // DOM changes (a stop button appearing/disappearing, a login wall) refresh main's cache
        // within HEALTH_MUTATION_THROTTLE_MS instead of waiting for the poll; guarded for node tests.
        try {
          const MO = typeof globalThis.MutationObserver === 'function' ? globalThis.MutationObserver : null
          const doc = typeof globalThis.document === 'object' && globalThis.document ? globalThis.document : null
          if (MO && doc && doc.documentElement) {
            mutationObserver = new MO(() => {
              if (mutationTimer !== null || disposed) return
              mutationTimer = globalThis.setTimeout(() => {
                mutationTimer = null
                publishHealth(false)
              }, HEALTH_MUTATION_THROTTLE_MS)
            })
            mutationObserver.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class', 'style', 'hidden', 'aria-label', 'data-testid'] })
          }
        } catch (_e) {
          /* no DOM here (unit tests) */
        }
        return true
      })
      .catch(() => false)
      .then(settle)

    return {
      ready,
      dispose() {
        disposed = true
        if (mutationObserver) {
          try {
            mutationObserver.disconnect()
          } catch (_e) {
            /* ignore */
          }
          mutationObserver = null
        }
        if (mutationTimer !== null) {
          globalThis.clearTimeout(mutationTimer)
          mutationTimer = null
        }
        backlog.length = 0
        if (timer !== null) clearI(timer)
        timer = null
        if (inFlight !== null) inFlight.controller.abort()
        adapter = null
      },
    }
  }

  /**
   * The globals a boot looks at — `window`, `document`, `process` and the `require` that resolves
   * 'electron' — resolved from `env` when given (unit tests stand them in), else from the globals.
   */
  function bootEnv(env) {
    const e = env && typeof env === 'object' ? env : {}
    return {
      window: 'window' in e ? e.window : typeof window !== 'undefined' ? window : undefined,
      document: 'document' in e ? e.document : typeof document !== 'undefined' ? document : undefined,
      process: 'process' in e ? e.process : typeof process !== 'undefined' ? process : undefined,
      require: typeof e.require === 'function' ? e.require : (name) => require(name),
    }
  }

  function underElectron(proc) {
    return !!(proc && proc.versions && proc.versions.electron)
  }

  /**
   * The IPC to attach. Under Electron (`process.versions.electron`) it is ALWAYS
   * `require('electron').ipcRenderer` — a page global is never consulted there, so a
   * `window.__triplexFakeIpc` a site could define can never capture the adapter even if this file
   * ran in a page's main world, and a failing `require('electron')` boots nothing rather than
   * falling back. Only outside Electron (the Playwright harness in plain Chrome) is
   * `window.__triplexFakeIpc` the IPC. Null = do not boot.
   */
  function pickIpc(env) {
    const e = bootEnv(env)
    if (underElectron(e.process)) {
      try {
        const electron = e.require('electron')
        return (electron && electron.ipcRenderer) || null
      } catch (_e) {
        return null
      }
    }
    return (e.window && e.window.__triplexFakeIpc) || null
  }

  /** Boot only inside a page: an Electron preload, or (outside Electron) a Chrome page carrying `window.__triplexFakeIpc`. */
  function shouldBoot(env) {
    const e = bootEnv(env)
    if (!e.window || !e.document) return false
    if (underElectron(e.process)) return true
    return !!e.window.__triplexFakeIpc
  }

  function boot(env) {
    const e = bootEnv(env)
    const ipc = pickIpc(e)
    if (!ipc || !e.document) return null
    return attachIpc(ipc, (config) =>
      createAdapter({
        document: e.document,
        window: e.window,
        site: config.site,
        selectors: config.selectors || DEFAULT_SELECTORS,
      }),
    )
  }

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      SLOTS,
      SESSION_STATES,
      REJECT_STATES,
      RESULT_CODES,
      MESSAGE_SELECTORS,
      ASSISTANT_SELECTORS,
      ALERT_SELECTORS,
      DEFAULT_SELECTORS,
      mergeSelectors,
      siteFor,
      hostMatches,
      siteSelectors,
      normalizeText,
      tailMatches,
      isBlank,
      nonNegativeInt,
      looksComplete,
      openShadowRoots,
      deepQuerySelector,
      deepQuerySelectorAll,
      isVisible,
      isClickable,
      isEnabled,
      isTextField,
      readText,
      scrubDom,
      toMarkdown,
      MD_SKIP_TAGS,
      MD_BLOCK_TAGS,
      MD_CHROME_TEXT,
      createAdapter,
      AdapterError,
      attachIpc,
      pickIpc,
      shouldBoot,
      boot,
      HEALTH_HEARTBEAT_MS,
      HEALTH_POLL_MS,
      SEND_POLL_MS,
      CONFIRM_POLL_MS,
      VERIFY_TAIL_CHARS,
      INSERT_SETTLE_MS,
      OBSERVE_THROTTLE_MS,
      OBSERVE_POLL_MS,
      SNAPSHOT_DROP_TAGS,
      SNAPSHOT_KEEP_ATTRS,
    }
  }

  if (shouldBoot()) boot()
})()
