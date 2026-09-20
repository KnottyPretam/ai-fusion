/* desktop/test/fake-site/site.js — look-alike composers for chatgpt / claude / grok.
 *
 * Query: ?site=chatgpt|claude|grok  ?state=ok|loggedout|challenge|blocked|slow  ?sendDelayMs=N
 *        ?thread=noise  (a rendered user/assistant exchange whose text and links look like every
 *        wall and banner rule — inside message containers, so the session must stay ok)
 *        ?composer=textarea  (grok only: the older textarea composer instead of the TipTap editor)
 * Paths (SPA fallback): /c/<id> (after a submit), /auth/login|/login|/sign-in (login walls),
 * /challenges.cloudflare.com/* (the local stand-in for the Turnstile iframe; nothing leaves the box).
 *
 * Stage 2 — replies (OPT-IN: without these a page behaves exactly as in Stage 1, no reply, no stop button):
 *   ?replyMs=N       after a submit, stream an assistant reply "Echo: <typed text>" over N ms (0 = at once)
 *   ?reply=json      canned JSON instead of the echo, fenced ```json … ```, keyed on the typed text —
 *                    "YOUR CLAIM" → this site's DefenseReply, "<<<DIVERGENCES>>>" → the ConvergenceCheck,
 *                    "<<<R1>>>" → the Extraction, checked in THAT order (a challenge prompt for R2/R3 also
 *                    carries <<<R1>>> in its anonymised peer block); no key → the echo. The texts are the
 *                    assembled `content` of backend/llm/fixtures/scenarios/planted_factual/*.jsonl, verbatim.
 *   ?reply=rich      (Stage 3) CANNED_RICH instead of the echo: a heading, bold / italic / inline code, a
 *                    link, a nested list, a GFM table and a fenced code block — every shape `toMarkdown`
 *                    has to rebuild
 *   ?reply=fidelity  (S7) CANNED_FIDELITY: the capture-fidelity reply — a paragraph carrying inline code
 *                    that CONTAINS a backtick and a KaTeX-shaped formula (the accessible MathML copy with
 *                    its `application/x-tex` annotation, hidden by clip as KaTeX hides it, next to the
 *                    aria-hidden glyph run), a nested list, a GFM table and a multi-line fenced JSON block
 *                    whose lines are `div.cm-line` BLOCK elements (a shiki / CodeMirror-style highlighter).
 *                    Analyze and Fusion parse that fenced body, so it has to come back byte for byte.
 *
 * Stage 3 — markdown replies: ?reply=json and ?reply=rich are RENDERED (renderMarkdown) as the chat UIs
 * render markdown — real block elements and real code-block chrome (a header carrying the language and a
 * "Copy code" button; inside the <pre> on chatgpt, before it on claude and grok; no language class on
 * grok's <code>, so the header is the only clue there) — instead of being dropped into the container as
 * text. A streaming PREFIX is re-rendered the same way, so an unterminated fence shows as an open code
 * block. The echo (?replyMs alone) stays plain text in a pre-wrap container, byte for byte.
 *   ?reply=openfence (S9) CANNED_OPEN_FENCE: a reply that ENDS inside a code block — its last fence is
 *                    never closed, so the page shows an open code block when the model stops. The
 *                    capture must still end normally (a markdown re-render always closes the block it
 *                    opens, which is why the captured text's fence count carries no "is it finished?"
 *                    information — see the S9 note below)
 *   ?nostop=1        no stop button while streaming (the adapter's quiet detection)
 *   ?nodone=1        chatgpt: no copy-turn done marker after the reply (quiet detection on chatgpt)
 *   ?blockAfterMs=N  N ms after a submit the "Unusual activity" alert appears and the reply freezes
 *                    (a blocked session mid-observe)
 *   ?doneLagMs=N     the END SIGNAL lands early: N ms before the last render the done marker is mounted
 *                    (chatgpt's copy button) and the stop button dropped (every site) while the text keeps
 *                    re-rendering — a capture that resolves on the first end signal reads a pre-final text
 *                    (window.__fake.doneSignalAt < lastRenderAt, rendersAfterSignal > 0)
 *
 * S9 — the fenced-reply capture defect, MEASURED live on 2026-09-18 (docs: the site.cjs header,
 * test/fixtures/dom/README.md). A real Analyze degraded twice on captures that were FRAGMENTS of a
 * reply still being typed: "```JSON\n{\n```" (13 characters) and `{"agre` (6). The analyst prompt asks
 * a web session for a ```json fence, so chatgpt opens a code block at the first character — and the
 * block carries its own copy control. Two options replay the two halves of that:
 *   ?codeCopyDone=1  chatgpt: the code block's copy button ALSO carries data-testid=
 *                    "copy-turn-action-button" — the turn marker's testid — as soon as the block
 *                    opens. It is a hypothesis about the live markup (the code-block button is
 *                    unverified, test/fixtures/dom/README.md), and the RULE it pins does not depend
 *                    on it: a done match inside the message body is never the end of the turn.
 *   ?stopBlinkMs=N   the stop button vanishes for N ms mid-stream and comes back (a re-render, an
 *                    animated swap, one frame missed) while the text keeps streaming: a capture that
 *                    LATCHES "stop button seen then gone" ends on the fragment it had.
 *   ?lullMs=N        one pause of N ms in the stream, after LULL_AT of the reply has rendered — the
 *                    ordinary gap between two token batches, and what lets a premature end signal
 *                    resolve. Composes with both options above (the blink starts at the same point).
 *
 * S10 — the same defect at the next effort level up: the analyst's reply became LONG (a JSON document of
 * several KB taking half a minute, with repeated pauses), and the capture ended inside it. The two keys
 * below are what the fake site was missing to express that at all — ?replyMs only ever stretched the same
 * ~1.2 KB canned body over more time, and ?lullMs pauses exactly ONCE:
 *   ?replyChars=N    pad the reply to at least N characters. A fenced JSON body is padded INSIDE its
 *                    object (one `filler_<i>` member per repetition), so the reply stays ONE balanced
 *                    JSON document that closes only at its very last character — the shape a real
 *                    analyst reply has. Any other reply is its own source repeated, blank-line
 *                    separated. Composes with every option above.
 *   ?lulls=N,ms      N pauses of `ms` each, spread evenly through the stream (at 1/(N+1), 2/(N+1) …).
 *                    Takes precedence over ?lullMs. window.__fake.lulls records every one of them.
 *
 *   ?twoTurns=1      the reply is TWO assistant containers: a first "tool" container (a fixed
 *                    'Searching the web…', marked done at once — chatgpt gets its copy button — while the
 *                    stop button stays up) and, TWO_TURNS_LAG_MS later, the answer container streaming as
 *                    usual; a capture must follow the LAST container and never end on the tool turn
 *   ?thinking=1      (S8, claude only) the claude.ai turn shape MEASURED on 2026-09-18: a thinking /
 *                    tool-use widget ABOVE the answer, whose summary line sits in the DOM TWICE — the
 *                    row on screen and the collapsed panel's own copy, the panel clipped to height 0
 *                    (NOT display:none / visibility:hidden / hidden / aria-hidden, so nothing the
 *                    markdown walk drops) — and the answer inside the `.prose` markdown body the live
 *                    probe measured. With claude's `assistantText` empty (the old default) a capture of
 *                    this shape begins "<summary>\n\n<summary>\n\n<detail>" before the answer: the
 *                    defect. With `assistantText: ['.prose']` it is the answer alone.
 *
 * S7 review — the chatgpt placeholder/remount lifecycle, MEASURED live on chatgpt.com with a real
 * logged-in session on 2026-09-17 (the same readings are in the site.cjs header and in
 * test/fixtures/dom/README.md):
 *   * within ~1 s of the submit a SHORT placeholder assistant turn is mounted (~12 characters, and on
 *     chatgpt with NO `.markdown` child) while button[data-testid="stop-button"] (aria-label
 *     "Stop answering") is visible;
 *   * at ~2 s that placeholder is UNMOUNTED: `[data-message-author-role="assistant"]` returns ZERO for
 *     roughly 10 s while the stop button stays visible;
 *   * at ~13 s the real reply container is mounted with a `.markdown` child carrying the answer;
 *   * at ~14 s the stop button disappears and a second copy-turn-action-button appears.
 * The two options below replay that lifecycle on a test timescale:
 *   ?remountMs=N     mount a short placeholder turn (?placeholderMs later it is REMOVED from the DOM
 *                    entirely — zero assistant containers), then mount the REAL reply N ms after that
 *                    removal and stream it as usual. The stop button is raised before the placeholder and
 *                    is dropped only at the end signal, so it stays visible across the whole gap (as
 *                    measured). Composes with ?replyMs / ?reply=… / ?nostop=1 / ?nodone=1 / ?doneLagMs /
 *                    ?twoTurns=1 (the two-turn dance happens after the gap) — with ?blockAfterMs the
 *                    banner timer still starts at the REAL reply, not at the submit. Note ?nostop=1:
 *                    with no stop button a placeholder that sits still for quietMs would itself look
 *                    quiet, so keep quietMs > placeholderMs there (as the specs do).
 *   ?placeholderMs=N how long the placeholder stays mounted before it is removed (default
 *                    PLACEHOLDER_MS); only meaningful with ?remountMs
 *   ?webUrlMs=N      the PLACEHOLDER chat URL: the submit pushes /c/WEB:<uuid> (which no tightened
 *                    chatUrlPattern matches, and which serve.js answers with 404 — on chatgpt.com a
 *                    revisit lands back on the home page) and N ms later REPLACES it with the real
 *                    /c/<uuid>, same uuid. Every push/replace is recorded in window.__fake.urls, so a
 *                    spec can assert which of them a chatUrlPattern would have recorded.
 *
 * Reply DOM — matches the selectors v2 `assistant` / `assistantText` / `stop` / `done` cascades
 * (site.cjs DEFAULT_SELECTORS, contract §4) with their FIRST entries:
 *   chatgpt  article[data-message-author-role=assistant] > div.markdown (the text)
 *            + div.actions > button[data-testid=copy-turn-action-button] once the reply is done;
 *            stop = button[data-testid=stop-button][aria-label="Stop streaming"]
 *   claude   div.font-claude-response — the text is the container's whole content (assistantText is
 *            empty for claude); stop = button[aria-label="Stop response"]; no done marker
 *   grok     div#response-<id> > div.response-content-markdown; stop = button[aria-label="Stop"]; no done marker
 * The stop button takes the send button's slot (grok: the voice/submit slot) while streaming, as on
 * the real pages, and the slot is restored when the reply ends. Streaming re-renders the text element
 * from scratch every 40 ms with a growing prefix; every 5th render shows a SHORTER prefix — the
 * markdown re-render "rewind" (counted in window.__fake.rewinds) — so a capture that accumulates
 * deltas is wrong and only the final text, read at the end, is right (Decision 16).
 *
 * The v1 selector cascades (site.cjs DEFAULT_SELECTORS) match their FIRST entry here:
 *   chatgpt  div#prompt-textarea.ProseMirror[contenteditable=true][translate=no] in a <form>,
 *            button[data-testid=send-button]#composer-submit-button (disabled until input)
 *   claude   div.ProseMirror[contenteditable=true], button[aria-label="Send message"]
 *   grok     div.tiptap.ProseMirror[contenteditable=true][role=textbox][aria-label="Ask Grok anything"]
 *            in a <form> (measured live on grok.com, 2026-09-16), next to a HIDDEN 14 px helper
 *            <textarea> with no aria-label (a bare `textarea` selector picks it — the bug the
 *            corrected cascade fixes). The action slot holds button[type=button][aria-label="Enter
 *            voice mode"] while the editor is empty; button[type=submit][aria-label=Submit]
 *            [data-testid=chat-submit] exists ONLY once the editor holds text (after ?sendDelayMs),
 *            so the send cascade can only be resolved after the insertion. Submitting clears the
 *            editor and restores the voice button.
 *   grok&composer=textarea   textarea[aria-label="Ask Grok anything"], button[aria-label="Submit"]
 *            (disabled until input) — keeps the native-value-setter insertion path covered.
 *
 * Editing model (pins the insertion technique):
 *   - contenteditable: a JS model is updated from TRUSTED beforeinput/input events only
 *     (insertText / insertParagraph / deleteContentBackward as performed by the browser); on the
 *     next animation frame after any DOM mutation that was not preceded by such an event, the DOM
 *     is re-rendered from the model — an innerHTML/textContent write is reconciled away.
 *   - textarea: React-style value tracking — the value is read on 'input' events only, and an
 *     instance-level `value` setter keeps the tracker in sync (so `el.value = x` + a synthetic
 *     input event is NOT seen as a change; the prototype setter + input event is).
 *
 * window.__fake = {submitted: [], site, state, variant, getText(), helperText(),
 *                  reply: {enabled, ms, kind, chars, lulls, nostop, nodone, blockAfterMs, doneLagMs,
 *                  twoTurns, remountMs, placeholderMs, webUrlMs}, replying,
 *                  done, renders, rewinds, containers, doneSignalAt, lastRenderAt, rendersAfterSignal,
 *                  placeholderText, placeholderAt, placeholderGoneAt, remountedAt, stopEvents, urls,
 *                  replyText(), replySource()} (the site's own debug surface; `replySource()` is the reply's
 * markdown source, null before any reply; `helperText()` is the hidden helper
 * textarea's value, null when there is none; `replyText()` the current reply text, null before any
 * reply; `containers` the assistant containers appended so far; `doneSignalAt` / `lastRenderAt` epoch
 * ms of the end signal and the last text render, null before; `rendersAfterSignal` the renders that
 * landed after the end signal; `lulls` every stream pause as {at, endAt} (S10); `placeholderText` the
 * placeholder turn's text (null when ?remountMs is off), `placeholderAt` / `placeholderGoneAt` /
 * `remountedAt` epoch ms of its mount, its removal and the
 * real container's mount; `stopEvents` every stop-button transition as {on, ts} — [{on:true},{on:false}]
 * means the button was up continuously across the gap; `urls` every pushState/replaceState as
 * {how:'push'|'replace', href, ts}).
 */
