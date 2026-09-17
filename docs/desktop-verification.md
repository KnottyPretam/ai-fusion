# Desktop verification checklist (logged-in, manual)

The 28 live checks from the pivot plan's Stage 4 (`docs/desktop-contract.md` is the contract they
verify). Items 1–14 are run at the Stage 1 gate (tag `S5`), 15–22 at Stage 2 (`S6`), 23–28 at Stage 3
(`S7`), and all 28 again in Stage 4 (`S8`), where the user walks the list with `scripts/desktop.sh`.
Offline tests cannot retire these — they are the Google-SSO / Turnstile / live-composer / GPU-390 /
terms-of-service questions — so every row is filled by a human on this box. An item passes, fails, or
carries a documented caveat; a stage gate needs every row of that stage to be pass-or-caveat. Rows are
appended, never rewritten: a re-run adds a new dated row for the same item (copy the row, keep the item
text), so the table is the history of what was seen on which day.

| item | stage gate | date | site | outcome | matched selectors | slot_error code | notes |
|---|---|---|---|---|---|---|---|
| 1. `cd desktop && npm ci` on this box; `chrome://gpu` recorded; `TRIPLEX_CHROMIUM_FLAGS` decision recorded. | S5 2026-09-16 | all | pass | — | — | Electron 44.4.1 via `npm ci` + `node node_modules/electron/install.js`; GPU software-only on NVIDIA 390 (no flag helps); `TRIPLEX_CHROMIUM_FLAGS` empty (docs/decisions.md S4) |
| 2. Window opens with three login pages; a pane devtools `navigator.userAgent` contains `Electron/44`. | S5 2026-09-16 | all | pass | — | — | three login pages loaded, no Cloudflare challenge; `webContents.getUserAgent()` = `… Chrome/152.0.7977.78 Electron/44.4.1 Safari/537.36` (probe) |
| 3. Log in to ChatGPT with "Continue with Google" → popup opens, completes, closes; same for Claude (Google) and Grok (X or Google). If Google rejects or Turnstile loops: email/password; record; never change the UA. | S5 2026-09-16 | all | pass | — | — | user signed in on all three (SSO path used not recorded); no rejection or Turnstile loop reported |
| 4. Restart → all three still logged in. | S5 2026-09-16 | grok | pass | — | — | a fresh Electron launch on the same profile loaded grok.com signed in (composer + Submit present); claude/chatgpt to confirm on the next relaunch |
| 5. Health chips `composer ✓ send ✓ · signed in` on all three; `title` shows the matched cascade entry; a miss is fixed via `~/.config/triplex-desktop/selectors.json` + Reload and the corrected default committed. | S5 2026-09-16 | grok | fail | composer=`textarea` (a hidden 14 px helper), send=none | — | grok.com's composer is `div.tiptap.ProseMirror[contenteditable][role=textbox][aria-label="Ask Grok anything"]`; its `button[type=submit][aria-label=Submit][data-testid=chat-submit]` only exists once the editor has text → cascade corrected in the default (see S5 fixes) |
| 6. Split mode: "Reply with exactly: PING-1" → Send → every composer filled and submitted; replies appear in each site's own GUI; result line ✓ ms + selector per site. | S5 2026-09-16 | claude, chatgpt | pass | — | — | user report: prompt typed and submitted, replies appeared in both GUIs |
| 6. (grok) re-run after the cascade fix | S5 | 2026-09-16 | grok | fail | composer=`textarea` (hidden) | — | user report: never submitted — text landed in the hidden helper textarea; fixed by the grok composer/send cascade change |
| 7. Tabs mode: switch between panes while replies stream; return → reply present; badge on a hidden pane needing attention. | S5 | | | | | | |
| 8. Edge text: backticks, quotes, `${}`, multi-line via Shift+Enter, ~3000 chars, emoji, a `/`-leading line → verbatim in all three. | S5 | | | | | | |
| 9. Use a site directly (type in its composer, change its model picker) → works; a unified send afterwards continues that site's current chat. | S5 | | | | | | |
| 10. New chat per pane, New chat everywhere, Reload, Open externally, zoom −/+/reset (persisted after restart), Ctrl+1/2/3, `Ctrl+\`, Ctrl+L, Ctrl+Shift+N, Ctrl+=/-/0, Ctrl+R. | S5 | | | | | | |
| 11. Resize the window and switch modes repeatedly → no renderer chrome under a view, no stale view visible; window bounds restored after relaunch. | S5 | | | | | | |
| 12. Sign out of one site in-page → chip shows SIGN IN; a Send yields `logged_out` for that slot with no DOM write; Sign out of `<site>` menu item clears only that partition. | S5 | | | | | | |
| 13. Any Cloudflare/Turnstile challenge → pane revealed, turn fails fast with `challenge`, solving by hand restores health; record site/when. | S5 | | | | | | |
| 14. Focus returns to the prompt bar after Send. | S5 | | | | | | |
| 15. Backend spawned by Electron: `GET /api/bridge/status` connected within 5 s; kill the backend → banner; restart → reconnects. | S6 | | | | | | |
| 16. Send with capture off → `GET /api/conversations/{id}` shows `errors.<slot>` = "capture is off…", empty threads; sidebar lists it. | S6 | | | | | | |
| 17. Capture on for one site → `responses.<slot>` equals the pane's reply; thread has the `[user, assistant]` pair; the others `not_captured`. | S6 | | | | | | |
| 18. Capture on for all three → three responses; Captured tab matches the panes; the meter shows latency/calls only. | S6 | | | | | | |
| 19. `chats.json` holds the three chat URLs; select an older conversation → panes navigate to its chats; a Send continues them; New conversation → fresh chats. | S6 | | | | | | |
| 20. Unchecked target → that site untouched, `turn_start.slots` lists the subset, Analyze reports it missing. | S6 | | | | | | |
| 21. Break a selector in `selectors.json` → chip red within 2 s without restart; restore. | S6 | | | | | | |
| 22. Start a unified Send while a site is still replying to a manual prompt → `view_busy` for that slot, others proceed. | S6 | | | | | | |
| 23. Analyst = ChatGPT web session (default) → Analyze produces a report; reveal the analyst tab and confirm a fresh chat per Analyze and only R1/R2/R3 in what was typed. | S7 | | | | | | |
| 24. Fusion with 1 iteration → challenges typed visibly into the three panes, JSON replies captured, stances shown; the retry path observed at least once. | S7 | | | | | | |
| 25. Analyst = `ollama:hermes3` → Analyze produces a report or degrades cleanly with raw attempts shown. | S7 | | | | | | |
| 26. Analyst unset → Analyze disabled with the hint; a pre-pivot conversation (OpenRouter models) → Send yields `transport_disabled`, nothing reaches OpenRouter. | S7 | | | | | | |
| 27. Rate-limit / "Unusual activity" observed? → recorded; no automatic retry happened. | S7 | | | | | | |
| 28. Read stop/done selectors for claude.ai and grok.com from devtools; record them. | S7 | | | | | | |

## How to record

Per item, fill the item's row (a re-run appends a new dated row for the same item) (one row per site when the item spans sites — `site` is `chatgpt`,
`claude`, `grok`, `analyst` or `all`): **date** (ISO, `2026-09-16`); **outcome** `pass`, `fail`, or
`caveat: <one line>` (a caveat is a pass with a documented workaround, e.g. "Google popup rejected →
email/password"); **matched selectors** = the `matched` names the health chip's `title` shows for that
site (`composer` / `send`, and from Stage 2 `reply` / `stop` — e.g. `#prompt-textarea`,
`button[data-testid='send-button']`), which is how selector rot is spotted; **slot_error code** = the
code from the result line or the `slot_error` event when the item produced one (`logged_out`,
`challenge`, `blocked`, `view_busy`, `not_captured`, `send_not_found`, `transport_disabled`, …), empty
otherwise; **notes** = what was done and what was seen (the `selectors.json` edit that fixed a miss and
the corrected default that was committed; whether the sign-in went through the Google popup or by
email/password; the site and time of a Cloudflare challenge or an "Unusual activity" notice; the
devtools readings for item 28 verbatim). The UA is never changed to make an item pass. Item 1's
`chrome://gpu` result, the spike result and the chosen `TRIPLEX_CHROMIUM_FLAGS` go into the desktop
build log in `docs/decisions.md`, with a pointer from the row.

