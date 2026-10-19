# DOM fixtures (hand-built, scrubbed shape) — Stage 3, workstream `capture-hardening`

Twelve fixtures at first: `<site>-<state>.html` for `chatgpt` / `claude` / `grok` × `composer` / `streaming`
/ `done` / `logged-out` — since 2026-10-17 `gemini` too (five files, HAND-BUILT from public sources, see the last
section), plus the measured extras listed further down. They exist so the selector cascades of `desktop/preload/site.cjs`
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
  data-message-author-role data-lexical-editor type disabled placeholder translate`, and since 2026-10-17
  `data-test-id fonticon` — Google's own test attribute and a `mat-icon`'s glyph name), every text
  node replaced by `…`, no `script`/`style`/`link`/`meta`/`img`/`svg`/`iframe`/`video`/`audio`.
  `test/unit/preload/fixture-lint.test.js` enforces that shape, and the lint (`@`, `/c/`, `/chat/`,
  a uuid, `googleusercontent`, `x.com/`; since 2026-10-17 gemini's `/app/<id>` / `/gem/<id>` and a
  `Google Account: <name>` label — `scrubValue` leaves `Google Account: name`) on top of it.
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
| claude reply text: `assistantText` is `[".prose"]` (S8). That a `.prose` element inside `.font-claude-response` holds the answer is **measured** (2026-09-17 probe: 2717 of the container's 2754 innerText characters); that it is the *same div* as the markdown grid is the fixtures' own hand-built guess — they carry `div.grid-cols-1.grid.gap-2.5.prose`. The entry cannot truncate a capture into nothing: `replyText` joins EVERY `.prose` match and falls back to the whole container when none matches | body measured, its exact element hand-built |
| claude code block: a header div before the `pre`, `code.language-xxx`, copy button after it | unverified |
| claude logged out: `button[data-testid=login-with-google]` | unverified |
| grok assistant (`div[id^=response-]`), text (`.response-content-markdown`), stop (`button[aria-label=Stop]`), user bubble (`.message-bubble`) | unverified |
| grok code block: a header row (language + copy button) before the `pre` | unverified |
| grok logged out: sign-in links only (see consequence 1) | unverified |
| gemini — the five `gemini-*.html` (composer, logged-out, streaming, done, thinking) | **HAND-BUILT FROM PUBLIC SOURCES (2026-10-17)**, nothing measured by this app — see the gemini section |
| gemini — `gemini-oct18-pending.html`: the composer's first entry, the stop control `button[aria-label='Stop response']`, the `user-query` turn, the `pending-response` row while the model thinks | **measured** (2026-10-18), the first real gemini page — see the last section |

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

## The claude reply shape, measured 2026-09-18 (why `assistantText` stopped being empty)

A real Send captured claude.ai's answer correctly but with its FIRST line — claude's thinking summary
— in front of it **twice** (the persisted SendTurn of conversation `413b0a4a`, 467 characters):

```
Choosing the strongest language for safety-critical flight control.

Choosing the strongest language for safety-critical flight control.

**Ada/SPARK**

