# Triplex Desktop — frozen contracts (S4)

> FROZEN CONTRACT (desktop, Stage 0 = tag `S4`). Binding for every desktop workstream. Changes go through the integrator via `frozen_change_requests`; never edit in a feature branch or worktree.

This document is the desktop half of the Triplex contract. It reproduces, verbatim, sections §1–§8
("Frozen contracts") of the approved pivot plan (rev 3, 2026-09-16, "Triplex Desktop — three
subscriptions, one window, one prompt"), followed by the plan's architecture diagram (Appendix A) and its
numbered list of decisions (Appendix B). It is **frozen after Stage 0 (tag `S4`)**: nobody edits it in a
feature branch. A workstream that needs a change — a new frame, a new IPC method, a selector entry marked
unverified that turned out wrong, a new test id — puts it under `frozen_change_requests` in its final
report; only the integrator lands it on `main`, between stages, together with the code that depends on it.
`scripts/check_freeze.sh --list` prints the regex that keeps `docs/`, the desktop package files,
`desktop/protocol/`, `desktop/preload/renderer.cjs`, `frontend/src/DesktopApp.*`,
`frontend/src/desktop-smoke.test.jsx` and `backend/llm/bridge_protocol.py` out of every branch. Items
scoped to a later stage (the Stage 2 / Stage 3 IPC methods, selectors v2, the `ollama:` branch) are part
of the contract from the start so that later stages build against text that already exists; the stage that
implements each is marked inline. The web app's own contract (`docs/api-contract.md`, `docs/semantics.md`)
is unchanged; its desktop addendum is at the end of `docs/api-contract.md`.

## Frozen contracts (written by the integrator in Stage 0, verbatim into `docs/desktop-contract.md`)

### 1. Bridge WebSocket protocol v1 — `ws://127.0.0.1:<PORT>/api/bridge`, JSON text frames, one client

Electron → backend
- `{"type":"hello","protocol":1,"token":"<hex>","version":"0.1.0","sites":["claude","chatgpt","grok"],"capture":{"claude":false,"chatgpt":false,"grok":false},"analyst":null|{"slot":"chatgpt"}}`
  — MUST be the first frame within 10 s (else close 4004); bad token, or a browser `Origin` header whose host is not loopback (127.0.0.1 / localhost / ::1; a missing Origin is fine — Electron's Node WebSocket sends none) → close 4003 before any ack; malformed → 4001.
- `{"type":"capture","capture":{...}}` on toggle; `{"type":"analyst","analyst":null|{"slot"}}` on change.
- `{"type":"health","slot":"chatgpt","health":Health}` on change.
- `{"type":"accepted","req_id":"<uuid>","view":"pane"|"analyst","slot":"chatgpt"}` — before any DOM write.
- `{"type":"rejected","req_id","code":"view_busy"|"logged_out"|"challenge"|"blocked"|"analyst_not_chosen"|"unknown_site"|"view_crashed","message":"..."}`
- `{"type":"result","req_id","ok":true,"captured":true,"text":"<final reply>","url":"https://chatgpt.com/c/…","ms":12345,"done_by":"done_selector"|"stop_gone"|"quiet"}`
- `{"type":"result","req_id","ok":true,"captured":false,"url":"…","ms":1234}` (capture off; `view:"pane"` only)
- `{"type":"result","req_id","ok":false,"code":"composer_not_found"|"send_not_found"|"not_submitted"|"reply_not_found"|"timeout"|"cancelled"|"adapter_gone"|"site_error"|"navigation"|"view_crashed","message":"...","partial":"..."}`
- `{"type":"pong","ts":1710000000000}` (echoes the ping's `ts`)

Backend → Electron
- `{"type":"hello_ack","protocol":1,"backend_version":"0.1.0","ping_s":20}`
- `{"type":"request","req_id":"<uuid4>","model":"web:chatgpt"|"web:chatgpt:analyst","slot":"chatgpt","view":"pane"|"analyst","fresh":false,"text":"<exactly what to type>","role":"chatgpt"|"claude"|"grok"|"analyst","purpose":"chat"|"extraction"|"defense"|"convergence","conversation_id":"<uuid>"|null,"timeout_s":600}`
- `{"type":"cancel","req_id"}` (on timeout or consumer `aclose`)
- `{"type":"ping","ts"}` every `BRIDGE_PING_S` (20); two missed pongs → close 1011, pending requests fail `bridge_disconnected`.

Rules (readings taken at S6, binding from here): `BridgeHub.request` signals bridge-level failures by raising `BridgeError(code)` (`bridge_unavailable` / `bridge_no_ack` / `timeout` / `bridge_disconnected`), never by yielding a frame; the `timeout_s` deadline starts when the request frame is sent and the ack wait is `min(accept_timeout_s, timeout_s)`; `cancel` is sent on the no-ack timeout, the result timeout and `aclose`; a `result` without a preceding `accepted` is an implicit acceptance and a `rejected` after `accepted` is the terminal frame; a failed `result` carrying `partial` is emitted as one text delta before the error delta; a malformed or binary frame after the handshake closes 4001; the client re-sends the cached `health` of every slot right after each `hello_ack`, drops any `request` received before `hello_ack`, closes the socket itself with 4000 after 10 s without `hello_ack` or 2.5 × `ping_s` without a ping (never fatal), and treats 4001/4002/4003 as fatal (no reconnect) and everything else as reconnectable with backoff; `status().since` is ISO-8601 UTC, `health_ts` the backend's receive time in epoch ms, `sites` always lists all three slots, and `detach` resets every cache. From S6 `Health.reply`/`Health.stop` are booleans (`reply` = an assistant container exists via the v2 `assistant` cascade + the cross-site assistant selectors; `stop` = a visible stop button; `null` only when the stop cascade is empty). A second valid `hello` supersedes (old socket closed 4002 `superseded`, its pending
requests fail `bridge_disconnected`); no `accepted`/`rejected` within
`BRIDGE_ACCEPT_TIMEOUT_S` (15) → `bridge_no_ack`; no `result` within `timeout_s`
(`BRIDGE_TIMEOUT_S`, 600) → `cancel` sent + `timeout`; frame bodies are never logged (one INFO
line per request: `bridge req=<id> slot view purpose ok/code ms`, no text).
`Health = {"composer":bool,"send":bool,"reply":bool|null,"stop":bool|null,"session":"ok"|"logged_out"|"challenge"|"blocked"|"unknown","matched":{"composer":str|null,"send":str|null,"reply":str|null,"stop":str|null,"error":str|null},"url":str,"host":str,"title":str,"ts":int}`
(`reply`/`stop` are `null` until selectors v2; `matched.error` names a selector-config problem such as a bad override file, else `null`; `ms`/`ts` are integers — the pydantic models are strict).

Text rule (`bridge.text_for(view, messages) -> (text, fresh)`): `view=="pane"` →
`(messages[-1]["content"], False)`; `view=="analyst"` with no `role=="assistant"` message →
`("\n\n".join(m["content"] for m in messages), True)`; `view=="analyst"` with one →
`(messages[-1]["content"], False)`. Delta mapping (`bridge.stream`, never raises): not
connected → `error{code:"bridge_unavailable",error_type:"triplex"}`; `rejected` / `result ok:false`
→ `error{code:<code>,error_type:"site",message}`; `result captured:false` →
`error{code:"not_captured",error_type:"triplex",message:"capture is off for <slot>; the reply is in the site pane"}`;
`result captured:true` → one `Delta(kind="text",text)` when `text.strip()` then
`Delta(kind="done",finish_reason="stop",truncated=False,usage=Usage(model=model,role=role,purpose=purpose))`
(zero tokens/cost; `stream_completion` stamps latency; an empty captured text falls into
`run_send`'s existing empty-reply handling); `bridge_no_ack` / `timeout` / `bridge_disconnected`
as `error_type:"triplex"`. `max_tokens`, `response_format`, `plugins`, `reasoning` are ignored
(the site decides).

### 2. Electron IPC — `desktop/preload/renderer.cjs` exposes `window.triplex` via `contextBridge`

Main validates every payload (`slot ∈ SLOTS`, `text` string ≤ 32768 chars, `targets ⊆ SLOTS`,
sender is the renderer webContents AND the sender frame's origin is the renderer origin; violations reject `Error('bad_request')`). `panes:getInfo` also re-emits the cached `panes:health` and the current `panes:zoom` for every slot, and main replays both on the renderer's `did-finish-load`.

```ts
triplex.version: string; triplex.slots: ['claude','chatgpt','grok']
getInfo(): Promise<{version, dev, sites:{[slot]:{url,newChatUrl,partition}}, backend:{port:number,url:string}|null, layout:{mode:'tabs'|'split',active:slot}|null, theme:'light'|'dark'|'system'}>   // invoke 'panes:getInfo'
setLayout(layout:{[slot|'analyst']: {x,y,width,height}|null}): void       // send 'panes:layout' (CSS px = DIP at zoomFactor 1; main rounds, min 1; null = hidden)
setActive({mode, active}): void                                          // send 'panes:active'
newChat(targets: slot[]): Promise<void>                                  // invoke 'panes:newChat' → loadURL(newChatUrl)
reload(slot) | openExternal(slot) | inspect(slot) | focusPane(slot): Promise<void>   // invoke 'panes:reload'|'panes:openExternal'|'panes:inspect' (no-op unless dev)|'panes:focus'
zoom(slot, 'in'|'out'|'reset'): Promise<{factor:number}>                 // invoke 'panes:zoom' (0.5..2.0, step 0.1, persisted)
onHealth(cb:(slot, Health)=>void): ()=>void                               // on 'panes:health'
onShortcut(cb:({name})=>void): ()=>void                                  // on 'panes:shortcut'  name ∈ tab-1|tab-2|tab-3|toggle-mode|focus-prompt|new-chat-all
onZoom(cb:({slot,factor})=>void): ()=>void                               // on 'panes:zoom'
// Stage 1 only (removed in Stage 2):
sendPrompt({targets, text}): Promise<{results:{[slot]:{ok, code?, message?, ms, url?, composerSelector?, sendSelector?}}}>   // invoke 'prompt:send'
// Stage 2:
getCapture(): Promise<{[slot]:boolean}>; setCapture(slot, on): Promise<void>            // invoke 'panes:getCapture'|'panes:setCapture'
onBridge(cb:({connected, since?, error?})=>void): ()=>void                             // on 'panes:bridge' (main emits the CURRENT state on the renderer's did-finish-load and after getInfo, like health/zoom; `error` names why a backend could not be spawned, e.g. port_in_use)
onTurn(cb:({slot, phase:'idle'|'typing'|'submitted'|'replying'|'done'|'error', code?})=>void): ()=>void   // on 'panes:turn'
openChats(convId:string|null): Promise<{[slot]:'navigated'|'new'|'kept'}>              // invoke 'panes:openChats' ('kept' also while a turn is in flight on that view or when a recorded link fails to load; null = the open conversation was cleared — main leaves the panes where they are; a navigated pane emits panes:turn {phase:'idle'})
signOut(slot): Promise<void>                                                            // invoke 'panes:signOut' (clearStorageData for that partition only, then newChatUrl)
saveDomSnapshot(slot): Promise<{path}>                                                  // invoke 'panes:snapshot' (scrubbed HTML under userData/snapshots/)
// Stage 3:
setAnalyst(slot|null): Promise<void>; showAnalyst(visible:boolean): Promise<void>       // invoke 'panes:setAnalyst'|'panes:showAnalyst'
onAnalyst(cb:({slot, visible, health})=>void): ()=>void                                // on 'panes:analyst'
// Theme:
setTheme(theme:'light'|'dark'|'system'): Promise<{theme}>                              // invoke 'panes:setTheme' (persists settings.theme, sets nativeTheme.themeSource so the SITE pages follow with their own dark themes; anything else → bad_request)
onTheme(cb:({theme})=>void): ()=>void                                                  // on 'panes:theme' (main emits the CURRENT theme on did-finish-load and after getInfo, like health/zoom/bridge)
// Export (a step → files):
exportTurn({conversationId, turnId, formats, title?, turnType?}): Promise<{cancelled, formats, files, paths, defaultName}>   // invoke 'panes:export'; formats is a non-empty subset of ['md','html','pdf'] — ONE save dialog per call, so all three are one dialog and three files beside each other. md/html come from GET /api/conversations/{id}/export/{turnId}?format=…; the PDF is printed from that HTML in an offscreen window.
```

Shortcuts (`desktop/main/shortcuts.js`, `before-input-event` on every site view and the
renderer + a hidden `Menu` with accelerators): `Ctrl+1/2/3` → `tab-n` (tabs: activate; split:
`focusPane`), `Ctrl+\` → `toggle-mode`, `Ctrl+L` → `focus-prompt` (main focuses the renderer
first), `Ctrl+Shift+N` → `new-chat-all`, `Ctrl+=`/`Ctrl+-`/`Ctrl+0` → zoom of the active pane
applied in main then `panes:zoom`, `Ctrl+R` → reload active pane, `F12` (dev) → inspect active
pane; `Enter`/`Shift+Enter` are renderer-local.

Main ↔ site preload (`desktop/preload/site.cjs`, `sandbox:true`, `contextIsolation:true`):
```
preload → main   ipcRenderer.invoke('adapter:config') → {site: slot|null, selectors: SiteSelectors, dev: boolean}   (main resolves by event.sender.id; null = stay inert)
main → preload   webContents.send('triplex:adapter', msg)
   {reqId, op:'health'}
   {reqId, op:'ready', timeoutMs}                                   // composer present & no stop button, session ok
   {reqId, op:'insertAndSubmit', text}
   {reqId, op:'observe', baselineCount:number, quietMs?, firstTokenMs?, timeoutMs?}   // Stage 2 (timeoutMs overrides captureTimeoutMs)
   {reqId, op:'snapshot'}                                           // Stage 2 (scrubbed DOM)
   {reqId, op:'cancel', target: reqId}
   {op:'config', selectors}                                         // Stage 2 hot reload, no reply
preload → main   ipcRenderer.send('triplex:adapter:result', res)
   {reqId, ok:true, op:'health', health}
   {reqId, ok:true, op:'ready', composerSelector}
   {reqId, ok:true, op:'insertAndSubmit', submitted:true, composerSelector, sendSelector, assistantCount, confirmedBy:'stop_button'|'composer_cleared'|'assistant_count', ms, url}
   {reqId, ok:true, op:'observe', text, doneBy:'done_selector'|'stop_gone'|'quiet', ms, url}
   {reqId, ok:true, op:'snapshot', html}
   {reqId, ok:true, op:'cancel', cancelled:boolean}
   {reqId, ok:false, op, code, message, partial?}     codes: composer_not_found | send_not_found | not_submitted | reply_not_found | timeout | cancelled | busy | site_error | logged_out | challenge | blocked
preload → main   ipcRenderer.send('triplex:adapter:health', Health)   // on change + 10 s heartbeat
```
The prompt is always a message field, never interpolated into code; the adapter never clears the composer on failure; one op in flight per view (second → `busy`). `adapter:config.selectors` is the full merged config object (`{version, chatgpt, claude, grok}`); `zoom(slot, direction)` takes two arguments and every single-slot method takes the bare slot string.

### 3. Site adapter interface (`site.cjs` exports; `module.exports` only when `module` exists; boots when `process.versions.electron` or `window.__triplexFakeIpc` exists)

```js
SLOTS, DEFAULT_SELECTORS, mergeSelectors(defaults, override) → {merged, warnings: string[]}, siteFor(hostname, sites) → slot|null,
scrubDom(document) → string, toMarkdown(el) → string /* Stage 3 */,
// toMarkdown's FENCED output (language + raw body, copy chrome stripped) is the contract that
// carries an analyst's JSON: a `web:` model is asked for a fenced block precisely because a
// rendered PARAGRAPH loses backslash escapes (CommonMark resolves them before any ASCII
// punctuation), so an unfenced \" comes back as a bare " and the JSON no longer parses.
createAdapter({document, window, site, selectors, now = Date.now}) → {
  health() → Health, sessionState() → 'ok'|'logged_out'|'challenge'|'blocked'|'unknown',
  findComposer() → {el, selector}|null, waitForComposer(timeoutMs) → Promise<{el, selector}>,
  insertText(text) → Promise<{method:'execCommand'|'nativeValue'|'paste'|'already_present'}>,   // verifies after == before + text (whitespace-squashed); 'already_present' = the composer already held exactly the text, nothing written
  submit(timeoutMs) → Promise<{method:'click'|'enter', sendSelector, confirmedBy}>,
  insertAndSubmit(text) → Promise<{submitted:true, composerSelector, sendSelector, assistantCount, confirmedBy, ms}>,
  countMessages() → number,     // every rendered message container (user + assistant); the signal behind confirmedBy:'assistant_count'
  countAssistant() → number,    // assistant-role containers only ([data-message-author-role='assistant'], .font-claude-response, .font-claude-message, div[id^='response-'] + the v2 `assistant` cascade) — the observe baselineCount
  observe({baselineCount, quietMs, timeoutMs, signal}) → Promise<{text, doneBy, ms}>,   // Stage 2; also snapshots the containers present when it starts and prefers the last one NOT in that set, so a re-render cannot hand back the previous turn's text
}
class AdapterError extends Error { code; partial? }
attachIpc(ipc, factory); boot()
```
Session-rule scope: `errorText` is matched only inside alert-like containers (`[role=alert|status|dialog|alertdialog]`, `[aria-live]`) that are neither inside a message container nor wrapping the thread/composer — never in body text; `loggedOut` counts only when the match is visible and outside a message container; `challengeTitle` counts only as the exact Cloudflare title or when corroborated (no composer, or a `challenge` match); `ready`/`waitForComposer` timeouts answer the session state (`logged_out|challenge|blocked`) when it is not `ok`; ops that arrive before `adapter:config` resolves are parked and replayed once boot settles. Insertion: contenteditable → `el.focus()`, explicit `Range` collapsed at the end,
`document.execCommand('insertText', false, text)`, dispatch `InputEvent('input')`, verify; on
failure a synthetic `paste` `ClipboardEvent` with `DataTransfer`, verify; `<textarea>` → native
`HTMLTextAreaElement.prototype.value` setter + `input`, verify; never `innerHTML`/`textContent`.
Submit: poll the `send` cascade every 150 ms up to `sendWaitMs` for a visible, enabled button
(document + open shadow roots), click; confirm within `submitVerifyMs` by stop button |
composer emptied | `countAssistant()` grew; else one `Enter` keydown/keypress/keyup
(`composed:true`) on the composer, else `not_submitted`. `ready`/`insertAndSubmit` first check
`sessionState()`; not `ok` → `{ok:false, code:<state>}` with no DOM write. `sendSelector` is `null` when the Enter fallback confirmed the submission (no send-cascade entry matched a visible enabled button); `submit()` also returns `assistantCount`, the `countAssistant()` sample taken ONCE before the first submit attempt (never re-sampled after a confirmation window, or a container that mounted while the click was being confirmed would inflate the observe baseline); an insertion whose verification fails on every method is reported as `site_error` with message `insertText: …`; `ready` answers `timeout` when the stop button never disappears within `timeoutMs`.

### 4. Selector config

`DEFAULT_SELECTORS` in `site.cjs`; override `<userData>/selectors.json` or
`TRIPLEX_SELECTORS_FILE`; merge = per site, per key, override REPLACES; unknown keys → warning;
invalid JSON → last good config kept + health `matched.error`; read at start, on pane Reload,
and (Stage 2) on `fs.watch`.
```json
{ "version": 1,
  "chatgpt": {
    "chatUrlPattern": "^https://chatgpt\\.com/c/[A-Za-z0-9-]+(?:[?#]|$)",
    "composer": ["#prompt-textarea", "div[contenteditable='true'].ProseMirror", "div[role='textbox'][aria-label='Chat with ChatGPT']", "div[contenteditable='true'][role='textbox']"],
    "send": ["button[data-testid='send-button']", "#composer-submit-button", "button[aria-label='Send prompt']", "button[aria-label='Send message']", "button.composer-submit-button-color"],
    "loggedOut": ["a[href*='/auth/login']", "button[data-testid='login-button']"], "loggedOutUrl": ["/auth/login", "auth.openai.com", "auth0.openai.com"],
    "challenge": ["iframe[src*='challenges.cloudflare.com']", "#challenge-running", "#challenge-form"], "challengeTitle": ["Just a moment"],
    "errorText": ["Unusual activity has been detected", "You've reached", "Something went wrong"],
    "composerWaitMs": 15000, "sendWaitMs": 18000, "submitVerifyMs": 5000 },
  "claude": { "chatUrlPattern": "^https://claude\\.ai/chat/[0-9a-f-]+",
    "composer": ["div[contenteditable='true'].ProseMirror", "div[contenteditable='true'][data-testid]", "div[contenteditable='true']"],
    "send": ["button[aria-label='Send message']", "button[aria-label*='Send Message']", "button[aria-label*='Send']"],
    "loggedOut": ["a[href*='/login']", "button[data-testid='login-with-google']"], "loggedOutUrl": ["/login"],
    "challenge": ["iframe[src*='challenges.cloudflare.com']"], "challengeTitle": ["Just a moment"],
    "errorText": ["unusual activity", "rate limit"], "composerWaitMs": 15000, "sendWaitMs": 18000, "submitVerifyMs": 5000 },
  "grok": { "chatUrlPattern": "^https://grok\\.com/(c|chat)/[A-Za-z0-9-]+(?:[?#]|$)",
    "composer": ["div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']", "div[role='textbox'][aria-label='Ask Grok anything']", "div.ProseMirror[contenteditable='true']", "textarea[aria-label='Ask Grok anything']", "textarea[placeholder*='Grok']", "div[contenteditable='true'][data-lexical-editor='true']"],
    "send": ["button[data-testid='chat-submit']", "button[aria-label='Submit']", "button[type='submit']"],
    "loggedOut": ["a[href*='/sign-in']", "a[href*='accounts.x.ai']"], "loggedOutUrl": ["accounts.x.ai", "/sign-in"],
    "challenge": ["iframe[src*='challenges.cloudflare.com']"], "challengeTitle": ["Just a moment"],
    "errorText": ["unusual activity"], "composerWaitMs": 15000, "sendWaitMs": 18000, "submitVerifyMs": 5000 } }
```
Version 2 (Stage 2, additive per site; `DEFAULT_SELECTORS.version` stays 1 — an override carrying `version: 2` warns and is applied): `"stop"`, `"assistant"`, `"assistantText"`, `"done"`,
`"quietMs": 2500`, `"firstTokenMs": 90000`, `"captureTimeoutMs": 300000` — chatgpt
`stop:["button[data-testid='stop-button']","button[aria-label='Stop streaming']","button[aria-label='Stop answering']"]`,
`assistant:["[data-message-author-role='assistant']"]`, `assistantText:[".markdown",".whitespace-pre-wrap"]`,
`done:["button[data-testid='copy-turn-action-button']"]`; claude
`stop:["button[aria-label='Stop response']","button[aria-label*='Stop']"]`,
`assistant:[".font-claude-response:not(#markdown-artifact)",".font-claude-message"]`, `assistantText:[".prose"]`, `done:[]`;
grok `stop:["button[aria-label='Stop']","button[aria-label*='Stop']"]`, `assistant:["div[id^='response-']"]`,
`assistantText:[".response-content-markdown"]`, `done:[]`. Empty `stop`+`done` ⇒ quiet detection. Claude's `assistantText` is `[".prose"]` from S8: measured 2026-09-17, a `.prose` element inside `.font-claude-response` holds 2717 of the container's 2754 innerText characters, and with the cascade empty a real Send on 2026-09-18 captured claude's thinking-summary line TWICE in front of the answer (the whole turn, widget included — claude renders that summary both in the visible row and in a panel collapsed by height, which is none of the four hidden-nesses the walk drops). The entry can never truncate a capture to nothing: `replyText` joins every match and falls back to the container when none matches.
Entries the research marked unverified are confirmed in Stage 4. Verified live on 2026-09-16 (grok.com, signed in): the composer is a TipTap/ProseMirror `div.tiptap.ProseMirror[contenteditable][role=textbox][aria-label="Ask Grok anything"]` inside a `form` (a hidden 14 px helper `textarea` also exists — a bare `textarea` entry must never be a fallback), and `button[type=submit][aria-label=Submit][data-testid=chat-submit]` is rendered only once the editor holds text (the voice-mode button occupies that slot while it is empty), so the send cascade is polled after insertion, never before.

### 5. Sites, policy, permissions, flags, env, files, package

`desktop/main/sites.js`: `SITES = {chatgpt:{url:'https://chatgpt.com/', newChatUrl:'https://chatgpt.com/', partition:'persist:chatgpt', hosts:['chatgpt.com','chat.openai.com','auth.openai.com','auth0.openai.com']}, claude:{url:'https://claude.ai/new', newChatUrl:'https://claude.ai/new', partition:'persist:claude', hosts:['claude.ai']}, grok:{url:'https://grok.com/', newChatUrl:'https://grok.com/', partition:'persist:grok', hosts:['grok.com','accounts.x.ai','x.com']}}`;
`TRIPLEX_GROK_SURFACE=x.com` → grok `url/newChatUrl='https://x.com/i/grok'`;
`SSO_HOSTS = ['accounts.google.com','accounts.youtube.com','login.live.com','login.microsoftonline.com','appleid.apple.com','auth.openai.com','auth0.openai.com','accounts.x.ai','x.com','twitter.com','api.twitter.com','challenges.cloudflare.com']`;
`TRIPLEX_SITES_JSON` deep-merges (tests point every site at the fake site).
`policy.js`: popup host ∈ `SSO_HOSTS ∪ site.hosts` → `{action:'allow'}` child window sharing
the partition; `javascript:`/`data:` denied; else `shell.openExternal` + deny; `will-navigate`
to a host outside `site.hosts ∪ SSO_HOSTS` → `preventDefault` + `shell.openExternal`; `will-redirect` (main frame) follows the same matrix; allowed child windows are policed recursively (`did-create-window`); a process-wide `web-contents-created` backstop denies popups and navigation for any unpoliced webContents; the renderer window is pinned to `new URL(TRIPLEX_RENDERER_URL).origin` (navigation/redirect elsewhere → `openExternal`, IPC from a foreign document → `bad_request`); `select-bluetooth-device` is cancelled on every webContents; under `TRIPLEX_E2E_APP=1` non-loopback `hosts` entries are refused and `SSO_HOSTS` is treated as empty.
`permissions.js`: `ALLOWED = {'clipboard-sanitized-write','fullscreen'}`; everything else
denied via `setPermissionRequestHandler`/`setPermissionCheckHandler`;
`setDevicePermissionHandler(() => false)`. UA: never set, never changed. Chromium flags:
`TRIPLEX_CHROMIUM_FLAGS` allow-list `--ignore-gpu-blocklist|--disable-gpu|--disable-gpu-compositing|--use-gl=*|--enable-features=*|--disable-features=*`;
`TRIPLEX_DISABLE_GPU=1` = `--disable-gpu`; anything else refuses to start.

Desktop env: `TRIPLEX_RENDERER_URL` (dev; default `http://127.0.0.1:<backend>/app/`),
`TRIPLEX_BACKEND_PORT` (8021), `TRIPLEX_BACKEND_URL` (attach, no spawn; must name a loopback host — 127.0.0.1 / localhost / ::1 — else exit 2 unless `TRIPLEX_ALLOW_REMOTE_BACKEND=1`, which warns loudly), `TRIPLEX_DATA_DIR`
(default `<userData>/data`), `TRIPLEX_USER_DATA_DIR` (→ `app.setPath('userData')` before
ready), `TRIPLEX_SITES_JSON`, `TRIPLEX_GROK_SURFACE`, `TRIPLEX_SELECTORS_FILE`,
`TRIPLEX_CHROMIUM_FLAGS`, `TRIPLEX_DISABLE_GPU`, `TRIPLEX_THEME` (a launch-time OVERRIDE for dev and screenshots: when a launch sets it to light|dark|system it is written into `settings.theme` before anything reads the theme, replacing the stored choice for that launch and the ones after it until the user picks again; it is never read again at runtime — `settings.theme` is the only source for the window, the site views and the renderer. The resolved theme is also the GROUND Electron paints before any page does: the window's `backgroundColor` and every site view's `setBackgroundColor` are `--bg` (`#ffffff` / `#0d1117`), set at creation and repainted when the theme changes), `TRIPLEX_E2E_APP=1` (exposes
`global.__triplexTest = {views, orchestrator, settings}` and refuses non-loopback site URLs),
`TRIPLEX_FAKE_PORT` (5199), `TRIPLEX_OLLAMA=1` (export `OLLAMA_*` to the backend).
Files under `userData` (`~/.config/triplex-desktop/`): `settings.json`
`{"version":1,"window":{"x","y","width","height","maximized"},"zoom":{"claude":1,"chatgpt":1,"grok":1},"capture":{"claude":false,"chatgpt":false,"grok":false},"analyst":"chatgpt","analystVisible":false,"theme":"dark"}`,
`chats.json` `{"<convId>":{"claude":"https://claude.ai/chat/…","chatgpt":"…","grok":"…"}}` (a link is stored, loaded or navigated only when it is an https URL on `sites[slot].hosts` — plain http only on a loopback host, i.e. the fake site; anything else is dropped with a warning and `views.loadUrl` refuses it with code `navigation`, since `loadURL` bypasses `will-navigate`),
`selectors.json`, `snapshots/`, `logs/backend.log`, `Partitions/`. Renderer `localStorage`:
`triplex.panes.mode|active|targets|drawerOpen`, `triplex.desktop.analyst`, `triplex.theme` (a FIRST-PAINT MIRROR only — `settings.json.theme` in main is authoritative; the renderer applies what `getInfo()`/`onTheme` reports and only proposes changes through `setTheme`).

`desktop/package.json`: `{"name":"triplex-desktop","private":true,"version":"0.1.0","type":"module","main":"main/main.js","scripts":{"start":"electron .","test":"node --test 'test/unit/**/*.test.js'","test:adapters":"playwright test --project adapters","test:app":"TRIPLEX_E2E_APP=1 playwright test --project app"},"devDependencies":{"electron":"^44.4.1","@playwright/test":"^1.63.0"},"overrides":{"@electron-internal/extract-zip":">=1.0.4"}}`.
Worktree agents run `cd desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`; only the
integrator has the binary. `playwright.config.js`: project `adapters` (`channel:'chrome'`,
`testDir:'test/adapters'`, webServer `node test/fake-site/serve.js` on 5199 with `/health`),
project `app` (`testDir:'test/app'`, `test.skip(!process.env.TRIPLEX_E2E_APP)`, webServers:
fake site 5199, Vite `BACKEND_PORT=8021 VITE_PORT=5184` from `../frontend`, backend
`PORT=8021 DATA_DIR=./data/e2e-desktop TRIPLEX_DESKTOP=1 BRIDGE_TOKEN=e2e SLOT_*_MODEL=web:* SLOT_*_EFFORT=off LOG_LEVEL=WARNING`
via `../.venv/bin/python -m backend.main`).

### 6. Backend keys, routing, modules, endpoints

Private env reads (`config.py` untouched): `BRIDGE_TOKEN` (unset → accept any hello +
WARNING), `BRIDGE_TIMEOUT_S`=600, `BRIDGE_ACCEPT_TIMEOUT_S`=15, `BRIDGE_PING_S`=20,
`TRIPLEX_DESKTOP`=0, `TRIPLEX_APP_DIR` (static renderer dir; unset → `/app/*` 404),
`OLLAMA_BASE_URL`=`http://127.0.0.1:11434/v1`, `OLLAMA_MODELS`=`hermes3`. Electron spawn env:
`PORT=8021 HOST=127.0.0.1 DATA_DIR=<userData>/data TRIPLEX_DESKTOP=1 BRIDGE_TOKEN=<random> MOCK_OPENROUTER=0 SLOT_CLAUDE_MODEL=web:claude SLOT_CHATGPT_MODEL=web:chatgpt SLOT_GROK_MODEL=web:grok SLOT_*_EFFORT=off ANALYST_MODEL=web:<settings.analyst>:analyst TRIPLEX_APP_DIR=<repo>/frontend/dist LOG_LEVEL`
(+ `OLLAMA_*` when `TRIPLEX_OLLAMA=1`; `ANALYST_MODEL` is pinned to the empty string when `settings.analyst` is null and `OPENROUTER_API_KEY` is pinned to the empty string — dotenv never overrides a present variable, so the repo `.env` cannot re-supply either; the backend reads '' as no key / no analyst).

`backend/llm/client.py` (the only edit; everything after `async for d in gen` untouched):
```python
def transport_kind(model: str) -> Literal["web", "ollama", "openrouter"]:   # "web:x" / "web:x:analyst" → web; "ollama:x" → ollama
...
        kind = transport_kind(model)
        if kind == "web":                                      # Stage 2 — BEFORE the mock branch
            gen = bridge.stream(role=role, purpose=purpose, model=model, messages=messages, max_tokens=max_tokens)
        elif kind == "ollama":                                 # Stage 3
            gen = _live_stream(role=role, purpose=purpose, model=ollama.model_name(model), messages=messages,
                               payload=ollama.sanitize_payload(payload, model), trace=trace,
                               base_url=os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"),
                               headers=ollama.headers(), cost_lookup=False)
        elif os.environ.get("TRIPLEX_DESKTOP", "0") == "1":    # Stage 2 guard: never OpenRouter from the desktop
            terminal = True
            yield Delta(kind="error", code="transport_disabled", error_type=ERROR_TYPE_TRIPLEX,
                        message="desktop mode: only web:<slot> and ollama:<name> models are allowed; choose an analyst in the config bar")
            return
        elif is_mock:   ...unchanged...
        else:           ...unchanged (cost cap, key check, _live_stream)...
```
`_live_stream(*, role, purpose, model, messages, payload, trace=None, base_url: str | None = None, headers: dict[str, str] | None = None, cost_lookup: bool = True)`;
defaults reproduce today (`base_url=None` → `settings().openrouter_base_url`, `headers=None`
→ `build_headers(...)`, `cost_lookup=False` skips `_fetch_generation_cost`).
`backend/llm/ollama.py` (pure): `model_name("ollama:hermes3") == "hermes3"`,
`headers() == {"Content-Type":"application/json","Accept":"text/event-stream"}`,
`sanitize_payload(p, model)` keeps `messages`, `stream:true`, `max_tokens`, sets `model` to the
bare name, adds `stream_options:{"include_usage":true}`, drops `reasoning`/`provider`/
`plugins`/`response_format`. `backend/llm/webmodels.py`: `desktop_catalog() -> list[ModelMeta]`
= `web:claude` (vendor `anthropic`, "Claude (web session)"), `web:chatgpt` (`openai`),
`web:grok` (`x-ai`), `web:<slot>:analyst` ×3 (vendor `triplex-analyst`, "<Site> web session
(hidden analyst page)"), `ollama:<name>` per `OLLAMA_MODELS` (vendor `ollama`); all
`efforts=["off"]`, `structured_outputs=False`, `raw={"transport":…}`. `routers/models.py`:
`if os.environ.get("TRIPLEX_DESKTOP")=="1": return webmodels.desktop_catalog()` else
byte-identical. `catalog.get_meta` untouched (`web:*` unknown → lenient parse, any effort).

`backend/llm/bridge.py` API: `CURRENT_CONVERSATION: ContextVar[str|None]`;
`conversation_scope(conv_id)` context manager (routers wrap `await sse_response(...)` in it;
the producer task is created inside the first `__anext__` and inherits it);
`current_conversation()`; `parse_web_model(model) -> (slot, view)` (`ValueError` →
`error{code:"bridge_bad_model"}`); `text_for`; `build_request(*, req_id, model, messages, role, purpose, conversation_id, timeout_s) -> dict`;
`class BridgeConnection(Protocol): async send_json(obj); async close(code:int, reason:str)`;
`class BridgeHub: attach(conn, hello) -> supersedes; detach(conn); dispatch(frame) | dispatch(conn, frame) (the scoped form drops frames from a socket that is no longer the client; the router uses it); async request(frame, *, accept_timeout_s, timeout_s) -> AsyncIterator[dict]`
(registers `req_id`, per-request `asyncio.Future`s on the running loop, sends `cancel` on
timeout/`aclose`); `status() -> {"connected","protocol","version","since","sites":{slot:{"capture","health","health_ts"}},"analyst","inflight"}`;
`hub = BridgeHub()`; `async def stream(*, role, purpose, model, messages, max_tokens) -> AsyncIterator[Delta]`.
`backend/llm/bridge_protocol.py` (frozen): pydantic models `Hello, CaptureFrame, AnalystFrame,
HealthFrame, Health, Accepted, Rejected, Result, Pong, HelloAck, Request, Cancel, Ping`
(`extra="forbid"`), `ClientFrame`/`ServerFrame` discriminated unions,
`parse_client_frame(obj)`, `parse_server_frame(obj)`, `CLIENT_TYPES`, `SERVER_TYPES`,
`REJECT_CODES`, `RESULT_CODES`. `desktop/protocol/bridge-v1.json` =
`{"protocol":1,"frames":{"<type>":{"direction":"client|server","examples":[...],"invalid":[...]}}}`,
≥2 examples per type.

Endpoints: `WS /api/bridge` (`routers/bridge.py`: accept → Origin check → first frame within 10 s → token check → `hello_ack` → `hub.attach` → receive loop → `hub.detach` on disconnect; ping task; attach onward inside one try/finally, a failed ack send never attaches);
`GET /api/bridge/status` → `hub.status()`; `GET /app`, `/app/`, `/app/{path:path}`
(`routers/desktop_app.py`: serves `TRIPLEX_APP_DIR`, resolved-path containment, `index.html`
for extension-less paths, 404 otherwise/unset); `POST /api/conversations/{id}/send` body
`{prompt: str, slots?: list[str] | None}` (omitted/null = all three; unknown slot → 404
`not_found("slot")`; `[]` → 422 `empty_slots`; de-duplicated in `SLOT_IDS` order;
`turn_start.slots` lists the subset; `SendTurn.responses` holds only those slots);
`GET /api/models` desktop catalog under `TRIPLEX_DESKTOP=1`. `docs/api-contract.md` addendum:
`slot_error.code` gains `not_captured, bridge_unavailable, bridge_disconnected, bridge_no_ack,
transport_disabled, view_busy, logged_out, challenge, blocked, analyst_not_chosen,
composer_not_found, send_not_found, not_submitted, reply_not_found, site_error, navigation,
view_crashed, cancelled` (`error_type` `triplex` or `site`).

### 7. Renderer slice and test ids

`features/desktop/slice.js`, key `panes`: `{mode:'tabs'|'split', active:slot, targets:{slot:bool},
health:{slot:Health|null}, lastSend:{slot:{ok,code,message,ms,composerSelector,sendSelector}},
sending:false, zoom:{slot:number}, capture:{slot:bool} (S2), bridge:{connected:bool} (S2),
turn:{slot:phase} (S2), drawerOpen:bool (S3), analyst:{slot|null, visible, health} (S3)}`;
from Stage 2 `lastSend[slot]` is `{ok, code?, message?, ms}` recorded by the panes reducer from the send stream (`slot_done` → ok with `usage.latency_ms`; `slot_error{not_captured}` → ok:true with the code; other codes → ok:false), `turn_start{slots}` clears the listed slots, the tabs-mode auto-reveal on `logged_out|challenge|blocked` is a reducer transition (`panes/active`), and `lastSend` describes the last unified send regardless of the open conversation; actions `panes/mode`, `panes/active`, `panes/target`, `panes/health`, `panes/sendStart`,
`panes/sendResult`, `panes/zoom`, `panes/capture`, `panes/bridge`, `panes/turn`, `panes/drawer`,
`panes/analyst`. Test ids: `desktop-shell`, `pane-deck`, `deck-mode-tabs`, `deck-mode-split`,
`deck-tab-<slot>`, `deck-tab-analyst` (S3), `pane-<slot>`, `pane-<slot>-viewport`,
`pane-<slot>-health`, `pane-<slot>-session`, `pane-<slot>-reload`, `pane-<slot>-newchat`,
`pane-<slot>-open`, `pane-<slot>-zoom-in|out|reset`, `pane-<slot>-inspect` (dev only), `pane-<slot>-capture` (S2),
`pane-<slot>-phase` (S2), `prompt-bar`, `prompt-composer`, `prompt-send`, `prompt-target-<slot>`, `prompt-banner` (S2: role=alert for a pre-stream failure of a Send or of New chat everywhere),
`prompt-newchat`, `prompt-result-<slot>`, `bridge-banner` (S2), `capture-notice` (S2),
`desk-drawer`, `drawer-toggle`, `drawer-tab-analyze|fusion|captured|settings` (S3),
`drawer-capture-hint` (S3), `sidebar` (S2, DesktopApp), `export-send` / `export-analyze` / `export-fusion` with `export-format-md|html|pdf|all` inside the opened menu (S8). Renderer chrome never overlaps a
view rect (deck bar above, headers above viewports, prompt bar/drawer below; no modals).

### 8. Freeze list

`scripts/check_freeze.sh` regex gains
`desktop/(package\.json|package-lock\.json|playwright\.config\.js)|desktop/preload/renderer\.cjs|desktop/protocol/|frontend/src/(DesktopApp\.jsx|DesktopApp\.css|desktop-smoke\.test\.jsx)|backend/llm/bridge_protocol\.py`;
every existing entry stays; a new `--list` flag prints the regex. Frozen files edited only by
the integrator in stage pre-work: `frontend/src/main.jsx`, `frontend/vite.config.js`,
`.gitignore`, `CLAUDE.md`, `README.md`, `.env.example`, `docs/*`, `scripts/*`,
`DesktopApp.jsx/.css`, `desktop-smoke.test.jsx`, `renderer.cjs`. Never touched:
`backend/{schemas,config,main,sse,api_errors}.py`, `frontend/src/{App.jsx,App.css,index.css,state/*,api/*}`,
`frontend/{package.json,playwright.config.js}`, `tests/{conftest,helpers}.py`. Previously
untouched but now owned (not frozen) in the stages listed: `backend/features/send.py`,
`backend/routers/{send,analyze,fusion,models}.py`, `backend/llm/client.py`,
`frontend/src/features/{send/SendPane.jsx,meter/index.jsx,config/index.jsx}`.

---

## Appendix A — Architecture (from the plan)

```
┌─ Electron main (desktop/main/) ──────────────────────────────────────────────────────────┐
│ BrowserWindow → renderer (Vite 5184 in dev | backend :8021/app/ built)                    │
│ 3 WebContentsView  persist:chatgpt | persist:claude | persist:grok  (+ hidden analyst     │
│   view on persist:<analyst>, attached with setVisible(false), Stage 3)                    │
│ bounds ← renderer placeholder rects (ResizeObserver → IPC 'panes:layout')                 │
│ per-view preload site.cjs = adapter (ready / insertAndSubmit / observe / health / snapshot)│
│ orchestrator: reject-from-health → navigate-or-adopt chat → mutex(insert) → observe       │
│ bridge client ⇄ backend  WS /api/bridge  (hello{token} → request → accepted → result)     │
│ spawns backend :8021 (Stage 2); settings.json / chats.json / selectors.json in userData   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
┌─ Renderer (frontend/, existing app; DesktopApp when window.triplex exists) ──────────────┐
│ sidebar (Stage 2, unchanged Sidebar) │ PaneDeck: Tabs|Split, per-pane header (health chip,│
│ session badge, Reload, New chat, Open, zoom, capture switch), viewport placeholders       │
│ PromptBar: textarea, target checkboxes, Send, New chat everywhere, per-target result line │
│ Drawer (Stage 3): Analyze | Fusion | Captured | Settings (unchanged panes)                 │
└───────────────────────────────────────────────────────────────────────────────────────────┘
┌─ Backend (backend/, existing FastAPI) ───────────────────────────────────────────────────┐
│ llm/client.py: transport_kind(model)  web:* → llm/bridge.py   ollama:* → _live_stream    │
│   (localhost:11434/v1)   TRIPLEX_DESKTOP=1 → anything else = transport_disabled           │
│ routers/bridge.py (WS + status), routers/desktop_app.py (/app/ static)                    │
│ send/analyze/fusion/store/anon/prompts byte-identical (send.py gains `slots=`)            │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Unified prompt flow (Stage 2+): PromptBar → `POST /api/conversations/{id}/send {prompt, slots?}`
→ `run_send` → `stream_completion(model="web:chatgpt", …)` → bridge `request` → Electron
injects into the ChatGPT view, observes the reply when capture is on → one `text` delta +
`done` → `slot_delta`/`slot_done` → threads and turns persisted exactly as today. Capture off
→ `slot_error{code:"not_captured"}`: nothing appended, `responses[slot]=None`, Analyze reports
it missing (verified free in `send.py`/`analyze.py`). Analyst calls (`web:chatgpt:analyst`)
go to the hidden view: `fresh:true` opens a new chat and types system+user joined; the
correction retry continues in place. Fusion defense prompts are typed into each slot's pane
conversation (the site is the thread).

---

## Appendix B — Decisions taken (from the plan)

1. **Shell-first staging.** Stage 1 (tag `S5`) is a shippable, backend-free shell: three
   logged-in sites, tabs + split, zoom, shortcuts, one prompt that types and submits
   everywhere, nothing read back. It puts the only risks no offline test can retire (Google
   SSO, Turnstile, the live composers, GPU-390 rendering) in front of the user before any
   bridge code exists. Stages 2–4 add capture + bridge (`S6`), Analyze/Fusion + analyst +
   Ollama (`S7`), logged-in calibration (`S8`). Existing tags `S1–S3` stay.
2. **Electron 44, `WebContentsView`, `sandbox:true` everywhere**, one self-contained site
   preload (`desktop/preload/site.cjs`) that boots under Electron or under a fake IPC and
   exports its pure functions when `module` exists (sandboxed preloads cannot `require`
   siblings). Nothing is exposed to the pages.
3. **Capture off by default per site**, persisted in `settings.json`, switched from the pane
   header with the ToS wording next to each switch (the first-run notice = the three switches).
4. **Analyst default = `chatgpt`** (user's choice), persisted as `settings.analyst`; the
   config bar offers `web:<slot>:analyst` ×3 and `ollama:<name>`; `null` is still a legal
   state (Analyze disabled with a hint, bridge answers `analyst_not_chosen`).
5. **Grok = `grok.com`**; `TRIPLEX_GROK_SURFACE=x.com` switches the pane to `https://x.com/i/grok`
   with the same cascades (kept as an escape hatch, not verified in Stage 4).
6. **Stock UA, no stealth, permission handlers per partition** (deny media, geolocation,
   notifications, HID), a `will-navigate` policy, allow-listed `TRIPLEX_CHROMIUM_FLAGS`, and
   `TRIPLEX_USER_DATA_DIR` isolation for e2e.
7. **Health carries `session: ok|logged_out|challenge|blocked`** from Stage 1; a request on a
   view that is not `ok` is rejected before any DOM write; the affected pane (or the analyst
   tab) is auto-revealed.
8. **Bridge auth = per-launch random token in the `hello` frame** (never the URL: uvicorn
   logs the path with its query string); a machine-checked contract file
   (`desktop/protocol/bridge-v1.json`) validated by pydantic and by the JS validator.
9. **`web:` routing precedes the mock branch in `client.py`** (the root conftest scrubs
   `SLOT_*`/`ANALYST_MODEL`, so bridge tests keep the fixed R1/R2/R3 map); `ollama:` reuses
   `_live_stream(base_url=, headers=, cost_lookup=False)`; `TRIPLEX_DESKTOP=1` refuses any
   other model with `transport_disabled`; the desktop backend gets its own
   `DATA_DIR=<userData>/data` and port `8021`, so a pre-pivot OpenRouter conversation can
   never route live with the `.env` key.
10. **`backend/config.py` stays frozen**: new keys are read privately via `os.environ` inside
    `bridge.py` / `ollama.py` / `webmodels.py`, as the LLM layer already does.
11. **Subset sends are real from Stage 1's per-target toggles** (Stage 1 over IPC; Stage 2
    via `PromptBody.slots` + `run_send(conv_id, prompt, *, slots=None)`).
12. **Site chat links are recorded by main**, keyed `(conversation_id, slot)`, only after a
    navigation matching `chatUrlPattern` (≤15 s), never overwriting a matching link with a
    non-matching URL; a send with no link **adopts whatever chat the pane currently shows**;
    "New chat everywhere" = new Triplex conversation + all panes to `newChatUrl`.
13. **Insert phase serialized across views** (main-side mutex around focus → insert → verify;
    observe runs in parallel); explicit `Range` before `execCommand`; hidden-view insertion is
    spiked in Stage 0 with a recorded fallback order.
14. **Zoom, keyboard shortcuts and window-bounds persistence are in Stage 1** (literal asks);
    shortcuts are handled once in main (`before-input-event` on every webContents + hidden
    menu accelerators) because focused views swallow renderer keys.
15. **Single owner per persisted key**: layout mode / active tab / targets / drawer / analyst
    choice mirror → renderer `localStorage`; window bounds / zoom / capture / analyst / chat
    links → main `settings.json` / `chats.json`.
16. **Final-text capture only** (one `text` delta at done; streaming markdown re-renders are
    non-monotonic). A `delta` frame type is reserved.
17. **Renderer served two ways**: dev = Vite on 5184 (`TRIPLEX_RENDERER_URL`); packaged-ish =
    `frontend/dist` served same-origin by the backend at `/app/` (`VITE_BASE=/app/`), so
    `main.py` CORS and `http.js` stay frozen. No custom scheme.
18. **Electron spawns the backend from Stage 2** (`.venv/bin/python -m backend.main`, `uv run`
    fallback) unless `TRIPLEX_BACKEND_URL` attaches to an external one; Stage 1 needs no backend.
19. **Tests**: `desktop` unit tests = `node --test 'test/unit/**/*.test.js'` (quoted glob),
    pure modules with injected fakes, no extra npm deps; bridge flow tests use an in-loop fake
    connection (never `TestClient` websockets mixed with the async `client` fixture); the app
    Playwright project has its own ports (Vite 5184, backend 8021, fake site 5199).