;(() => {
  'use strict'

  const SITES = {
    chatgpt: { title: 'ChatGPT', placeholder: 'Ask anything', loginHref: '/auth/login' },
    claude: { title: 'Claude', placeholder: 'How can I help you today?', loginHref: '/login' },
    grok: { title: 'Grok', placeholder: 'What do you want to know?', loginHref: '/sign-in' },
  }
  const LOGIN_PATHS = ['/auth/login', '/login', '/sign-in']
  const CHALLENGE_TITLE = 'Just a moment...'
  const BLOCKED_TEXT = 'Unusual activity has been detected from your device. Try again later.'

  /** Streaming cadence and the rewind rule (see the header). */
  const RENDER_MS = 40
  const REWIND_EVERY = 5
  const REWIND_FACTOR = 0.6
  /** ?twoTurns=1: the answer container follows the tool container after this many ms. */
  const TWO_TURNS_LAG_MS = 300
  /** ?lullMs / ?stopBlinkMs (S9): the fraction of the reply that is on the page when the stream pauses. */
  const LULL_AT = 0.35
  const TOOL_TEXT = 'Searching the web…'
  /**
   * ?remountMs: the placeholder turn chatgpt.com mounts before it unmounts everything (measured
   * 2026-09-17: ~12 characters, no `.markdown` child, up for about a second). PLACEHOLDER_MS is how
   * long it stays before it is removed; ?placeholderMs overrides it.
   */
  const PLACEHOLDER_TEXT = 'Placeholder…'
  const PLACEHOLDER_MS = 250
  /**
   * ?thinking=1 (claude): the thinking widget's summary line — the one the live capture came back
   * with twice — and the detail line of its collapsed panel. Both sit OUTSIDE the `.prose` body.
   */
  const THINKING_SUMMARY = 'Choosing the strongest language for safety-critical flight control.'
  const THINKING_DETAIL = 'Weighing certification evidence against memory safety.'
  /** ?webUrlMs: how the placeholder chat URL is prefixed on chatgpt.com (`/c/WEB:<uuid>`). */
  const WEB_URL_PREFIX = 'WEB:'

  // Canned JSON for ?reply=json — the assembled `content` of the planted_factual fixtures, verbatim
  // (analyst.extraction.1, <slot>.defense.1, analyst.convergence.1). observe.spec.js re-derives these
  // from the .jsonl files and asserts byte equality.
  const CANNED_EXTRACTION = `{"agreements": [{"topic": "Upper gyroscope range", "statement": "The gyroscope's highest selectable full-scale range is 2000 deg/s.", "models": ["R1", "R3"]}], "divergences": [{"id": "d1", "topic": "Maximum gyroscope full-scale range", "positions": [{"model": "R1", "claim": "The gyroscope full-scale range is selectable up to 2000 deg/s.", "evidence_cited": null}, {"model": "R2", "claim": "The gyroscope tops out at 1000 deg/s full scale.", "evidence_cited": null}, {"model": "R3", "claim": "The gyroscope supports selectable ranges from 125 deg/s up to 2000 deg/s.", "evidence_cited": null}], "materiality": "high"}, {"id": "d2", "topic": "Lowest selectable gyroscope range", "positions": [{"model": "R1", "claim": "Does not state a lower bound; describes the range only as selectable up to 2000 deg/s.", "evidence_cited": null}, {"model": "R2", "claim": "Does not state a lower bound.", "evidence_cited": null}, {"model": "R3", "claim": "The lowest selectable range is 125 deg/s.", "evidence_cited": null}], "materiality": "low"}]}`
  const CANNED_DEFENSE = {
    chatgpt: `{"stance": "revise", "justification": "Both peers state the gyroscope range is selectable up to 2000 deg/s, and the datasheet's GYRO_RANGE register (0x0F) confirms codes 0x00 through 0x04 for 2000, 1000, 500, 250 and 125 deg/s. I had quoted the 1000 deg/s intermediate setting as the maximum, which is incorrect.", "revised_claim": "The gyroscope full-scale range is selectable up to 2000 deg/s.", "confidence": 0.9, "persuaded_by": "the specific GYRO_RANGE register codes and the 2000 deg/s maximum cited by both peers"}`,
    claude: `{"stance": "defend", "justification": "The BMI088 datasheet's GYRO_RANGE register (0x0F) lists five selectable full-scale ranges: 125, 250, 500, 1000 and 2000 deg/s, with 2000 deg/s the power-on default. The 1000 deg/s figure is one of the intermediate settings, not the maximum.", "revised_claim": null, "confidence": 0.95, "persuaded_by": null}`,
    grok: `{"stance": "defend", "justification": "The datasheet's gyroscope specification table gives the full-scale range as +/-125, +/-250, +/-500, +/-1000 and +/-2000 deg/s selected through GYRO_RANGE; 1000 deg/s is a mid-scale setting and the maximum is 2000 deg/s.", "revised_claim": null, "confidence": 0.93, "persuaded_by": null}`,
  }
  const CANNED_CONVERGENCE = `{"statuses": [{"divergence_id": "d1", "status": "resolved"}]}`

  // Canned markdown for ?reply=rich (Stage 3): one reply that carries every shape `toMarkdown`
  // has to rebuild — a heading, bold / italic / inline code, a link (whose URL the capture drops),
  // a nested list, a GFM table and a fenced code block. observe.spec.js holds the markdown the
  // capture must come back as: this source with the link flattened to its text.
  const CANNED_RICH = [
    '## Gyroscope range',
    '',
    'The **BMI088** gyroscope selects its range through the `GYRO_RANGE` register, see [the datasheet](https://example.com/bmi088/datasheet.pdf).',
    '',
    '- 2000 deg/s _default_',
    '  - 1000 deg/s',
    '  - 500 deg/s',
    '- 125 deg/s',
    '',
    '| Register | Value |',
    '| --- | --- |',
    '| GYRO_RANGE | 0x0F |',
    '| CHIP_ID | 0x1F |',
    '',
    '```json',
    '{"register": "0x0F", "max_dps": 2000}',
    '```',
  ].join('\n')

  /**
   * Canned markdown for ?reply=fidelity (S7): one reply that carries every shape the capture used to
   * mangle — inline code holding a backtick, a KaTeX formula, a nested list, a GFM table and a
   * multi-line JSON body rendered one BLOCK element per line. observe.spec.js asserts the capture
   * comes back as this source, verbatim, and that the fenced body still JSON.parses.
   */
  const CANNED_FIDELITY = [
    '## Capture fidelity',
    '',
    'The range register is `` `GYRO_RANGE` `` in prose, and the axis tolerance is $\\pm 0.5^\\circ$ at 25 C.',
    '',
    '- ranges',
    '  - 2000 deg/s',
    '  - 125 deg/s',
    '- registers',
    '',
    '| Register | Value |',
    '| --- | --- |',
    '| GYRO_RANGE | 0x0F |',
    '| CHIP_ID | 0x1F |',
    '',
    '```json',
    '{',
    '  "register": "0x0F",',
    '  "ranges": [2000, 125],',
    '  "note": "a ` backtick and a \\"quote\\" inside a string"',
    '}',
    '```',
  ].join('\n')

  /**
   * Canned markdown for ?reply=openfence (S9): a reply that STOPS inside a code block — the opening
   * fence is there, the closing one never arrives. The page renders an open code block, and a
   * markdown re-render of that DOM closes it again, so the captured text holds TWO fence markers
   * where the reply held one. That is why "an odd number of fence markers means the reply is still
   * streaming" is not a usable rule on a captured text (and why a rule built on it would hang here).
   */
  const CANNED_OPEN_FENCE = [
    'Here is the extraction:',
    '',
    '```json',
    '{"agreements": [{"topic": "Upper gyroscope range", "models": ["R1", "R3"]}],',
    ' "divergences": []',
  ].join('\n')

  /** `?lulls=N,ms` → {count, ms}; anything unusable (a missing count or interval) is no pauses at all. */
  function parseLulls(raw) {
    if (typeof raw !== 'string' || raw === '') return null
    const [n, ms] = raw.split(',').map((x) => Number(x))
    if (!Number.isFinite(n) || !Number.isFinite(ms) || n < 1 || ms < 0) return null
    return { count: Math.floor(n), ms: Math.floor(ms) }
  }

  const params = new URLSearchParams(location.search)
  const site = Object.prototype.hasOwnProperty.call(SITES, params.get('site')) ? params.get('site') : 'chatgpt'
  const cfg = SITES[site]
  const path = location.pathname
  let state = params.get('state') || 'ok'
  if (LOGIN_PATHS.includes(path)) state = 'loggedout'
  const sendDelayMs = Math.max(0, Number(params.get('sendDelayMs')) || 0)
  /** Composer variant: 'tiptap' (grok default), 'textarea' (grok&composer=textarea), 'prosemirror' (chatgpt/claude). */
  const variant = site === 'grok' ? (params.get('composer') === 'textarea' ? 'textarea' : 'tiptap') : 'prosemirror'
  /** Stage 2 reply options (opt-in). */
  const replyOpts = {
    enabled: params.has('replyMs') || params.has('reply'),
    ms: Math.max(0, Number(params.get('replyMs')) || 0),
    kind: ['json', 'rich', 'fidelity', 'openfence'].includes(params.get('reply')) ? params.get('reply') : 'echo',
    nostop: params.get('nostop') === '1',
    // S9: the code block's own copy control carries the turn marker's testid (chatgpt only)
    codeCopyDone: params.get('codeCopyDone') === '1' && site === 'chatgpt',
    // S9: one pause in the stream, and a stop button that blinks out mid-stream and comes back
    lullMs: params.has('lullMs') ? Math.max(0, Number(params.get('lullMs')) || 0) : null,
    // S10: a reply that is long in BYTES, and repeated pauses rather than one
    chars: params.has('replyChars') ? Math.max(0, Number(params.get('replyChars')) || 0) : null,
    lulls: parseLulls(params.get('lulls')),
    stopBlinkMs: params.has('stopBlinkMs') ? Math.max(0, Number(params.get('stopBlinkMs')) || 0) : null,
    nodone: params.get('nodone') === '1',
    blockAfterMs: params.has('blockAfterMs') ? Math.max(0, Number(params.get('blockAfterMs')) || 0) : null,
    doneLagMs: params.has('doneLagMs') ? Math.max(0, Number(params.get('doneLagMs')) || 0) : null,
    twoTurns: params.get('twoTurns') === '1',
    // ?thinking=1 — claude only (the widget is claude.ai's; chatgpt and grok keep their shapes)
    thinking: params.get('thinking') === '1' && site === 'claude',
    // the measured chatgpt lifecycle (see the header): a placeholder turn, then a gap with NO
    // assistant container at all, then the real reply
    remountMs: params.has('remountMs') ? Math.max(0, Number(params.get('remountMs')) || 0) : null,
    placeholderMs: params.has('placeholderMs') ? Math.max(0, Number(params.get('placeholderMs')) || 0) : PLACEHOLDER_MS,
  }
  /** ?webUrlMs: the placeholder chat URL is replaced by the real one this many ms after the push. */
  const webUrlMs = params.has('webUrlMs') ? Math.max(0, Number(params.get('webUrlMs')) || 0) : null
  replyOpts.webUrlMs = webUrlMs

  const app = document.getElementById('app')
  app.setAttribute('data-site', site)
  app.setAttribute('data-state', state)

  const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true)

  let composer = null // {el, getText(), clear()}
  let actions = null // {apply(on), streaming(on)}: how the action slot renders send / voice / stop
  let sendEnabled = false
  let sendTimer = null
  let reply = null // {container, textEl, full, timer, markDone()}

  const fake = {
    submitted: [],
    site,
    state,
    variant,
    getText: () => (composer ? composer.getText() : null),
    helperText: () => {
      const helper = document.querySelector('textarea.helper')
      return helper ? helper.value : null
    },
    reply: replyOpts,
    replying: false,
    done: false,
    renders: 0,
    rewinds: 0,
    containers: 0,
    doneSignalAt: null,
    lastRenderAt: null,
    rendersAfterSignal: 0,
    /** S9: when the one stream pause (?lullMs) began and ended, and the stop-button blink (?stopBlinkMs). */
    lullAt: null,
    lullEndAt: null,
    /** S10: every pause of ?lulls=N,ms as {at, endAt} (?lullMs contributes its single one too). */
    lulls: [],
    stopBlinkAt: null,
    stopBlinkEndAt: null,
    // ?remountMs: the placeholder turn's text and the three moments of the measured lifecycle
    placeholderText: replyOpts.remountMs === null ? null : PLACEHOLDER_TEXT,
    placeholderAt: null,
    placeholderGoneAt: null,
    remountedAt: null,
    /** Every stop-button transition, {on, ts}: [{on:true},{on:false}] = up continuously across the gap. */
    stopEvents: [],
    /** Every history push/replace, {how, href, ts} — which of them a chatUrlPattern would record. */
    urls: [],
    replyText: () => (reply ? reply.textEl.textContent : null),
    replySource: () => (reply ? reply.full : null),
    /** ?thinking=1: the two lines the widget puts outside the `.prose` body (null when it is off). */
    thinking: replyOpts.thinking ? { summary: THINKING_SUMMARY, detail: THINKING_DETAIL } : null,
  }
  window.__fake = fake

  // --- the Turnstile stand-in (only ever rendered inside the challenge iframe) ---------------
  if (path.startsWith('/challenges.cloudflare.com/')) {
    document.title = CHALLENGE_TITLE
    app.innerHTML = '<div class="challenge"><p>Verifying you are human. This may take a few seconds.</p></div>'
    return
  }

  document.title = state === 'challenge' ? CHALLENGE_TITLE : cfg.title

  const header = document.createElement('header')
  header.textContent = cfg.title
  app.appendChild(header)

  if (state === 'loggedout') {
    const wall = clone('tpl-login')
    wall.querySelector('a').setAttribute('href', cfg.loginHref)
    app.appendChild(wall)
    return
  }

  if (state === 'challenge') {
    const box = document.createElement('div')
    box.className = 'challenge'
    box.innerHTML = '<h1>' + cfg.title + '</h1><p>Checking your browser before accessing the site.</p>'
    const iframe = document.createElement('iframe')
    // The src string contains "challenges.cloudflare.com" (what the challenge cascade keys on) but
    // is a same-origin path served by the SPA fallback.
    iframe.src = '/challenges.cloudflare.com/turnstile/v0/' + site
    iframe.title = 'Widget containing a Cloudflare security challenge'
    box.appendChild(iframe)
    app.appendChild(box)
    return
  }

  /** The "unusual activity" banner: an alert-like container outside the thread (the errorText scope). */
  function showBlockedAlert() {
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alert')
    alert.textContent = BLOCKED_TEXT
    app.insertBefore(alert, thread || null)
    app.setAttribute('data-state', 'blocked')
    fake.state = 'blocked'
  }

  let thread = null
  if (state === 'blocked') showBlockedAlert()

  thread = document.createElement('main')
  thread.className = 'thread'
  app.appendChild(thread)

  // ?thread=noise: chat content that mentions every errorText phrase of every site and links to
  // every loggedOut href (/auth/login, /login, /sign-in, accounts.x.ai) — all inside
  // article[data-message-author-role] containers. A correct session check keeps the page 'ok'.
  if (params.get('thread') === 'noise') {
    const user = document.createElement('article')
    user.setAttribute('data-message-author-role', 'user')
    user.innerHTML =
      'How do I handle an API rate limit? Last time Something went wrong and it said You\'ve reached your limit — ' +
      'see <a href="/auth/login">/auth/login</a>, <a href="/login">/login</a> and <a href="/sign-in">/sign-in</a>.'
    thread.appendChild(user)
    const assistant = document.createElement('article')
    assistant.setAttribute('data-message-author-role', 'assistant')
    assistant.innerHTML =
      'A rate limit is a cap on requests. "Unusual activity has been detected" is the banner you would see; ' +
      'unusual activity in your own logs is something else. For xAI, sign in at <a href="https://accounts.x.ai/sign-in">accounts.x.ai</a>.'
    thread.appendChild(assistant)
  }

  // --- helpers ------------------------------------------------------------------------------
  const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  /** A v4-shaped id (the sites mint uuids; ?webUrlMs needs one to prefix with WEB:). */
  const randomUuid = () => [hex(8), hex(4), '4' + hex(3), ((Math.floor(Math.random() * 4) + 8).toString(16) + hex(3)), hex(12)].join('-')

  /** pushState / replaceState, recorded in window.__fake.urls (a spec asserts which URL a pattern would record). */
  function goUrl(how, url) {
    if (how === 'replace') history.replaceState({}, '', url)
    else history.pushState({}, '', url)
    fake.urls.push({ how, href: location.href, ts: Date.now() })
  }

  function setSendEnabled(on) {
    if (sendTimer !== null) {
      clearTimeout(sendTimer)
      sendTimer = null
    }
    const apply = () => {
      sendEnabled = on
      if (actions) actions.apply(on)
    }
    if (on && sendDelayMs > 0) sendTimer = setTimeout(apply, sendDelayMs)
    else apply()
  }

  function onModelChange(text) {
    setSendEnabled(text.trim() !== '')
  }

  function submit() {
    if (!composer || !sendEnabled) return
    const text = composer.getText()
    if (text.trim() === '') return
    fake.submitted.push(text)
    const msg = document.createElement('article')
    msg.setAttribute('data-message-author-role', 'user')
    msg.textContent = text
    thread.appendChild(msg)
    composer.clear()
    setSendEnabled(false)
    setTimeout(() => {
      // Real sites mint the chat id on the FIRST message and keep it for later turns; do the same so a
      // recorded chat link stays equal to the pane's URL across sends.
      if (/^\/c\/[A-Za-z0-9]+/.test(location.pathname)) return
      if (webUrlMs === null) {
        goUrl('push', '/c/' + randomId() + location.search)
        return
      }
      // ?webUrlMs (measured on chatgpt.com, 2026-09-17): the first reply streams under a PLACEHOLDER
      // url `/c/WEB:<uuid>` — which a chatUrlPattern that ends the id at the segment never matches —
      // and only later is it replaced by the real `/c/<uuid>`. The uuid is kept; only the prefix goes.
      const uuid = randomUuid()
      goUrl('push', '/c/' + WEB_URL_PREFIX + uuid + location.search)
      setTimeout(() => goUrl('replace', '/c/' + uuid + location.search), webUrlMs)
    }, 500)
    if (replyOpts.enabled) startReply(text)
  }

  function isSubmitKey(e) {
    return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing
  }

  // --- replies (Stage 2) --------------------------------------------------------------------

  /** The canned JSON for a typed text under ?reply=json, in the documented key order; null when no key matches. */
  function cannedFor(text) {
    if (text.includes('YOUR CLAIM')) return CANNED_DEFENSE[site]
    if (text.includes('<<<DIVERGENCES>>>')) return CANNED_CONVERGENCE
    if (text.includes('<<<R1>>>')) return CANNED_EXTRACTION
    return null
  }

  function replyFor(text) {
    if (replyOpts.kind === 'fidelity') return padTo(CANNED_FIDELITY, replyOpts.chars)
    if (replyOpts.kind === 'openfence') return padTo(CANNED_OPEN_FENCE, replyOpts.chars)
    if (replyOpts.kind === 'rich') return padTo(CANNED_RICH, replyOpts.chars)
    if (replyOpts.kind === 'json') {
      const canned = cannedFor(text)
      if (canned !== null) return padTo('```json\n' + canned + '\n```', replyOpts.chars)
    }
    return padTo('Echo: ' + text, replyOpts.chars)
  }

  /** The filler sentence ?replyChars repeats. Plain ASCII: no quote, backslash or brace to confuse a parser. */
  const FILLER = 'the datasheet repeats this sentence so the reply is long enough to stream for a while'

  /**
   * ?replyChars=N — pad a reply to at least N characters (see the header). A fenced JSON body gains one
   * `filler_<i>` member per repetition INSIDE its object, so the whole reply is still ONE balanced JSON
   * document whose closing brace is its last character but one: that is what a long analyst reply looks
   * like, and it is the only shape in which "the object has not closed yet" means "not finished yet".
   * Anything else is its own source repeated, blank-line separated.
   */
  function padTo(src, chars) {
    if (!chars || src.length >= chars) return src
    const fence = /^```json\n(\{[\s\S]*\})\n```$/.exec(src)
    if (fence) {
      const inner = fence[1].slice(1, -1).trim()
      const members = []
      let length = '```json\n{}\n```'.length + inner.length
      for (let i = 0; length < chars; i += 1) {
        const member = `"filler_${i}": "${FILLER}"`
        members.push(member)
        length += member.length + 2 // the member and its ", " separator
      }
      if (inner !== '') members.push(inner)
      return '```json\n{' + members.join(', ') + '}\n```'
    }
    let out = src
    while (out.length < chars) out += '\n\n' + src
    return out
  }

  /**
   * Where the stream pauses: ?lulls=N,ms spreads N pauses evenly through it (S10 — a long reply lulls
   * repeatedly, and every lull is a chance for a capture to end early, which ONE pause cannot show),
   * else ?lullMs is a single pause after LULL_AT of the reply (S9).
   */
  function pausePoints() {
    if (replyOpts.lulls) {
      const out = []
      for (let i = 1; i <= replyOpts.lulls.count; i += 1) out.push({ at: i / (replyOpts.lulls.count + 1), ms: replyOpts.lulls.ms })
      return out
    }
    return replyOpts.lullMs === null ? [] : [{ at: LULL_AT, ms: replyOpts.lullMs }]
  }

  // --- markdown → DOM (Stage 3) --------------------------------------------------------------
  //
  // ?reply=json and ?reply=rich render their markdown as the chat UIs do — real block elements and
  // real code-block chrome — instead of dropping the raw text into the container, so
  // `toMarkdown` has to rebuild the markdown from the DOM. An unterminated fence in a streaming
  // PREFIX renders as an open code block, exactly like a live markdown renderer.

  /**
   * `renderInline` is recursive, so each call gets its OWN matcher (a shared /g regex would loop).
   * The double-backtick branch comes FIRST so `` `x` `` is inline code whose body holds a backtick;
   * `$tex$` renders as a KaTeX-shaped formula (see `buildMath`).
   */
  const inlineMatcher = () =>
    /``\s?(?<tickcode>.+?)\s?``|`(?<code>[^`]+)`|\*\*(?<strong>[^*]+)\*\*|_(?<em>[^_]+)_|\[(?<link>[^\]]+)\]\((?<href>[^)]+)\)|\$(?<tex>[^$\n]+)\$/g

  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
  /** The glyphs a TeX source renders to — enough of a mapping for the canned formulas. */
  const TEX_GLYPHS = { '\\pm': '±', '\\circ': '°', '\\times': '×', '\\le': '≤', '\\ge': '≥', '\\alpha': 'α' }
  const texGlyphs = (tex) =>
    tex
      .replace(/\\[a-zA-Z]+/g, (c) => TEX_GLYPHS[c] || '')
      .replace(/[{}^_]/g, '')
      .replace(/\s+/g, '')

  /**
   * A formula exactly as KaTeX renders one: an accessible MathML copy carrying the TeX source in an
   * `annotation[encoding="application/x-tex"]` (hidden by CLIP in site.css, never display:none) next
   * to the aria-hidden glyph run the reader sees. A capture must take the TeX ONCE.
   */
  function buildMath(tex) {
    const mathEl = (tag) => document.createElementNS(MATHML_NS, tag)
    const span = el('span', 'katex')
    const mathml = el('span', 'katex-mathml')
    const math = mathEl('math')
    const semantics = mathEl('semantics')
    const mrow = mathEl('mrow')
    const mi = mathEl('mi')
    mi.textContent = texGlyphs(tex)
    mrow.appendChild(mi)
    const annotation = mathEl('annotation')
    annotation.setAttribute('encoding', 'application/x-tex')
    annotation.textContent = tex
    semantics.append(mrow, annotation)
    math.appendChild(semantics)
    mathml.appendChild(math)
    const html = el('span', 'katex-html')
    html.setAttribute('aria-hidden', 'true')
    const glyphs = el('span', 'mord')
    glyphs.textContent = texGlyphs(tex)
    html.appendChild(glyphs)
    span.append(mathml, html)
    return span
  }
  const el = (tag, className) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    return node
  }

  function appendText(parent, s) {
    if (s === '') return
    s.split('\n').forEach((part, i) => {
      if (i > 0) parent.appendChild(document.createElement('br'))
      if (part !== '') parent.appendChild(document.createTextNode(part))
    })
  }

  /** Inline markdown: `code` / `` `code` ``, **bold**, _italic_, [text](url), $tex$ — nothing nested inside code. */
  function renderInline(parent, text) {
    const re = inlineMatcher()
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
      appendText(parent, text.slice(last, m.index))
      const g = m.groups
      if (g.tickcode !== undefined || g.code !== undefined) {
        const code = document.createElement('code')
        code.textContent = g.tickcode !== undefined ? g.tickcode : g.code
        parent.appendChild(code)
      } else if (g.strong !== undefined) {
        const strong = document.createElement('strong')
        renderInline(strong, g.strong)
        parent.appendChild(strong)
      } else if (g.em !== undefined) {
        const em = document.createElement('em')
        renderInline(em, g.em)
        parent.appendChild(em)
      } else if (g.link !== undefined) {
        const a = document.createElement('a')
        a.setAttribute('href', g.href)
        renderInline(a, g.link)
        parent.appendChild(a)
      } else {
        parent.appendChild(buildMath(g.tex))
      }
      last = m.index + m[0].length
    }
    appendText(parent, text.slice(last))
  }

  /**
   * The per-site code-block chrome (the shapes the adapters have to see through):
   *   chatgpt  the header label and the "Copy code" button live INSIDE the <pre>, the body is
   *            <code class="language-xxx">
   *   claude   a header div BEFORE the <pre>, <code class="language-xxx">, a copy button after it
   *   grok     a header row (label + copy button) before the <pre>, and NO language class on the
   *            code — the label is the only clue, so both language sources stay covered
   */
  /**
   * The body of a code block: one text node (chatgpt / claude / grok as measured), or — under
   * ?reply=fidelity — one BLOCK `div.cm-line` per line, the shiki / CodeMirror shape whose lines a
   * capture that only breaks on `<br>` used to run together.
   */
  function fillCode(code, body) {
    if (replyOpts.kind !== 'fidelity') {
      code.textContent = body
      return
    }
    for (const line of body.split('\n')) {
      const div = el('div', 'cm-line')
      if (line !== '') div.appendChild(document.createTextNode(line))
      code.appendChild(div)
    }
  }

  function buildCodeBlock(lang, body) {
    const code = document.createElement('code')
    fillCode(code, body)
    if (site === 'chatgpt') {
      const pre = el('pre', 'code-pre')
      const wrap = el('div', 'code-wrap')
      const header = el('div', 'code-header')
      header.textContent = lang
      const sticky = el('div', 'code-sticky')
      const copy = document.createElement('button')
      copy.type = 'button'
      // ?codeCopyDone=1 (S9): the same testid the TURN's copy button carries, mounted with the block
      copy.setAttribute('data-testid', replyOpts.codeCopyDone ? 'copy-turn-action-button' : 'copy-code-button')
      copy.setAttribute('aria-label', 'Copy code')
      copy.textContent = 'Copy code'
      sticky.appendChild(copy)
      const bodyBox = el('div', 'code-body')
      if (lang !== '') code.className = 'whitespace-pre! language-' + lang
      bodyBox.appendChild(code)
      wrap.append(header, sticky, bodyBox)
      pre.appendChild(wrap)
      return pre
    }
    if (site === 'claude') {
      const block = el('div', 'code-block')
      const header = el('div', 'code-header')
      header.textContent = lang
      const inner = el('div', 'code-block__code')
      const pre = document.createElement('pre')
      if (lang !== '') code.className = 'language-' + lang
      pre.appendChild(code)
      inner.appendChild(pre)
      const actions = el('div', 'code-actions')
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.setAttribute('aria-label', 'Copy')
      copy.textContent = 'Copy'
      actions.appendChild(copy)
      block.append(header, inner, actions)
      return block
    }
    const block = el('div', 'not-prose')
    const header = el('div', 'code-header')
    const label = el('span', 'code-lang')
    label.textContent = lang
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.setAttribute('aria-label', 'Copy')
    copy.textContent = 'Copy'
    header.append(label, copy)
    const pre = document.createElement('pre')
    pre.appendChild(code)
    block.append(header, pre)
    return block
  }

  function buildList(lines) {
    const list = document.createElement(/^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul')
    let i = 0
    while (i < lines.length) {
      const m = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i])
      const indent = m[1].length
      const item = document.createElement('li')
      renderInline(item, m[2])
      i += 1
      const nested = []
      while (i < lines.length) {
        const deeper = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(lines[i])
        if (!deeper || deeper[1].length <= indent) break
        nested.push(lines[i])
        i += 1
      }
      if (nested.length > 0) item.appendChild(buildList(nested))
      list.appendChild(item)
    }
    return list
  }

  function buildTable(rows) {
    const cellsOf = (line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((s) => s.trim())
    const table = document.createElement('table')
    const body = document.createElement('tbody')
    rows.forEach((line, index) => {
      const values = cellsOf(line)
      if (index === 1 && values.every((v) => /^:?-{3,}:?$/.test(v))) return // the GFM separator row
      const tr = document.createElement('tr')
      for (const value of values) {
        const cell = document.createElement(index === 0 ? 'th' : 'td')
        renderInline(cell, value)
        tr.appendChild(cell)
      }
      if (index === 0) {
        const head = document.createElement('thead')
        head.appendChild(tr)
        table.appendChild(head)
      } else {
        body.appendChild(tr)
      }
    })
    table.appendChild(body)
    return table
  }

  const isBlockStart = (line) => /^```|^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s|^\s*\|/.test(line)

  /** Render `src` as markdown into `target` (every child replaced, as a markdown renderer does). */
  function renderMarkdown(target, src) {
    const wrap = el('div', 'md')
    const lines = src.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      const fence = /^```(\S*)\s*$/.exec(line)
      if (fence) {
        const body = []
        i += 1
        while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
        if (i < lines.length) i += 1 // the closing fence
        wrap.appendChild(buildCodeBlock(fence[1], body.join('\n')))
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) {
        const h = document.createElement('h' + heading[1].length)
        renderInline(h, heading[2])
        wrap.appendChild(h)
        i += 1
        continue
      }
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
        const block = []
        while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) block.push(lines[i++])
        wrap.appendChild(buildList(block))
        continue
      }
      if (/^\s*\|/.test(line)) {
        const rows = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++])
        wrap.appendChild(buildTable(rows))
        continue
      }
      const paragraph = []
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) paragraph.push(lines[i++])
      const p = document.createElement('p')
      renderInline(p, paragraph.join('\n'))
      wrap.appendChild(p)
    }
    target.replaceChildren(wrap)
  }

  /**
   * ?thinking=1 (claude, S8): the thinking / tool-use widget that sits above the answer inside
   * `.font-claude-response`. Its summary line is in the DOM TWICE — the visible row and the
   * collapsed panel's copy — which is how one line reached a real capture as two blocks. The panel
   * is clipped (`height: 0; overflow: hidden`, see site.css), never `display:none`: a panel the
   * markdown walk already drops would not reproduce anything.
   */
  function buildThinking() {
    const widget = el('div', 'thinking')
    widget.setAttribute('data-state', 'closed')
    const head = el('div', 'thinking-head')
    const headline = el('div', 'thinking-summary')
    headline.textContent = THINKING_SUMMARY
    head.appendChild(headline)
    const panel = el('div', 'thinking-panel')
    const panelLine = el('div', 'thinking-summary')
    panelLine.textContent = THINKING_SUMMARY
    const detail = el('div', 'thinking-detail')
    detail.textContent = THINKING_DETAIL
    panel.appendChild(panelLine)
    panel.appendChild(detail)
    widget.appendChild(head)
    widget.appendChild(panel)
    return widget
  }

  /** The per-site assistant container: `{container, textEl, markDone()}` (see the header for the shapes). */
  function buildAssistant() {
    if (site === 'chatgpt') {
      const article = document.createElement('article')
      article.setAttribute('data-message-author-role', 'assistant')
      const md = document.createElement('div')
      md.className = 'markdown'
      article.appendChild(md)
      return {
        container: article,
        textEl: md,
        markDone() {
          if (replyOpts.nodone) return
          const bar = document.createElement('div')
          bar.className = 'actions'
          const copy = document.createElement('button')
          copy.type = 'button'
          copy.setAttribute('data-testid', 'copy-turn-action-button')
          copy.setAttribute('aria-label', 'Copy')
          copy.textContent = 'Copy'
          bar.appendChild(copy)
          article.appendChild(bar)
        },
      }
    }
    if (site === 'claude') {
      const box = document.createElement('div')
      box.className = 'font-claude-response reply'
      if (!replyOpts.thinking) return { container: box, textEl: box, markDone() {} }
      // ?thinking=1: the widget above the answer, then the markdown body the capture must read
      box.appendChild(buildThinking())
      const body = el('div', 'grid-cols-1 grid gap-2.5 prose')
      box.appendChild(body)
      return { container: box, textEl: body, markDone() {} }
    }
    const box = document.createElement('div')
    box.id = 'response-' + randomId()
    box.className = 'reply'
    const md = document.createElement('div')
    md.className = 'response-content-markdown'
    box.appendChild(md)
    return { container: box, textEl: md, markDone() {} }
  }

  /**
   * The SHORT placeholder assistant turn of the measured chatgpt lifecycle (?remountMs): the container
   * the site mounts within ~1 s of the submit and unmounts again a beat later. On chatgpt it carries NO
   * `.markdown` child (measured 2026-09-17), so a capture reads its text through the container itself —
   * which is exactly why it must never be mistaken for the answer; claude / grok get the same shape
   * without their inner markdown element (not measured there, kept symmetrical).
   */
  function buildPlaceholder() {
    if (site === 'chatgpt') {
      const article = document.createElement('article')
      article.setAttribute('data-message-author-role', 'assistant')
      article.textContent = PLACEHOLDER_TEXT
      return article
    }
    const box = document.createElement('div')
    box.className = site === 'claude' ? 'font-claude-response reply' : 'reply'
    if (site === 'grok') box.id = 'response-' + randomId()
    box.textContent = PLACEHOLDER_TEXT
    return box
  }

  /**
   * Full re-render of the reply (what a markdown renderer does): every child replaced. The echo is
   * plain text in a `pre-wrap` container (so its spaces, tabs and newlines read back byte for
   * byte); ?reply=json / ?reply=rich render their markdown as real DOM (see `renderMarkdown`).
   */
  function renderReply(s) {
    if (replyOpts.kind === 'echo') reply.textEl.replaceChildren(document.createTextNode(s))
    else renderMarkdown(reply.textEl, s)
    fake.renders += 1
    fake.lastRenderAt = Date.now()
    if (reply.ended) fake.rendersAfterSignal += 1
  }

  function endReply() {
    if (reply.timer !== null) {
      clearTimeout(reply.timer)
      reply.timer = null
    }
    fake.replying = false
    actions.streaming(false)
  }

  /** Append an assistant container to the thread (counted in window.__fake.containers). */
  function appendAssistant(built) {
    thread.appendChild(built.container)
    fake.containers += 1
  }

  /**
   * ?remountMs — the measured chatgpt lifecycle (see the header): a short placeholder turn under the
   * stop button, then the placeholder REMOVED (zero assistant containers) for `remountMs`, then the
   * real reply. The stop button is raised before the placeholder and only dropped by the end signal,
   * so it is visible across the whole gap; `?twoTurns` and every other reply option then apply to the
   * real reply exactly as without this option.
   */
  function startReply(text) {
    if (replyOpts.remountMs === null) {
      beginReply(text)
      return
    }
    const placeholder = buildPlaceholder()
    thread.appendChild(placeholder)
    fake.containers += 1
    fake.placeholderAt = Date.now()
    fake.replying = true
    fake.done = false
    if (!replyOpts.nostop) actions.streaming(true)
    setTimeout(() => {
      placeholder.remove() // unmounted entirely: countAssistant() is back to the baseline
      fake.placeholderGoneAt = Date.now()
      setTimeout(() => {
        fake.remountedAt = Date.now()
        beginReply(text)
      }, replyOpts.remountMs)
    }, replyOpts.placeholderMs)
  }

  function beginReply(text) {
    if (replyOpts.twoTurns) {
      // ?twoTurns=1: a finished "tool" turn first — its text static, its done marker mounted at once
      // (chatgpt) — under the stop button, then the answer container after TWO_TURNS_LAG_MS.
      const tool = buildAssistant()
      tool.textEl.replaceChildren(document.createTextNode(TOOL_TEXT))
      appendAssistant(tool)
      tool.markDone()
      fake.replying = true
      fake.done = false
      if (!replyOpts.nostop) actions.streaming(true)
      setTimeout(() => streamReply(text), TWO_TURNS_LAG_MS)
      return
    }
    streamReply(text)
  }

  function streamReply(text) {
    const built = buildAssistant()
    reply = { ...built, full: replyFor(text), timer: null, ended: false }
    appendAssistant(built)
    fake.replying = true
    fake.done = false
    if (!replyOpts.nostop) actions.streaming(true)
    const t0 = Date.now()
    let ticks = 0
    let paused = 0 // a pause stops the stream's own clock, so the rest of the reply still streams
    const pauses = pausePoints()
    let nextPause = 0
    let blinkDone = false
    /**
     * ?stopBlinkMs (S9): the stop button vanishes for a beat mid-stream and comes back — a re-render,
     * an animated swap, one frame missed. The text keeps streaming the whole time, so a capture that
     * LATCHES "stop button seen then gone" on that one sample ends on a fragment.
     */
    const blinkStop = () => {
      if (replyOpts.nostop) return
      fake.stopBlinkAt = Date.now()
      actions.streaming(false)
      setTimeout(() => {
        fake.stopBlinkEndAt = Date.now()
        if (fake.replying) actions.streaming(true)
      }, replyOpts.stopBlinkMs)
    }
    /** The end signal — the done marker (chatgpt) mounted, the stop button gone — once; under ?doneLagMs it lands BEFORE the last render. */
    const signalEnd = () => {
      if (reply.ended) return
      reply.ended = true
      reply.markDone()
      actions.streaming(false)
      fake.doneSignalAt = Date.now()
    }
    const finish = () => {
      renderReply(reply.full)
      signalEnd()
      endReply()
      fake.done = true
    }
    const step = () => {
      const elapsed = Date.now() - t0 - paused
      const p = replyOpts.ms === 0 ? 1 : Math.min(1, elapsed / replyOpts.ms)
      if (p >= 1) {
        finish()
        return
      }
      if (replyOpts.doneLagMs !== null && replyOpts.ms - elapsed <= replyOpts.doneLagMs) signalEnd()
      ticks += 1
      const n = Math.floor(reply.full.length * p)
      const rewind = ticks % REWIND_EVERY === 0 && n > 8
      if (rewind) fake.rewinds += 1
      renderReply(reply.full.slice(0, rewind ? Math.floor(n * REWIND_FACTOR) : n))
      // S9: the stop button blinks out, and the stream pauses, once LULL_AT of the reply is rendered
      if (replyOpts.stopBlinkMs !== null && !blinkDone && p >= LULL_AT) {
        blinkDone = true
        blinkStop()
      }
      if (nextPause < pauses.length && p >= pauses[nextPause].at) {
        const pause = pauses[nextPause]
        nextPause += 1
        const from = Date.now()
        if (fake.lullAt === null) fake.lullAt = from
        const record = { at: from, endAt: null }
        fake.lulls.push(record)
        reply.timer = setTimeout(() => {
          paused += Date.now() - from
          fake.lullEndAt = Date.now()
          record.endAt = fake.lullEndAt
          step()
        }, pause.ms)
        return
      }
      reply.timer = setTimeout(step, RENDER_MS)
    }
    step()
    if (replyOpts.blockAfterMs !== null && fake.replying) {
      setTimeout(() => {
        if (!fake.replying) return
        endReply() // the reply freezes where it is; the banner appears
        showBlockedAlert()
      }, replyOpts.blockAfterMs)
    }
  }

  // --- action slot strategies ---------------------------------------------------------------

  /** The per-site stop button (selectors v2 `stop`, first entry). Clicking it ends the reply where it is. */
  function makeStopButton() {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'stop'
    if (site === 'chatgpt') {
      b.setAttribute('data-testid', 'stop-button')
      b.setAttribute('aria-label', 'Stop streaming')
    } else if (site === 'claude') {
      b.setAttribute('aria-label', 'Stop response')
    } else {
      b.setAttribute('aria-label', 'Stop')
    }
    b.textContent = 'Stop'
    b.addEventListener('click', () => {
      if (reply && fake.replying) {
        endReply()
        fake.done = true
      }
    })
    return b
  }

  /** Record a stop-button transition (window.__fake.stopEvents): the gap must not drop it. */
  function noteStop(on) {
    fake.stopEvents.push({ on, ts: Date.now() })
  }

  /** chatgpt / claude / grok&composer=textarea: one send button, disabled until the model holds text; the stop button takes its place while streaming. */
  function toggleActions(button) {
    const stopButton = makeStopButton()
    let hasText = false
    let streaming = false
    let current = button
    button.disabled = true
    const render = () => {
      const next = streaming ? stopButton : button
      if (next !== current) {
        current.replaceWith(next)
        current = next
      }
      button.disabled = !hasText
    }
    return {
      apply(on) {
        hasText = on
        render()
      },
      streaming(on) {
        if (on !== streaming) noteStop(on)
        streaming = on
        render()
      },
    }
  }

  /**
   * grok (TipTap): like the real page, the slot renders EITHER the voice-mode button (editor
   * empty) OR the submit button (editor holds text) — never a disabled submit button — and the
   * stop button while a reply streams. The submit button therefore does not exist in the DOM until
   * text is in.
   */
  function swapActions(voiceButton) {
    const submitButton = document.createElement('button')
    submitButton.className = 'send'
    submitButton.type = 'submit'
    submitButton.setAttribute('aria-label', 'Submit')
    submitButton.setAttribute('data-testid', 'chat-submit')
    submitButton.textContent = 'Send'
    const stopButton = makeStopButton()
    let hasText = false
    let streaming = false
    let current = voiceButton
    const render = () => {
      const next = streaming ? stopButton : hasText ? submitButton : voiceButton
      if (next === current) return
      current.replaceWith(next)
      current = next
    }
    return {
      apply(on) {
        hasText = on
        render()
      },
      streaming(on) {
        if (on !== streaming) noteStop(on)
        streaming = on
        render()
      },
    }
  }

  // --- ProseMirror look-alike (chatgpt, claude and grok's TipTap editor) --------------------
  function mountProseMirror(el, placeholder) {
    let model = ''
    let editTick = false // a trusted editing event happened since the last frame
    let framePending = false

    function blockText(block) {
      let s = ''
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) s += c.data
          else if (c.nodeName === 'BR') s += '\n'
          else walk(c)
        }
      }
      walk(block)
      if (s.endsWith('\n') && block.lastChild && block.lastChild.nodeName === 'BR') s = s.slice(0, -1)
      return s
    }

    function readDom() {
      const lines = []
      for (const n of el.childNodes) {
        if (n.nodeType === 3) lines.push(n.data)
        else if (n.nodeName === 'BR') lines.push('')
        else lines.push(blockText(n))
      }
      return lines.join('\n')
    }

    function render() {
      const lines = model.split('\n')
      const frag = document.createDocumentFragment()
      lines.forEach((line, i) => {
        const p = document.createElement('p')
        if (i === 0) p.setAttribute('data-placeholder', placeholder)
        if (line === '') p.appendChild(document.createElement('br'))
        else p.textContent = line
        frag.appendChild(p)
      })
      el.replaceChildren(frag)
      el.classList.toggle('is-empty', model === '')
      observer.takeRecords() // our own mutations are not "foreign"
    }

    el.addEventListener('beforeinput', (e) => {
      if (e.isTrusted) editTick = true
    })
    el.addEventListener('input', (e) => {
      if (!e.isTrusted) return // a synthetic input event never carries editor state
      editTick = true
      model = readDom()
      el.classList.toggle('is-empty', model === '')
      onModelChange(model)
    })
    el.addEventListener('keydown', (e) => {
      if (isSubmitKey(e)) {
        e.preventDefault()
        submit()
      }
    })
    const observer = new MutationObserver(() => {
      if (framePending) return
      framePending = true
      requestAnimationFrame(() => {
        framePending = false
        const trusted = editTick
        editTick = false
        if (!trusted && readDom() !== model) render() // reconcile a foreign write away
      })
    })
    observer.observe(el, { childList: true, characterData: true, subtree: true })
    render()

    return {
      el,
      getText: () => model,
      clear() {
        model = ''
        render()
        onModelChange(model)
      },
    }
  }

  // --- React-style tracked textarea ---------------------------------------------------------
  function mountTextarea(ta, placeholder) {
    ta.placeholder = placeholder
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    let tracked = ''
    let model = ''
    Object.defineProperty(ta, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return proto.get.call(this)
      },
      set(v) {
        tracked = String(v)
        proto.set.call(this, v)
      },
    })
    ta.addEventListener('input', () => {
      const v = proto.get.call(ta)
      if (v === tracked) return // the tracker saw no change: no onChange
      tracked = v
      model = v
      onModelChange(model)
    })
    ta.addEventListener('keydown', (e) => {
      if (isSubmitKey(e)) {
        e.preventDefault()
        submit()
      }
    })
    return {
      el: ta,
      getText: () => model,
      clear() {
        ta.value = ''
        model = ''
        onModelChange(model)
      },
    }
  }

  // --- per-site composer (markup from the <template>s in index.html) -----------------------
  function mountComposer() {
    const box = clone(variant === 'textarea' ? 'tpl-grok-textarea' : 'tpl-' + site)
    if (variant === 'textarea') {
      composer = mountTextarea(box.querySelector("textarea[aria-label='Ask Grok anything']"), cfg.placeholder)
    } else {
      composer = mountProseMirror(box.querySelector('.ProseMirror'), cfg.placeholder)
    }
    const voice = box.querySelector('button.voice')
    const button = box.querySelector('button.send')
    actions = voice ? swapActions(voice) : toggleActions(button)
    if (box.tagName === 'FORM') {
      box.addEventListener('submit', (e) => {
        e.preventDefault()
        submit()
      })
    } else {
      button.addEventListener('click', submit)
    }
    app.appendChild(box)
  }

  if (state === 'slow') {
    const note = document.createElement('div')
    note.className = 'mounting'
    note.textContent = 'Loading…'
    app.appendChild(note)
    setTimeout(() => {
      note.remove()
      mountComposer()
    }, 3000)
  } else {
    mountComposer()
  }
})()