SPARK can formally prove the absence of runtime errors …
```

Two web-search turns of the same session doubled the widget's tool label the same way
(`Searched the webBosch BMI088 gyroscope range ±2000 dps datasheet` / `Searched the web` / the answer,
and `Searched the web` / `Searched the web` / the answer). chatgpt (381 chars) and grok (394 chars)
captured cleanly in the same run, so it is claude-specific.

What it is: `observe` reads ONE container per sample, and a single `toMarkdown` pass renders every
node exactly once — so the line is in the DOM twice (the row on screen plus the collapsed panel's own
copy; a panel collapsed by height or clip is not `display:none`, `visibility:hidden`, `hidden` or
`aria-hidden`, the only four things the walk drops). With `claude.assistantText` EMPTY, `replyText`
fell through to the whole `.font-claude-response` container, so the widget rode along. It is NOT two
`assistant` entries matching a parent and a child: `assistantContainers()` de-duplicates by identity
and `observe` follows exactly one node (the last fresh one in document order), so a nested pair would
truncate a capture, never double it — and the 2026-09-17 probe found exactly one match anyway
(`.font-claude-message` matched nothing).

The fix reads the body from `.prose` — the element the same probe measured holding 2717 of the
container's 2754 characters — so the widget is out of the capture by STRUCTURE, never by matching the
text of a "thinking" line, and the cascade fallback keeps the whole container whenever `.prose` is
absent: the rule can hand back a duplicated header again, it can never drop the answer. The shape is
replayed offline by the fake site's `?thinking=1` (claude) and pinned by
`test/adapters/observe.spec.js`, `test/unit/preload/markdown.test.js` and `fixtures.test.js`.

NOT verified, still: what claude's widget looks like WHILE it streams, and whether the second copy is
the collapsed panel, an `aria-live` announcement or a transition leftover — that needs devtools on a
live reply. The fix does not depend on which of them it is.

## The fenced-reply capture defect, measured 2026-09-18 (why a `done` match inside the message body never counts)

A real Analyze against the hidden chatgpt analyst view degraded with
`parse_error: no JSON object found in the response (output may be truncated)`, and its two persisted raw
attempts were, complete (conversation `17f7b1b1`, turn `17c8e7d5`):

```
attempt 1 (13 chars)  ```JSON\n{\n```
attempt 2 (6 chars)   {"agre
```

Both are FRAGMENTS of a reply that was still streaming, and the same Send captured all three panes in
full (claude 3001, chatgpt 12049, grok 5244 characters): only the analyst truncated. The 13 characters
are not what a model types — they are what `toMarkdown` makes of a code block whose body is one `{`,
with the block's header ("JSON") folded in as the fence language. What changed the day before: the
analyst prompt began asking a `web:` model for a ```json fence (commit e13bb50, because a rendered
paragraph eats backslash escapes), so chatgpt now opens a CODE BLOCK at the first character of the
analyst's answer — and it renders a copy control on a code block as soon as the block appears.

`observe` accepted that control as the turn's done marker: `findDone` asked only for a match that is
the container, inside it, or after it (`onOrAfter`), and the copy control is inside it. Running the
pre-fix `site.cjs` over exactly that DOM reproduces the artifact byte for byte — `doneBy:
done_selector`, 13 characters, `"```JSON\n{\n```"` — which is what turned the hypothesis into the cause.
The end signal also used to be LATCHED: once seen it was never reconsidered, so the capture resolved at
the first ~100 ms lull in the render even while the model kept typing (attempt 2 holds no code block at
all, so its end signal was a `stop_gone` latched from one sample that missed the stop button).

The two rules that follow, pinned by `test/unit/preload/observe.test.js` (a deterministic clock) and
`test/adapters/observe.spec.js` (real CSS and timers, the fake site's `?codeCopyDone` / `?stopBlinkMs` /
`?lullMs` / `?reply=openfence`):

1. a `done` match inside the reply BODY is not a turn marker — not inside an `assistantText` block, not
   inside a `pre`/`code`. Chrome is outside the message on all three sites: chatgpt's action bar is a
   sibling of `.markdown` inside the article (`chatgpt-done.html`), claude's `action-bar-copy` sits
   outside `.prose`, grok's copy controls outside `.response-content-markdown`. A container with no body
   element (the placeholder turn) keeps its old behaviour — only the `pre`/`code` half applies.
2. no end signal is latched: every sample re-reads the stop button and a visible one WITHDRAWS a pending
   `done_selector` / `stop_gone` / `quiet`, and the settle window is four throttle ticks (400 ms), not
   one — a 100 ms gap between two token batches is ordinary mid-stream. The tolerance for a stop button
   a sample missed is therefore that settle window.

NOT verified, deliberately: whether chatgpt's code-block copy button really carries
`data-testid="copy-turn-action-button"` (the row above still says unverified; the fake site mounts it
only under `?codeCopyDone=1`). The rule does not depend on it — a copy control inside the message is
never the end of the turn whatever its testid — and rule 1 makes that markup harmless either way.

Open, and worth one live reading: the ordering in `observe` means a visible stop button SUPPRESSES the
done check, so at the sample that ended each of those captures `findStop()` returned null while the
model was still typing. Whether that is a transient miss (a re-render, an animated swap) or a
persistent one (the analyst view is `setVisible(false)`, so its layout may not answer `isVisible`) is
not decidable offline: read `panes:analyst.health.stop` while the analyst streams. If it never goes
true, the analyst's only end signal is `quiet`, and the follow-up is a per-view `quietMs` (contract §4),
not another rule here.


## chatgpt-thinking.html, chatgpt-effort-streaming.html (2026-09-27)

Two failed captures' own snapshots (`snapshots/chatgpt-failed-<ts>.html`, Part 0) of the layout
chatgpt.com ships with its composer effort picker. There are no `data-message-*` attributes any
more: a user turn is `group/user-message`, an assistant turn is the exchange's turn group
`div.group.flex.flex-col.pb-2.pt-2` (there from the submit on; its `block-<hash>` children are the user
message, a thinking header that only ever reads "Worked for Ns", and — once the answer starts — the
answer block whose `div.group.flex.min-w-0.flex-col > [class*='MarkdownRoot-']` is the reply text), the stop control is `button[aria-label='Stop']`, and the
finished turn's action bar carries `Rate response`, the done marker. `thinking` is 108 s into the
first reply of a fresh chat: the body is mounted and EMPTY while the site works (the S10 shape).
`effort-streaming` is one turn later: the first reply finished, the second streaming, six message
matches for two turn pairs. Neither snapshot shows a send button (the site was working both times),
so the `send` cascade is still measured only on the older layout.

## claude-virtualized.html, chatgpt-virtualized.html, grok-virtualized.html (2026-09-27)

The newest failed pane capture of each site from one afternoon's Fusion runs (`snapshots/<site>-failed-<ts>.html`,
42 failures in all, every one with the site's stop control seen), pruned to the transcript and the composer
region: the ancestors that carry `id`/`class`/`role`/`data-testid`, every mounted row, its reply body and its
action bar, the composer and its send/voice control; everything else dropped, and a kept leaf holding one
`…`. They pin what the failures measured — once a chat is long every site keeps a **fixed window** of rows
mounted and unmounts the oldest as the new one mounts, so `countAssistant()` never rises:

| fixture | mounted vs actual | structure |
|---|---|---|
| `claude-virtualized` | 9 `transcript-row`s of ~58: 5 `.font-claude-response` + 4 `[data-testid=user-message]` | `transcript-list > [role=feed] > transcript-sizer`: `[spacer] [A = the FIRST reply, pinned] [spacer] [U A U A U A U A] [spacer]`; the assistant rows carry `[data-testid=assistant-message]`, the send control is `button[data-testid=chat-input-send][aria-label="Send message"]` — the new first `send` entry |
| `chatgpt-virtualized` | 5 `div.group.flex.flex-col.pb-2.pt-2` of ~29 exchanges | each group is ONE exchange: two nested `group/user-message` wrappers around `div.whitespace-pre-wrap` (the prompt), one `MarkdownRoot-` (the answer), one `button[aria-label='Rate response']`; oldest first, newest last; still no `data-message-*` attribute, no `.markdown`, no `#prompt-textarea`, no send button |
| `grok-virtualized` | 7 `div[id^='response-']` of ~58 rows: 4 `[data-testid=assistant-message]` + 3 `[data-testid=user-message]` | `[data-testid=chat-transcript-scroller]` > one `div.absolute.inset-x-0.top-0` slot per row; **document order is NEWEST-FIRST**; the bare `div[id^='response-']` matches the user's rows too, `div[id^='response-']:has([data-testid='assistant-message'])` — the new first `assistant` entry — exactly the four replies |

What `test/unit/preload/virtualized.test.js` pins on them: the corrected `assistant` cascade counts 4 on grok
(7 before); a chatgpt group's reply body is its `MarkdownRoot-` and the scoped `.whitespace-pre-wrap` entry
matches nothing inside a user turn; claude's 5 responses and 4 user turns; and the ADJACENCY step of the
anchor rule (`containerForAnchor`) handed a user-turn element directly — the exchange group that holds it on
chatgpt, the row after it on claude, the row BEFORE it on grok — because the text nodes are `…`, so matching
a typed prompt to a turn (the anchor rule proper) is the fake site's and `test/adapters/virtualized.spec.js`'s
job. Health: every page was settled when the failure was saved, so there is no stop control in any of them.

These are what `Save DOM snapshot` / a failed capture writes, so they are scrubbed by construction; the
pruning kept attributes only, never added one, and the lint and the fixed-point test run over them like
over every other fixture.

## chatgpt-oct10-done.html, claude-oct10-status.html (2026-10-10)

The morning's two failed pane captures (`snapshots/chatgpt-failed-1791645173560.html`,
`snapshots/claude-failed-1791645174374.html`; both diag lines read `containers=0 … stopSeen=true` — the
sites had replied, and every reply-container selector matched nothing), pruned to the transcript and the
composer the way the `*-virtualized` fixtures were. Dropped on the way, because none of it is under a kept
ancestor: chatgpt's sidebar (`div[role=group][aria-label=<the prompt>]`, the chat titles), its minimized
quick-chat `section[role=dialog]` and the arXiv citation `aria-label`; claude's thirty `More options for
<title>` buttons, the model label and the "Desktop … Connected" label. The two `<form>`s on chatgpt are
reduced to the one holding the composer.

| fixture | what it shows | health |
|---|---|---|
| `chatgpt-oct10-done` | one FINISHED exchange. The group is a bare `div.group.flex.flex-col` — `pb-2 pt-2` are gone — and that triple also matches the answer's inner `div.group.flex.min-w-0.flex-col` wrapper (2 matches on the page), so the group is identified through the USER TURN it holds: `div.group.flex.flex-col:has([class~='group/user-message'])`, the new first `assistant` entry (identical to the old entry on every Sept-27 fixture: 1 / 2 / 5). Inside: the nested `group/user-message` pair around `div.text-size-chat.whitespace-pre-wrap`, the answer's `MarkdownRoot-` under `div.group.flex.min-w-0.flex-col`, and the finished turn's action bar with `button[aria-label='Rate response']`. The MarkdownRoot body is kept VERBATIM — 2,624 elements, 888 text nodes (headings, lists, tables, KaTeX math), on ONE line as `scrubDom` emits it, so the file stays ~100 KB — because the capture pin is its text: `replyText` renders 628 `…` runs. No stop control (the reply had ended), no send button (an empty composer never shows one: `send` is still unmeasured on this layout), composer entry 1 (`div[contenteditable='true'].ProseMirror`; no `#prompt-textarea`) | `{composer 1, send null, reply 0, stop null, messages 3, assistant 1}` |
| `claude-oct10-status` | the claude.ai REDESIGN, caught in its STATUS phase: `transcript-list > [role=feed] > transcript-sizer > [transcript-leading] [spacer] [row U] [row A] [spacer]`. The assistant row is `div[data-testid=assistant-message]` — `.font-claude-response`, `.prose` and `.standard-markdown` match NOTHING on this page — holding only the `group/status` widget (`span[data-testid=TurnStatusClayMark]`, the label, a `.tabular-nums` timer, an sr-only `[role=status]`) and an `invisible` `[data-testid=message-actions]` wrapper with the sr-only "Show message actions" button: no reply body mounted. The user row is `div.cds-user-message-body > div[data-testid=user-message] > p.whitespace-pre-wrap`, with its `[role=toolbar]` (`user-message-edit`, Copy) and `failed-send-status-region`. The composer is `div[data-testid=chat-input][contenteditable][role=textbox].tiptap.ProseMirror` inside a `fieldset`, and the stop control `button[data-testid=chat-input-stop][aria-label="Stop response"]` sits where `chat-input-send` sits on a settled page (they swap in the same slot) | `{composer 0, send null, reply 0, stop 0, messages 2, assistant 1}` |

What `fixtures.test.js` pins on them (the 2026-10-10 tests at its end): on both, `countAssistant()` is 1,
`userTurns()` is 1 and `containerForAnchor(turn)` is that one container (chatgpt: the group that holds the turn;
claude: the row after it); chatgpt's `findDone` is "Rate response" and its `replyText` has 628 `…` runs through
the MarkdownRoot; claude's `findStop` is `chat-input-stop`, its `replyBlocks` are empty (so `replyText` falls back
to the whole row — the status widget), and `findDone` is null here while it is
`[data-testid='message-actions'] button[data-testid^='action-bar-']` on every settled row of `claude-virtualized`.

Measured, and carried into `DEFAULT_SELECTORS` additively (older entries stay behind the new first entry):
chatgpt `assistant` gains the `:has` entry first; claude `assistant` gains `[data-testid='assistant-message']`
first, `stop` gains `button[data-testid='chat-input-stop']` first, `done` is the settled row's action bar, and
`assistantText` gains `.standard-markdown` as a fallback behind `.prose`. The generic `MESSAGE_SELECTORS` and
`ASSISTANT_SELECTORS` gain the chatgpt `:has` entry and `[data-testid='assistant-message']`; the bare grok
`div[id^='response-']` left `ASSISTANT_SELECTORS` and grok's own cascade (a row without a bubble has nothing
to capture, and on a fresh chat that entry made the user's OWN row the reply container). The consequences for
the older fixtures: `claude-virtualized` counts 14 messages (its five `assistant-message` rows), the `reply`
entry indices move (chatgpt-streaming / -done 0 → 1, chatgpt-thinking / -effort-streaming / -virtualized 1 → 0,
claude-streaming / -done 0 → 1, claude-streaming `stop` 0 → 1), and the hand-built `grok-streaming` /
`grok-done` rows now wrap their markdown in the measured bubble
(`div[role=article][aria-label=Grok][data-testid=assistant-message].message-bubble`) — one more
`.message-bubble` each for `countMessages` (2 → 3) — because nothing matches a bubble-less row any more.
`grok-virtualized` stays at 14 messages: its bubbles carry the same testid, but each IS the `.message-bubble`
already counted, and `countMessages` de-duplicates by node.

UNMEASURED, deliberately said so: the claude reply BODY wrapper after the redesign. The only snapshot died in
the status phase, before any markdown mounted, so `.prose` (and `.standard-markdown` behind it) is a carry-over
from the Sept-27 settled rows, not a measurement; `replyText` falls back to the whole `assistant-message` when
both miss, which would carry the status row's "Thought for Ns" and the action-bar labels along (the S8
duplicate-chrome family). A *Save DOM snapshot* of a settled claude reply is the one reading that settles it.
Also still unmeasured: chatgpt's send button on this layout (every snapshot has an empty composer), and
claude's `done` marker DURING body streaming (it is absent in the status phase and present on every settled
row; a visible stop control outranks it either way).

