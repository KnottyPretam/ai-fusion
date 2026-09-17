// desktop/test/fake-site/serve.js — dependency-free static server for the fake site.
//
//   node test/fake-site/serve.js          (TRIPLEX_FAKE_PORT || 5199, loopback only)
//   import { start } from './serve.js'    start(port) → http.Server (the spike starts it in-process)
//
// GET /health → 200 "ok"; files from this directory; SPA fallback: any path without a file
// extension serves index.html (so /c/<id>, /auth/login, /challenges.cloudflare.com/turnstile all
// render the page); no caching headers; exits cleanly on SIGTERM/SIGINT when run directly.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed')
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname)
  } catch (_e) {
    send(res, 400, 'bad request')
    return
  }
  if (pathname === '/health') {
    send(res, 200, 'ok')
    return
  }
  const ext = path.extname(pathname)
  let file = ext === '' ? path.join(DIR, 'index.html') : path.resolve(DIR, '.' + pathname)
  if (file !== DIR && !file.startsWith(DIR + path.sep)) {
    send(res, 403, 'forbidden')
    return
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, 'not found')
      return
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length })
    res.end(req.method === 'HEAD' ? undefined : data)
  })
}

/** Start the server on `port` (loopback). Returns the http.Server; wait for its 'listening' event. */
export function start(port = Number(process.env.TRIPLEX_FAKE_PORT || 5199), { quiet = false } = {}) {
  const server = http.createServer(handle)
  server.listen(port, HOST, () => {
    if (!quiet) console.log(`fake site listening on http://${HOST}:${server.address().port}/`)
  })
  return server
}

function isMain() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch (_e) {
    return false
  }
}

if (isMain()) {
  const server = start()
  server.on('error', (err) => {
    console.error(`fake site: ${err.message}`)
    process.exit(1)
  })
  const stop = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
