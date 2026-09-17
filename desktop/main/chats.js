// desktop/main/chats.js — <userData>/chats.json, the site chat links (contract §5, decision 12).
//
//   {"<convId>": {"claude": "https://claude.ai/chat/…", "chatgpt": "…", "grok": "…"}}
//
// Keyed (conversation_id, slot). Main is the only writer: the orchestrator records a link only
// after a navigation matching the site's `chatUrlPattern` (≤15 s after the submit) and never
// overwrites a matching link with a non-matching URL — that rule lives in orchestrator.js; this
// store is a plain, atomically written map. A missing file is empty; a corrupt file is moved
// aside (`chats.json.corrupt-<ts>`) with a warning and the store starts empty, so the next
// write yields a valid document again. No electron import: `fs` and the clock are injected.

import nodeFs from 'node:fs'
import path from 'node:path'
import { SLOTS } from './sites.js'

export const CHATS_FILE = 'chats.json'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Keep only `{convId: {slot: url}}` entries with non-empty string ids and urls for known slots. */
export function sanitizeChats(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const [convId, links] of Object.entries(raw)) {
    if (typeof convId !== 'string' || convId === '' || !isPlainObject(links)) continue
    const clean = {}
    for (const slot of SLOTS) {
      const url = links[slot]
      if (typeof url === 'string' && url !== '') clean[slot] = url
    }
    if (Object.keys(clean).length) out[convId] = clean
  }
  return out
}

/**
 * createChats({dir, fs, now, log}) → chats
 *   load()                    read the file (missing → {}, corrupt → moved aside + {})
 *   get(convId, slot)         url | null
 *   links(convId)             {slot: url} (a copy; {} when unknown)
 *   set(convId, slot, url)    record + save; returns true when the document changed
 *   forget(convId)            drop a conversation's links + save; returns true when it existed
 *   forgetSlot(convId, slot)  drop one link + save
 *   all()                     a deep copy of the document
 *   save()                    atomic write now
 *   file                      the absolute path
 */
export function createChats({ dir, fs = nodeFs, now = Date.now, log = console } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createChats: dir is required')
  const file = path.join(dir, CHATS_FILE)
  let doc = {}

  const warn = (m) => {
    if (log && typeof log.warn === 'function') log.warn(`[chats] ${m}`)
  }

  function moveAside(reason) {
    const aside = `${file}.corrupt-${Number(now()).toString(36)}`
    try {
      fs.renameSync(file, aside)
      warn(`${file} ${reason}; moved to ${aside} and starting empty`)
    } catch (e) {
      warn(`${file} ${reason}; could not move it aside (${(e && e.message) || e}); starting empty`)
    }
  }

  function load() {
    let text = null
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (!e || e.code !== 'ENOENT') warn(`${file} unreadable (${(e && e.message) || e}); starting empty`)
      doc = {}
      return all()
    }
    let parsed
    try {
      parsed = JSON.parse(String(text))
    } catch (e) {
      moveAside(`is not valid JSON (${(e && e.message) || e})`)
      doc = {}
      return all()
    }
    if (!isPlainObject(parsed)) {
      moveAside('is not a JSON object')
      doc = {}
      return all()
    }
    doc = sanitizeChats(parsed)
    return all()
  }

  function all() {
    return JSON.parse(JSON.stringify(doc))
  }

  function save() {
    const tmp = path.join(dir, `.${CHATS_FILE}.${process.pid}.${Number(now()).toString(36)}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      warn(`could not write ${file}: ${(e && e.message) || e}`)
      try {
        fs.unlinkSync(tmp)
      } catch (_e) {
        /* nothing to clean */
      }
      return false
    }
  }

  function requireConv(convId) {
    if (typeof convId !== 'string' || convId === '') throw new Error('chats: conversation id must be a non-empty string')
    return convId
  }

  function requireSlot(slot) {
    if (!SLOTS.includes(slot)) throw new Error(`chats: unknown slot ${String(slot)}`)
    return slot
  }

  function get(convId, slot) {
    requireSlot(slot)
    if (typeof convId !== 'string' || convId === '') return null
    const links = doc[convId]
    return links && typeof links[slot] === 'string' ? links[slot] : null
  }

  function links(convId) {
    if (typeof convId !== 'string' || convId === '') return {}
    return doc[convId] ? { ...doc[convId] } : {}
  }

  function set(convId, slot, url) {
    requireConv(convId)
    requireSlot(slot)
    if (typeof url !== 'string' || url === '') throw new Error('chats: url must be a non-empty string')
    if (doc[convId] && doc[convId][slot] === url) return false
    doc[convId] = { ...(doc[convId] || {}), [slot]: url }
    save()
    return true
  }

  function forget(convId) {
    if (typeof convId !== 'string' || !(convId in doc)) return false
    delete doc[convId]
    save()
    return true
  }

  function forgetSlot(convId, slot) {
    requireSlot(slot)
    if (typeof convId !== 'string' || !doc[convId] || !(slot in doc[convId])) return false
    delete doc[convId][slot]
    if (!Object.keys(doc[convId]).length) delete doc[convId]
    save()
    return true
  }

  return { file, load, get, links, set, forget, forgetSlot, all, save }
}