## grok-oct11-fresh.html (2026-10-11)

A plain Send's failed pane capture on a FRESH grok.com chat (`snapshots/grok-failed-1791751097135.html`; the diag
read `containers=1 followed=- connected=false anchor=1 order=newest presubmit=0 stopNow=false stopSeen=true … reply=0
… maxContainer=6865` — the anchor matched the one user turn, exactly one assistant container held the 6,865-character
reply, and it was never followed; claude and chatgpt captured in the same Send), pruned to the scroller and the
composer the way the `*-virtualized` fixtures were. What it shows: inside `[data-testid=chat-transcript-scroller] >
div.relative` **four** `div.absolute.inset-x-0.top-0` slots — an empty one, the USER row (`div[id^=response-]` holding
`[data-testid=user-message]`), the ASSISTANT row (`[data-testid=assistant-message]` with its `thinking-container`, its
`.response-content-markdown` and the `last-response` action bar), an empty one — in **OLDEST-first** document order,
where `grok-virtualized`'s 58-row chat read newest-first. grok.com's virtualizer reuses a POOL of absolutely
positioned slots and places each row by transform, so the DOM order carries no transcript order at all; no `style`
attribute survives `scrubDom` (`SNAPSHOT_KEEP_ATTRS`), so the fixture cannot show the transforms — the live page has
them. The composer is the measured TipTap editor (entry 0) with the voice button in the action slot (an empty
composer never shows submit), and the page was settled: no stop control.

