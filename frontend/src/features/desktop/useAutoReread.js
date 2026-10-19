// useAutoReread (2026-10-18) — the React half of the automatic Read again (rules: ./autoReread.js).
// Called once, from DesktopShell, so it runs whether or not the drawer (and the Analyze tab's own
// Read again button) is mounted. Each render recomputes the target; an effect keyed on it waits
// AUTO_REREAD_SETTLE_MS and then reads that slot again exactly as AnalyzePane's `startReread` does —
// `POST …/turns/{turn}/slots/{slot}/reread` on the `reread` stream, success iff the last event is
// `reread_done`, then the conversation is refetched (guarded by the open id, so a refetch that lands
// after a switch is dropped). The effect's cleanup clears the timer, so a stop control that comes
// back, a pane that leaves this conversation's chat, a stream or a send that starts, or a switch to
// another conversation cancels a pending read.
// One try per key (`attempted`); a TRANSIENT failure (`isTransientRereadFailure`) gives the key back
// ONCE (`retried` remembers it, so it can never loop).
// The prompt-bar line (`panes/rereadResult`, which never touches `sending`) is written only while it
// belongs to THIS read: the first write needs the "still answering" line of the very error being
// completed (`target.message`) — or this key's own last line, for the one retry — and every later
// write needs the line to still be the object this read last wrote. Nothing here ever throws into the
// render.
import { useEffect, useRef, useState } from 'react'
import { loadConversation } from '../../api/http.js'
import { useRunStream } from '../../api/runStream.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { AUTO_REREAD_SETTLE_MS, autoRereadKey, autoRereadTarget, isStillAnsweringResult, isTransientRereadFailure, rereadDone, rereadFailed, rereadRunning } from './autoReread.js'

export function useAutoReread() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  const panes = useSlice('panes')
  const streams = useSlice('streams')
  const attempted = useRef(new Set())
  const retried = useRef(new Set())
  const written = useRef(new Map()) // key → the line object this key last wrote
  const [, setTick] = useState(0) // a re-render after a key is given back (attempted is a ref)
  const convIdRef = useRef(null)
  convIdRef.current = conversation ? conversation.id : null
  const panesRef = useRef(panes)
  panesRef.current = panes

  const target = autoRereadTarget({ conversation, panes, streams, attempted: attempted.current })
  const convId = conversation ? conversation.id : null
  const key = target ? autoRereadKey(convId, target.turnId, target.slot) : null
  const turnId = target ? target.turnId : null
  const slot = target ? target.slot : null
  const expected = target ? target.message : null

  useEffect(() => {
    if (!key) return undefined
    const timer = setTimeout(() => {
      if (attempted.current.has(key)) return
      attempted.current.add(key)
      let first = true
      const line = (result) => {
        const p = panesRef.current
        const current = p && p.lastSend ? p.lastSend[slot] : null
        const own = written.current.has(key) && current === written.current.get(key)
        const ok = first ? (isStillAnsweringResult(current) && current.message === expected) || own : own
        first = false
        if (!ok) return
        written.current.set(key, result)
        dispatch({ type: 'panes/rereadResult', slot, result })
      }
      const started = Date.now()
      ;(async () => {
        line(rereadRunning())
        let failure = null
        try {
          const events = await run('reread', `/api/conversations/${convId}/turns/${turnId}/slots/${slot}/reread`)
          const last = events[events.length - 1]
          if (!last) failure = { code: 'cancelled', message: 'the re-read was cancelled' }
          else if (last.type === 'reread_error' || last.type === 'error') failure = { code: last.code || 'error', message: last.message || 'the re-read failed' }
          else if (last.type !== 'reread_done') failure = { code: 'cancelled', message: 'the re-read ended without a reply' } // aborted mid-stream (superseded)
          if (failure && isTransientRereadFailure(failure.code)) failure.transient = true
        } catch (e) {
          const code = e && e.code
          failure = { code: code || (e && e.message) || 'error', message: (e && e.message) || code || 'error', transient: isTransientRereadFailure(code, { thrown: true }) }
        }
        if (failure && failure.transient && !retried.current.has(key)) {
          retried.current.add(key)
          attempted.current.delete(key) // ONE more try, once the pane still says finished after the settle window
        }
        line(failure ? rereadFailed(failure.code, failure.message) : rereadDone(Date.now() - started))
        setTick((t) => t + 1)
        try {
          if (convIdRef.current === convId) await loadConversation(dispatch, convId, { isCurrent: (c) => convIdRef.current === c.id })
        } catch {
          /* the refetch failed: the next load shows the stored turn */
        }
      })().catch(() => {})
    }, AUTO_REREAD_SETTLE_MS)
    return () => clearTimeout(timer)
    // key carries convId / turnId / slot; `expected` is that key's persisted message
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run, dispatch])
}
