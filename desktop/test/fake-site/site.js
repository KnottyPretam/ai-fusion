/* desktop/test/fake-site/site.js — look-alike composers for chatgpt / claude / grok.
 *
 * Query: ?site=chatgpt|claude|grok  ?state=ok|loggedout|challenge|blocked|slow  ?sendDelayMs=N
 * Paths (SPA fallback): /c/<id> (after a submit), /auth/login|/login|/sign-in (login walls),
 * /challenges.cloudflare.com/* (the local stand-in for the Turnstile iframe; nothing leaves the box).
 *
 * The v1 selector cascades (site.cjs DEFAULT_SELECTORS) match their FIRST entry here:
 *   chatgpt  div#prompt-textarea.ProseMirror[contenteditable=true][translate=no] in a <form>,
 *            button[data-testid=send-button]#composer-submit-button (disabled until input)
 *   claude   div.ProseMirror[contenteditable=true], button[aria-label="Send message"]
 *   grok     textarea[aria-label="Ask Grok anything"], button[aria-label="Submit"]
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
 * window.__fake = {submitted: [], site, state, getText()} (the site's own debug surface).
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

  const app = document.getElementById('app')
  app.setAttribute('data-site', site)
  app.setAttribute('data-state', state)

  const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true)

  let composer = null // {el, getText(), clear()}
  let sendButton = null
  let sendEnabled = false
  let sendTimer = null

  window.__fake = {
    submitted: [],
    site,
    state,
    getText: () => (composer ? composer.getText() : null),
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

  // --- helpers ------------------------------------------------------------------------------
  const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

  function setSendEnabled(on) {
    if (sendTimer !== null) {
      clearTimeout(sendTimer)
      sendTimer = null
    }
    const apply = () => {
      sendEnabled = on
      if (sendButton) sendButton.disabled = !on
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

  // --- ProseMirror look-alike ---------------------------------------------------------------
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
    const box = clone('tpl-' + site)
    const button = box.querySelector('button.send')
    if (site === 'grok') {
      composer = mountTextarea(box.querySelector('textarea'), cfg.placeholder)
    } else {
      composer = mountProseMirror(box.querySelector('.ProseMirror'), cfg.placeholder)
    }
    if (box.tagName === 'FORM') {
      box.addEventListener('submit', (e) => {
        e.preventDefault()
        submit()
      })
    } else {
      button.addEventListener('click', submit)
    }
    button.disabled = true
    sendButton = button
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