| fixture | health | what `test/unit/preload/geometry.test.js` pins |
|---|---|---|
| `grok-oct11-fresh` | `{composer 0, send null, reply 0, stop null, session ok, messages 4, assistant 1}` — the two rows and their two bubbles are the four messages | the slot order `- U A -`; with no rects (the unit DOM has no layout) and `transcriptOrder: 'newest-first'`, `containerForAnchor(userTurn)` is **null** — the bug: rule (b) stepped backwards from the anchor and found nothing — and an observe on that page (the prompt and a reply written into the parsed bubbles, since the scrubbed text is `…`) still captures, through the fall-through: an anchored turn with no container on its reply side takes the identity + text rule over the containers that are neither its holder nor its own row. In a real browser the geometry decides first — the laid-out row below the prompt — which `test/adapters/geometry.spec.js` drives on the grok look-alike's `?order=forward` (that DOM shape) and `?order=shuffle`. |

Carried into `site.cjs` (the capture section, dated): `transcriptOrder` is the DOM **fallback** direction only; the
diag line gained `geom=<yes|no|->` after `order=`.

## gemini-composer / -logged-out / -streaming / -done / -thinking.html (2026-10-17) — HAND-BUILT, not recorded

**These five are NOT snapshots.** gemini.google.com joined as the fourth site on 2026-10-17 and nobody had captured it
through this app yet, so the files were written by hand from public sources dated 2026-08…10-17 — the voyager
extension's turn selectors and its Oct-2026 menu fixture, the a8s-gemini-web driver's UI notes (2026-09-23/24), the
CDP-measured selectors of an Electron 44 Gemini embed (2026-08-21), and three exporter userscripts — the same sources
`DEFAULT_SELECTORS.gemini` is seeded from, and just as UNMEASURED. They are still a fixed point of `scrubDom` and pass the
lint, like every fixture here. **Replace each with a pruned real snapshot after the first live capture** (menu → *Save
DOM snapshot*, or the `gemini-failed-*` / `gemini-suspect-*` files a failed or suspect capture saves by itself), update
`EXPECTED` in `test/unit/preload/fixtures.test.js`, and move the measured entries into `DEFAULT_SELECTORS.gemini` with
dated comments.

