// SOLANG Vision QC — local dev server (zero dependencies; Node 24; works from ANY cwd)
//   node dev/serve.mjs [--port 8787] [--host 127.0.0.1]      → open http://127.0.0.1:8787/station/
//   (--host 0.0.0.0 to reach it from the tablet on the same Wi-Fi; the LAN URLs are printed)
// What it does — see station/CONTRACTS.md §3:
//   1. static files from the REPO ROOT: Cache-Control: no-store, directory → index.html,
//      `..` traversal denied, and secrets (meta_key.txt, supabase_demo.txt, *.key, .env*, node_modules) answer 404
//   2. GET /health → {ok:true, mode:'dev'}
//   3. /v1/* (GET, POST) → https://api.meta.ai/v1/* with Authorization from <root>/meta_key.txt (read once at startup).
//      Same rules as worker/src/index.js so the page behaves identically in dev and production:
//      path + model allow-lists, stream forced off, 25 MB body limit, CORS * with X-Station-Token (token itself ignored here).
//   One log line per request: `method path status ms` — never a body, never the key.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argv = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def }
const PORT = parseInt(argv('--port', '8787'), 10)
const HOST = argv('--host', '127.0.0.1')

const META_BASE = 'https://api.meta.ai/v1'
const ALLOWED_PATHS = new Set(['/v1/responses', '/v1/responses/input_tokens', '/v1/chat/completions', '/v1/models'])
const ALLOWED_MODELS = new Set(['muse-spark-1.3', 'muse-spark-1.2', 'sam-3.1', 'muse-voice-transcribe-1.0'])
const MAX_BODY = 25 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 180_000          // Spark on a 24 MP tile set can take a while; still bounded

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Station-Token',
  'Access-Control-Max-Age': '86400',
}

// The key is read once; a missing/empty file still serves static files and makes /v1/* answer 500.
let KEY = null
try { KEY = fs.readFileSync(path.join(ROOT, 'meta_key.txt'), 'utf8').replace(/^﻿/, '').trim() || null } catch { KEY = null }

function sendJson(res, status, obj, extra) {
  if (res.headersSent || res.destroyed) return
  const text = JSON.stringify(obj)
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...(extra || {}) })
  res.end(text)
}
const notFound = res => sendJson(res, 404, { error: 'not found' })
const stat = p => fs.promises.stat(p).catch(() => null)

// ---------------------------------------------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------------------------------------------
const DENY_NAMES = new Set(['meta_key.txt', 'supabase_demo.txt', 'supabase_demo.txt.txt', '.dev.vars'])
// Any path segment (directory or file) that must never be served. `..` is caught here too (after percent-decoding).
function deniedSegment(s) {
  const l = s.toLowerCase()
  return l === '..' || l === 'node_modules' || l === '.git' || l.startsWith('.env') || l.endsWith('.key') || DENY_NAMES.has(l)
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
  let decoded
  try { decoded = decodeURIComponent(url.pathname) } catch { return sendJson(res, 400, { error: 'bad path' }) }
  if (decoded.includes('\0') || decoded.includes('\\')) return notFound(res)
  const segments = decoded.split('/').filter(Boolean)
  if (segments.some(deniedSegment)) return notFound(res)
  let abs = path.join(ROOT, ...segments)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return notFound(res)   // belt and braces after the `..` check

  let st = await stat(abs)
  if (!st) return notFound(res)
  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) {              // /station → /station/ so the page's relative imports resolve
      res.writeHead(301, { ...CORS, Location: url.pathname + '/' + url.search, 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (segments.length === 0 && !(await stat(path.join(ROOT, 'index.html')))) {   // bare root → the station page
      res.writeHead(302, { ...CORS, Location: '/station/', 'Cache-Control': 'no-store' })
      return res.end()
    }
    abs = path.join(abs, 'index.html')
    st = await stat(abs)
    if (!st || !st.isFile()) return notFound(res)
  } else if (!st.isFile()) {
    return notFound(res)
  }

  res.writeHead(200, {
    ...CORS,
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  })
  if (req.method === 'HEAD') return res.end()
  const stream = fs.createReadStream(abs)
  stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read error' }); else res.destroy() })
  stream.pipe(res)
}

// ---------------------------------------------------------------------------------------------------------------
// /v1/* proxy
// ---------------------------------------------------------------------------------------------------------------
function tooLarge(req, res, declared) {
  if (res.headersSent) return req.destroy()
  const text = JSON.stringify({ error: 'body too large (max 25 MB)' })
  // Bounded body (declared, ≤ 4× the limit): answer on the keep-alive connection and let Node drain the rest, so the
  // client reliably reads the 413 — closing early resets the connection while the client is still writing its body.
  // Unknown length or bigger than that: answer with Connection: close and cut the socket instead of swallowing it.
  const drain = declared > 0 && declared <= 4 * MAX_BODY
  res.writeHead(413, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...(drain ? {} : { Connection: 'close' }) })
  res.end(text, drain ? undefined : () => req.destroy())
}

