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
 *   ?nostop=1        no stop button while streaming (the adapter's quiet detection)
 *   ?nodone=1        chatgpt: no copy-turn done marker after the reply (quiet detection on chatgpt)
 *   ?blockAfterMs=N  N ms after a submit the "Unusual activity" alert appears and the reply freezes
 *                    (a blocked session mid-observe)
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
 *                  reply: {enabled, ms, kind, nostop, nodone, blockAfterMs}, replying, done,
 *                  renders, rewinds, replyText()} (the site's own debug surface; `helperText()` is the
 * hidden helper textarea's value, null when there is none; `replyText()` the current reply text, null
 * before any reply).
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
    kind: params.get('reply') === 'json' ? 'json' : 'echo',
    nostop: params.get('nostop') === '1',
    nodone: params.get('nodone') === '1',
    blockAfterMs: params.has('blockAfterMs') ? Math.max(0, Number(params.get('blockAfterMs')) || 0) : null,
  }

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
    replyText: () => (reply ? reply.textEl.textContent : null),
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
      if (!/^\/c\/[A-Za-z0-9]+/.test(location.pathname)) history.pushState({}, '', '/c/' + randomId() + location.search)
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
    if (replyOpts.kind === 'json') {
      const canned = cannedFor(text)
      if (canned !== null) return '```json\n' + canned + '\n```'
    }
    return 'Echo: ' + text
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
      return { container: box, textEl: box, markDone() {} }
    }
    const box = document.createElement('div')
    box.id = 'response-' + randomId()
    box.className = 'reply'
    const md = document.createElement('div')
    md.className = 'response-content-markdown'
    box.appendChild(md)
    return { container: box, textEl: md, markDone() {} }
  }

  /** Full re-render of the reply text (what a markdown renderer does): every child replaced. */
  function renderReply(s) {
    reply.textEl.replaceChildren(document.createTextNode(s))
    fake.renders += 1
  }

  function endReply() {
    if (reply.timer !== null) {
      clearTimeout(reply.timer)
      reply.timer = null
    }
    fake.replying = false
    actions.streaming(false)
  }

  function startReply(text) {
    const built = buildAssistant()
    reply = { ...built, full: replyFor(text), timer: null }
    thread.appendChild(built.container)
    fake.replying = true
    fake.done = false
    if (!replyOpts.nostop) actions.streaming(true)
    const t0 = Date.now()
    let ticks = 0
    const finish = () => {
      renderReply(reply.full)
      reply.markDone()
      endReply()
      fake.done = true
    }
    const step = () => {
      const p = replyOpts.ms === 0 ? 1 : Math.min(1, (Date.now() - t0) / replyOpts.ms)
      if (p >= 1) {
        finish()
        return
      }
      ticks += 1
      const n = Math.floor(reply.full.length * p)
      const rewind = ticks % REWIND_EVERY === 0 && n > 8
      if (rewind) fake.rewinds += 1
      renderReply(reply.full.slice(0, rewind ? Math.floor(n * REWIND_FACTOR) : n))
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