| fixture | what it shows | health |
|---|---|---|
| `gemini-composer` | a fresh `/app`: `rich-textarea > div.ql-editor[contenteditable][role=textbox]` beside Quill's contenteditable `div.ql-clipboard`, the microphone in the send slot, and the signed-in header's account button (`a[aria-label='Google Account: name']` — the scrubbed label) | `{composer 0, send null, reply null, stop null, session ok, messages 0, assistant 0}` |
| `gemini-logged-out` | GUEST MODE: the same working composer, and a header `a[aria-label='Sign in']` — its `href` (`accounts.google.com/ServiceLogin…`) is scrubbed away, so the cascade's aria-label entry (2) is what matches offline; live, the href entries match first | `{composer 0, send null, reply null, stop null, session logged_out, …}` — a composer AND logged_out |
| `gemini-streaming` | one `div.conversation-container` holding the `user-query` (a `cdk-visually-hidden` "You said" label, `.query-text`) and the `model-response` (its own label, `message-content > div.markdown.markdown-main-panel`), the stop control in the send slot | `{composer 0, send null, reply 0, stop 0, session ok, messages 2, assistant 1}` |
| `gemini-done` | the finished turn's `message-actions` (Good response / Bad response / Copy, each with its `mat-icon fonticon`), a copy button (`data-test-id=copy-button`) on the user's own query, a `code-block` CUSTOM element around the fence, text back in the composer | `{composer 0, send 0, reply 0, stop null, session ok, messages 2, assistant 1}` |
| `gemini-thinking` | an EXPANDED `model-thoughts` panel whose `[data-test-id=thoughts-content]` renders its OWN `message-content > div.markdown.markdown-main-panel` before the answer's, while the answer streams | `{composer 0, send null, reply 0, stop 0, session ok, messages 2, assistant 1}` |

