/* desktop/test/fake-site/site.js — look-alike composers for chatgpt / claude / grok.
 *
 * Query: ?site=chatgpt|claude|grok  ?state=ok|loggedout|challenge|blocked|slow  ?sendDelayMs=N
 *        ?thread=noise  (a rendered user/assistant exchange whose text and links look like every
 *        wall and banner rule — inside message containers, so the session must stay ok)
 *        ?composer=textarea  (grok only: the older textarea composer instead of the TipTap editor)
 * Paths (SPA fallback): /c/<id> (after a submit), /auth/login|/login|/sign-in (login walls),
 * /challenges.cloudflare.com/* (the local stand-in for the Turnstile iframe; nothing leaves the box).
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
 * window.__fake = {submitted: [], site, state, variant, getText(), helperText()} (the site's own
 * debug surface; `helperText()` is the hidden helper textarea's value, null when there is none).
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

  const params = new URLSearchParams(location.search)
  const site = Object.prototype.hasOwnProperty.call(SITES, params.get('site')) ? params.get('site') : 'chatgpt'
  const cfg = SITES[site]
  const path = location.pathname
  let state = params.get('state') || 'ok'
  if (LOGIN_PATHS.includes(path)) state = 'loggedout'
  const sendDelayMs = Math.max(0, Number(params.get('sendDelayMs')) || 0)
  /** Composer variant: 'tiptap' (grok default), 'textarea' (grok&composer=textarea), 'prosemirror' (chatgpt/claude). */
  const variant = site === 'grok' ? (params.get('composer') === 'textarea' ? 'textarea' : 'tiptap') : 'prosemirror'

  const app = document.getElementById('app')
  app.setAttribute('data-site', site)
  app.setAttribute('data-state', state)

  const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true)

  let composer = null // {el, getText(), clear()}
  let actions = null // {apply(on)}: how "send enabled" is rendered — a disabled toggle, or grok's button swap
  let sendEnabled = false
  let sendTimer = null

  window.__fake = {
    submitted: [],
    site,
    state,
    variant,
    getText: () => (composer ? composer.getText() : null),
    helperText: () => {
      const helper = document.querySelector('textarea.helper')
      return helper ? helper.value : null
    },
  }

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

  if (state === 'blocked') {
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alert')
    alert.textContent = BLOCKED_TEXT
    app.appendChild(alert)
  }

  const thread = document.createElement('main')
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
    window.__fake.submitted.push(text)
    const msg = document.createElement('article')
    msg.setAttribute('data-message-author-role', 'user')
    msg.textContent = text
    thread.appendChild(msg)
    composer.clear()
    setSendEnabled(false)
    setTimeout(() => {
      history.pushState({}, '', '/c/' + randomId() + location.search)
    }, 500)
  }

  function isSubmitKey(e) {
    return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing
  }

  // --- action slot strategies ---------------------------------------------------------------

  /** chatgpt / claude / grok&composer=textarea: one send button, disabled until the model holds text. */
  function toggleActions(button) {
    button.disabled = true
    return {
      apply(on) {
        button.disabled = !on
      },
    }
  }

  /**
   * grok (TipTap): like the real page, the slot renders EITHER the voice-mode button (editor
   * empty) OR the submit button (editor holds text) — never a disabled submit button. The submit
   * button therefore does not exist in the DOM until text is in.
   */
  function swapActions(voiceButton) {
    const submitButton = document.createElement('button')
    submitButton.className = 'send'
    submitButton.type = 'submit'
    submitButton.setAttribute('aria-label', 'Submit')
    submitButton.setAttribute('data-testid', 'chat-submit')
    submitButton.textContent = 'Send'
    let current = voiceButton
    return {
      apply(on) {
        const next = on ? submitButton : voiceButton
        if (next === current) return
        current.replaceWith(next)
        current = next
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