async function proxy(req, res, url) {
  if (!ALLOWED_PATHS.has(url.pathname)) return sendJson(res, 404, { error: 'not found' })
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  if (!KEY) return sendJson(res, 500, { error: 'meta_key.txt missing or empty — put the Meta API key in <repo>/meta_key.txt and restart the dev server' })

  let body
  if (req.method === 'POST') {
    const declared = parseInt(req.headers['content-length'] || '0', 10)
    if (declared > MAX_BODY) return tooLarge(req, res, declared)
    const chunks = []; let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) return tooLarge(req, res, 0)   // chunked upload: no declared length → cut off
        chunks.push(chunk)
      }
    } catch { return }                                  // client went away mid-upload
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return sendJson(res, 400, { error: 'invalid json' }) }
    if (body && typeof body === 'object') {
      if (body.model !== undefined && !ALLOWED_MODELS.has(body.model)) return sendJson(res, 400, { error: 'model not allowed: ' + String(body.model).slice(0, 60) })
      if (body.stream) body.stream = false              // keep the proxy simple: no SSE passthrough (same as the Worker)
    }
  }

  // Cancel upstream when the station cancels (AbortController in the page) or when it takes too long.
  const ac = new AbortController()
  const onClose = () => { if (!res.writableFinished) ac.abort() }
  res.on('close', onClose)
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const up = await fetch(META_BASE + url.pathname.slice(3) + url.search, {
      method: req.method,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const text = await up.text()
    if (res.destroyed || res.writableEnded) return
    res.writeHead(up.status, {
      ...CORS,
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch (e) {
    if (res.destroyed || res.writableEnded) return     // the client cancelled: nobody to answer
    sendJson(res, 502, { error: 'upstream: ' + (ac.signal.aborted ? 'timeout' : ((e && e.message) || String(e))) })
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const t0 = Date.now()
  let url
  try { url = new URL(req.url, 'http://local') } catch { url = new URL('http://local/') }
  // one line per request, never the body — on 'finish' (answered) or 'close' (client went away), whichever comes first
  let logged = false
  const logLine = () => {
    if (logged) return
    logged = true
    const status = res.headersSent ? res.statusCode : '-'
    console.log(`${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms${res.writableFinished ? '' : ' client-closed'}`)
  }
  res.on('finish', logLine)
  res.on('close', logLine)

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, mode: 'dev', key: KEY ? 'loaded' : 'missing' })
  if (url.pathname.startsWith('/v1/')) return void proxy(req, res, url)
  serveStatic(req, res, url).catch(() => sendJson(res, 500, { error: 'server error' }))
})

// a socket that never produced a parsable request (reset, garbage, oversized headers) — one line, no bytes
server.on('clientError', (err, socket) => {
  console.log(`clientError ${err.code || err.message}`)
  if (err.code === 'ECONNRESET' || !socket.writable) return socket.destroy()
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is already in use — try: node dev/serve.mjs --port ${PORT + 1}` : 'server error: ' + e.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`SOLANG Vision QC dev server — root ${ROOT}`)
  console.log(`  station:  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/station/`)
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  tablet:   http://${n.address}:${PORT}/station/`)
    }
  }
  console.log(`  meta key: ${KEY ? 'loaded from meta_key.txt' : 'MISSING — /v1/* will answer 500 until meta_key.txt exists'}`)
})