What `test/unit/preload/fixtures.test.js` pins on them: no composer entry can reach the clipboard decoy; the account
button is no wall and guest mode is one; the anchor rule pairs the `user-query` with its `model-response` and the
exchange box is never a container; the body cascade (`.markdown-main-panel:not(model-thoughts *):not(.thoughts-container *)`
and the second entry) reads the answer alone, while an unscoped `.markdown-main-panel` would read the thoughts in front of
it — and (2026-10-17 review) when the body cascade MISSES altogether, the turn-level fallback still reads the answer alone,
the thinking panel and the `cdk-visually-hidden` "Gemini said" label left out (`turnChrome`, which nothing in a claude /
chatgpt / grok fixture carries); an invisible reCAPTCHA frame added to `gemini-composer` leaves the session ok; the thumbs-up
is the done marker, never a copy button; and the `code-block` custom element is read as a BLOCK (since 2026-10-17
`toMarkdown` treats a hyphenated tag that holds a block as one — before that the whole fence collapsed into one inline
code span). The scrubbed header text `…` stays a stray paragraph, as on claude and grok (consequence 3), and the fence
has no language: the code carries no class and the header's token is scrubbed.

## chatgpt-oct18-unmounted-user.html, gemini-oct18-pending.html (2026-10-18)

The day's two failed pane captures, pruned the way the `*-virtualized` and `*-oct10` fixtures were. `gemini-oct18-pending`
is the **first real gemini page** this app has saved — the five hand-built `gemini-*` files above stay until a settled
reply, a guest-mode page and a thinking panel are captured too.

