// SOLANG Vision QC — Cloudflare Pages "advanced mode" worker (this file must sit at the deployed root).
// One deployment, ONE link: the static files (the station page) and the /v1/responses proxy that keeps the Meta API
// key server-side live in the same Pages project. The page calls the proxy on its own origin, so station/config.js
// keeps PROXY_URL = '' exactly like the local dev server.
//
// Set on the Pages project (Settings → Variables and Secrets):
//   META_API_KEY   secret, required   — the Meta Model API key (never reaches the browser)
//   STATION_TOKEN  secret, optional   — if set, the page must send it as X-Station-Token (station/config.js)
//   DAILY_LIMIT    var, default 400   — requests per client IP per day (a public demo link cannot drain credits)
//   MAX_BODY_MB    var, default 25    — request body cap (photo tiles travel as base64 JPEG inside the JSON)
// Everything that is not /v1/* or /health is served from the deployed files by env.ASSETS.

const META_BASE = 'https://api.meta.ai/v1'
const ALLOWED_MODELS = new Set(['muse-spark-1.3', 'muse-spark-1.2', 'sam-3.1'])
const rate = new Map()   // per-isolate counter: blunts abuse of a demo link (resets when the isolate recycles)

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/') return Response.redirect(url.origin + '/station/', 302)
    if (url.pathname === '/health') return json(200, { ok: true, service: 'solang-vision-qc', key: env.META_API_KEY ? 'set' : 'missing' })
    if (url.pathname.startsWith('/v1/')) return proxy(request, env, url)
    return env.ASSETS.fetch(request)
  },
}

async function proxy(request, env, url) {
  if (url.pathname !== '/v1/responses') return json(404, { error: 'not found' })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })

  // same-origin only: the station page is served by this very deployment, so a browser Origin must match it (no CORS headers at all)
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) return json(403, { error: 'origin not allowed' })
  if (env.STATION_TOKEN && request.headers.get('X-Station-Token') !== env.STATION_TOKEN) return json(401, { error: 'bad station token' })
  if (!env.META_API_KEY) return json(500, { error: 'META_API_KEY is not set (the Worker/Pages project → Settings → Variables and Secrets)' })

  // per-IP daily limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const key = ip + '|' + new Date().toISOString().slice(0, 10)
  const n = (rate.get(key) || 0) + 1
  rate.set(key, n)
  if (rate.size > 5000) rate.clear()
  if (n > parseInt(env.DAILY_LIMIT || '400', 10)) return json(429, { error: 'daily limit reached for this address' })

  // body: size cap, JSON, model allow-list, no streaming
  const maxBytes = parseFloat(env.MAX_BODY_MB || '25') * 1024 * 1024
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10)
  if (declared > maxBytes) return json(413, { error: 'body too large' })
  const text = await request.text()
  if (text.length > maxBytes) return json(413, { error: 'body too large' })
  let body
  try { body = JSON.parse(text) } catch (e) { return json(400, { error: 'invalid json' }) }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid json' })
  if (!ALLOWED_MODELS.has(body.model)) return json(400, { error: 'model not allowed: ' + String(body.model).slice(0, 60) })
  body.stream = false

  const up = await fetch(META_BASE + '/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.META_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: request.signal,     // the station's Cancel aborts the upstream call too
  })
  return new Response(up.body, { status: up.status, headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } })
}