DOM snapshots: for each site, in the **composer** (idle, signed in), **streaming** (stop button
visible), **done** (reply complete) and **logged-out** states, use the menu item *Save DOM snapshot*
(`panes:snapshot`, Stage 2; before that, copy `document.documentElement.outerHTML` from the pane's
devtools). Snapshots are written scrubbed by `scrubDom` (scripts, styles, media and iframes dropped;
only `id class role contenteditable aria-label data-testid data-message-author-role
data-lexical-editor type disabled placeholder translate` kept; text replaced by `…`) into
`~/.config/triplex-desktop/snapshots/` (`<userData>/snapshots/`, never committed). The copies that
feed the offline health/cascade tests go to `desktop/test/fixtures/dom/` (owner: capture-hardening in
Stage 3, selector-calibration in Stage 4), named `<site>-<state>.html`, and must pass the fixture lint
(no `@`, `/c/`, `/chat/`, uuid, `googleusercontent`, `x.com/`) before they are added; a hand-copied
pre-Stage-2 snapshot is scrubbed by running it through `scrubDom` from `site.cjs` first. Selector
findings that change `DEFAULT_SELECTORS` (items 5, 12, 13, 28) are also filed as
`frozen_change_requests` against `docs/desktop-contract.md` §4 so the contract and the code move
together.