| fixture | what it shows | health |
|---|---|---|
| `chatgpt-oct18-unmounted-user` | `snapshots/chatgpt-failed-1792360840977.html` (diag `containers=0 followed=- connected=false anchor=0 … presubmit=0 stopNow=true stopSeen=true … reply=0 … viewport=413×803`): a 9-minute reply in a 413 px pane — four panes in split mode — had scrolled the prompt far out of view, and chatgpt.com's virtualizer had UNMOUNTED the exchange's USER block. The one `div.group.flex.flex-col` holds only two `block-<hash>` wrappers — the activity header (`group/activity-header`, the "Thought for …" row) and the answer (`h4.sr-only` + `div.group.flex.min-w-0.flex-col > MarkdownRoot-`) — so the 10-10 entry `div.group.flex.flex-col:has([class~='group/user-message'])` matches NOTHING and the new first entry `div.group.flex.flex-col:has([class^='block-'])` matches the group (measured in Chrome on every chatgpt page since 2026-09-27: the same count as the user-turn entry everywhere, 1 here where it is 0, 0 on the data-attribute layout). Still answering: the composer's stop control is the plain "Stop" (entry 3), no send button, no "Rate response". Pruned to the Conversation region and the composer form; the MarkdownRoot is cut to its first six blocks and its citation links are dropped (their labels carried the chat's topic and source URLs) | `{composer 1, send null, reply 0, stop 3, session ok, messages 1, assistant 1}` |
| `gemini-oct18-pending` | `snapshots/gemini-failed-1792365237747.html` (diag `containers=0 followed=- connected=false anchor=1 … stopNow=true stopSeen=true … viewport=413×803`, `reply_not_found` after the 90 s first-row deadline): Argon still THINKING. `#chat-history > infinite-scroller[data-test-id=chat-history-container] > pending-request.conversation-container.first-prompt` holding the `user-query` (its `cdk-visually-hidden` "You said" label, `p.query-text-line`, the Copy / Edit prompt buttons), a `thinking-dots-animation` and a text-free `pending-response > response-container` (header, `presented-response-container`, footer) — there is no `model-response` anywhere until the answer comes. The composer is the seeded first entry (`rich-textarea div.ql-editor[contenteditable='true']`, aria-label "Enter a prompt for Gemini") and the stop control `button[aria-label='Stop response']` (entry 0) — both now measured, as is the `user-query` anchor. Pruned to the chat history and the input area: the side navigation (the user's conversation titles) and the header (`Google Account: name`, the model-picker label) are gone | `{composer 0, send null, reply 0, stop 0, session ok, messages 2, assistant 1}` |

What `test/unit/preload/fixtures.test.js` pins on them: the group-by-block entry finds the chatgpt group the user-turn entry
cannot, no user turn is left on that page, the body is the MarkdownRoot and no done marker exists yet; the gemini pending
row is the container (`assistant: ['model-response, pending-response']`, ONE entry because the cascade is first-entry-wins),
the `user-query` anchors it and it holds no text. `test/unit/preload/virtualized.test.js` drives the lifecycles over a fake
clock: a chatgpt group re-rendered without its user block mid-reply is still captured (the 10-10 cascade times out with
`containers=0`), a re-read scrolls the newest group into view so the prompt remounts (`reveal`), and a gemini reply that
thinks past the first-row deadline in its pending row is waited out and then read from the fresh `model-response` (the
10-17 cascade answers `reply_not_found`). The fake site replays both in real Chrome: `?chatgptLayout=group&dropUserMs=N`
(`test/adapters/exchange.spec.js`) and `?site=gemini&thinkMs=N` (`test/adapters/observe.spec.js`).
