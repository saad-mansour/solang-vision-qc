// SOLANG Vision QC — Cloudflare Worker proxy for Meta Model API
// Why: the station runs in a browser (tablet/phone). The Meta API key must never ship to the browser,
// so the page calls this worker with a station token, and the worker forwards to api.meta.ai with the secret key.
//
// Secrets (set in the Cloudflare dashboard → Settings → Variables → Secrets):
//   META_API_KEY   — Meta Model API key
//   STATION_TOKEN  — shared token the station page sends in X-Station-Token (rotate anytime)
// Optional vars:
//   ALLOWED_ORIGINS — comma-separated list of page origins allowed to call (default: *)
//   DAILY_LIMIT     — max requests per IP per day (default 400) — keeps the public demo link from draining credits
//   MAX_BODY_MB     — max request body size in MB (default 25)

const META_BASE = 'https://api.meta.ai/v1'
const ALLOWED_PATHS = new Set(['/v1/responses'])   // the station calls nothing else; a smaller surface for a public token
const ALLOWED_MODELS = new Set(['muse-spark-1.3', 'muse-spark-1.2', 'sam-3.1', 'muse-voice-transcribe-1.0'])

const rate = new Map()   // in-memory per-isolate counter (good enough for a hackathon demo; KV would make it global)

function cors(env, req) {
  const origin = req.headers.get('Origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
  const ok = allowed.includes('*') || allowed.includes(origin)
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Station-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
  if (ok) h['Access-Control-Allow-Origin'] = allowed.includes('*') ? '*' : origin   // a disallowed origin gets NO header ('null' would match opaque origins)
  return h
}

function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}) })
}

export default {
  async fetch(req, env) {
    const h = cors(env, req)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, service: 'solang-vision-qc proxy' }, h)
    if (!ALLOWED_PATHS.has(url.pathname)) return json(404, { error: 'not found' }, h)
    if (!env.META_API_KEY) return json(500, { error: 'META_API_KEY not configured' }, h)

    // station token
    if (env.STATION_TOKEN && req.headers.get('X-Station-Token') !== env.STATION_TOKEN) return json(401, { error: 'bad station token' }, h)

    // per-IP daily limit
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown'
    const day = new Date().toISOString().slice(0, 10)
    const key = ip + '|' + day
    const n = (rate.get(key) || 0) + 1
    rate.set(key, n)
    if (rate.size > 5000) rate.clear()
    const limit = parseInt(env.DAILY_LIMIT || '400', 10)
    if (n > limit) return json(429, { error: 'daily limit reached for this address' }, h)

    // body size + model allow-list
    let body = null
    if (req.method === 'POST') {
      const maxBytes = parseFloat(env.MAX_BODY_MB || '25') * 1024 * 1024
      const len = parseInt(req.headers.get('Content-Length') || '0', 10)
      if (len > maxBytes) return json(413, { error: 'body too large' }, h)
      const text = await req.text()
      if (text.length > maxBytes) return json(413, { error: 'body too large' }, h)
      try { body = JSON.parse(text) } catch (e) { return json(400, { error: 'invalid json' }, h) }
      if (body && body.model && !ALLOWED_MODELS.has(body.model)) return json(400, { error: 'model not allowed: ' + body.model }, h)
      if (body && body.stream) body.stream = false   // keep the proxy simple: no SSE passthrough
    }

    const upstream = await fetch(META_BASE + url.pathname.replace(/^\/v1/, '') + url.search, {
      method: req.method,
      headers: { 'Authorization': 'Bearer ' + env.META_API_KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const out = await upstream.text()
    return new Response(out, { status: upstream.status, headers: Object.assign({ 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' }, h) })
  },
}
