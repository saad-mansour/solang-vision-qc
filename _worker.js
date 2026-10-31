// SOLANG Vision QC — Cloudflare Pages "advanced mode" worker (this file must sit at the deployed root).
// One deployment, ONE link: the static files (the station page) and the /v1/responses proxy that keeps the Meta API
// key server-side live in the same Pages project. The page calls the proxy on its own origin, so station/config.js
// keeps PROXY_URL = '' exactly like the local dev server.
//
// Set on the Pages project (Settings → Variables and Secrets):
//   META_API_KEY   secret, required   — the Meta Model API key (never reaches the browser)
//   STATION_TOKEN  secret, optional   — if set, the page must send it as X-Station-Token (station/config.js)
//   DAILY_LIMIT    var, default 4000  — well-formed requests per client IP per day: one piece is ~40 requests (7 tiles ×2, verify, close-ups,
//                  parts, global), so 4000 ≈ 100 pieces a day from one address — a whole factory shift behind one NAT, still a cap for a public link
//   MAX_BODY_MB    var, default 8     — request body cap (a tile is ~0.4 MB of base64 JPEG, the mirror pair ~1 MB)
// Also enforced: the request must carry this deployment's own Origin (browsers always send it on POST), the model allow-list,
// reasoning effort low/medium only, no streaming. The real backstop for a public link is a spend cap on the Meta account.
// /ping answers the station's «📶 connection check» (same-origin POST of ~1 MB, nothing stored). Everything that is not /v1/*,
// /ping or /health is served from the deployed files by env.ASSETS.

const META_BASE = 'https://api.meta.ai/v1'
const ALLOWED_MODELS = new Set(['muse-spark-1.3', 'muse-spark-1.2', 'sam-3.1'])
const rate = new Map()   // per-isolate counter: blunts abuse of a demo link (resets when the isolate recycles)

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/') return Response.redirect(url.origin + '/station/', 302)
    if (url.pathname === '/health') return json(200, { ok: true, service: 'solang-vision-qc', key: env.META_API_KEY ? 'set' : 'missing' })
    if (url.pathname === '/ping') return ping(request, url)
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
  if (origin !== url.origin) return json(403, { error: 'origin not allowed' })
  if (env.STATION_TOKEN && request.headers.get('X-Station-Token') !== env.STATION_TOKEN) return json(401, { error: 'bad station token' })
  if (!env.META_API_KEY) return json(500, { error: 'META_API_KEY is not set (the Worker/Pages project → Settings → Variables and Secrets)' })

  // body: size cap, JSON, model allow-list, effort cap, no streaming
  const maxBytes = parseFloat(env.MAX_BODY_MB || '8') * 1024 * 1024
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10)
  if (declared > maxBytes) return json(413, { error: 'body too large' })
  const text = await request.text()
  if (text.length > maxBytes) return json(413, { error: 'body too large' })
  let body
  try { body = JSON.parse(text) } catch (e) { return json(400, { error: 'invalid json' }) }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid json' })
  if (!ALLOWED_MODELS.has(body.model)) return json(400, { error: 'model not allowed: ' + String(body.model).slice(0, 60) })
  if (body.reasoning && body.reasoning.effort != null && !['low', 'medium', 'minimal'].includes(body.reasoning.effort)) return json(400, { error: 'reasoning effort not allowed' })
  body.stream = false

  // per-IP daily limit, counted for well-formed requests only; keys of past days are evicted, today's are never dropped
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', today = new Date().toISOString().slice(0, 10), key = ip + '|' + today
  if (rate.size > 5000 && !rate.has(key)) { for (const k of rate.keys()) if (!k.endsWith(today)) rate.delete(k); if (rate.size > 5000) return json(429, { error: 'too many clients today' }) }   // only NEW addresses are refused when the map is full
  const n = (rate.get(key) || 0) + 1
  rate.set(key, n)
  if (n > parseInt(env.DAILY_LIMIT || '4000', 10)) return json(429, { error: 'daily limit reached for this address' })

  let up
  try {
    up = await fetch(META_BASE + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.META_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,     // the station's Cancel aborts the upstream call too
    })
  } catch (e) { return json(502, { error: 'upstream: ' + (e && e.name === 'AbortError' ? 'cancelled' : String((e && e.message) || e).slice(0, 120)) }) }   // JSON, as the station expects — not Cloudflare's HTML 500
  return new Response(up.body, { status: up.status, headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } })
}

// «📶 فحص الاتصال»: the station uploads ~1 MB of random bytes and times it — same-origin POST only, nothing stored, 2 MB cap
async function ping(request, url) {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'origin not allowed' })
  const max = 2 * 1024 * 1024
  if (parseInt(request.headers.get('Content-Length') || '0', 10) > max) return json(413, { error: 'body too large' })
  const t0 = Date.now(), buf = await request.arrayBuffer()
  if (buf.byteLength > max) return json(413, { error: 'body too large' })
  return json(200, { ok: true, bytes: buf.byteLength, ms: Date.now() - t0 })
}
