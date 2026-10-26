// Test of dev/serve.mjs (static + /v1 proxy) and of station/api.js makeApi (retry / abort / headers).
//   node dev/tests/test_serve.mjs    → PASS/FAIL per check, exit 1 on any failure
// Spawns `node dev/serve.mjs --port 8799`, waits for /health, runs the checks, kills the child.
// Exactly ONE paid call is made (a one-word Muse Spark reply, a fraction of a cent); everything else is free.
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi } from '../../station/api.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`

let fails = 0
const ok = (cond, msg) => { if (!cond) throw new Error(msg) }
async function check(name, fn) {
  try {
    const info = await fn()
    console.log('PASS', name + (info ? '  — ' + info : ''))
  } catch (e) {
    fails++
    console.log('FAIL', name, '—', (e && e.message) || e)
  }
}

// raw request: sends the path EXACTLY as given (fetch would normalise /../ away before the server ever sees it)
function raw(pathRaw, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathRaw, method }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}
// strings and raw bytes go through untouched; plain objects are JSON-encoded
const post = (p, body, init) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: (typeof body === 'string' || body instanceof Uint8Array) ? body : JSON.stringify(body), ...(init || {}),
})

// tiny mock "proxy" for exercising makeApi's retry rule without spending anything
function mockServer(statuses) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      const status = statuses.length ? statuses.shift() : 200
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { output: [], n: seen.length } : { error: 'mock ' + status }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

// ---- spawn the dev server ----
const serverLog = []
const child = spawn(process.execPath, [path.join(ROOT, 'dev', 'serve.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stdout.on('data', d => serverLog.push(...String(d).split(/\r?\n/).filter(Boolean)))
child.stderr.on('data', d => serverLog.push('[stderr] ' + String(d).trim()))
let exited = false
child.on('exit', () => { exited = true })

try {
  await check('server answers /health within 10 s', async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000 && !exited) {
      try {
        const r = await fetch(BASE + '/health')
        if (r.ok) {
          const j = await r.json()
          ok(j.ok === true && j.mode === 'dev', 'unexpected health body ' + JSON.stringify(j))
          return `${Date.now() - t0} ms, key ${j.key}`
        }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(exited ? 'server exited early: ' + serverLog.join(' | ') : 'timeout')
  })

  await check('GET /station/CONTRACTS.md → 200 text/markdown, no-store, CORS', async () => {
    const r = await fetch(BASE + '/station/CONTRACTS.md')
    ok(r.status === 200, 'HTTP ' + r.status)
    const ct = r.headers.get('content-type') || ''
    ok(ct.startsWith('text/markdown'), 'content-type ' + ct)
    ok(r.headers.get('cache-control') === 'no-store', 'cache-control ' + r.headers.get('cache-control'))
    ok(r.headers.get('access-control-allow-origin') === '*', 'missing CORS header')
    const text = await r.text()
    ok(text.startsWith('# SOLANG Vision QC'), 'unexpected body start')
    return ct + ', ' + text.length + ' chars'
  })

  await check('GET /shared/pipeline.js → 200 text/javascript', async () => {
    const r = await fetch(BASE + '/shared/pipeline.js')
    ok(r.status === 200, 'HTTP ' + r.status)
    const ct = r.headers.get('content-type') || ''
    ok(ct.startsWith('text/javascript') || ct.startsWith('application/javascript'), 'content-type ' + ct)
    const len = Number(r.headers.get('content-length'))
    ok(len === fs.statSync(path.join(ROOT, 'shared', 'pipeline.js')).size, 'content-length mismatch')
    await r.arrayBuffer()
    return ct + ', ' + len + ' bytes'
  })

  await check('HEAD /shared/pipeline.js → 200 with headers, empty body', async () => {
    const r = await fetch(BASE + '/shared/pipeline.js', { method: 'HEAD' })
    ok(r.status === 200, 'HTTP ' + r.status)
    ok((await r.arrayBuffer()).byteLength === 0, 'HEAD returned a body')
    return 'content-length ' + r.headers.get('content-length')
  })

  await check('GET /meta_key.txt → 404 (secret never served)', async () => {
    const r = await fetch(BASE + '/meta_key.txt')
    ok(r.status === 404, 'HTTP ' + r.status)
    ok(!(await r.text()).includes('sk'), 'body leaked content')
    return 'HTTP 404'
  })

  await check('GET /supabase_demo.txt and /META_KEY.TXT → 404', async () => {
    for (const p of ['/supabase_demo.txt', '/META_KEY.TXT', '/station/../meta_key.txt']) {
      const r = await raw(p)
      ok(r.status === 404, p + ' → HTTP ' + r.status)
    }
    return 'all 404'
  })

  await check('traversal: /../meta_key.txt and /%2e%2e/meta_key.txt (raw) → 404', async () => {
    const out = []
    for (const p of ['/../meta_key.txt', '/%2e%2e/meta_key.txt', '/station/%2e%2e/meta_key.txt', '/station/..%2fmeta_key.txt', '/..%5cmeta_key.txt']) {
      const r = await raw(p)
      ok(r.status === 404, p + ' → HTTP ' + r.status)
      ok(!r.body.includes('sk-'), p + ' leaked a body')
      out.push(p + ' 404')
    }
    return out.length + ' variants'
  })

  if (fs.existsSync(path.join(ROOT, 'dev', 'node', 'node_modules', 'sharp', 'package.json'))) {
    await check('GET /dev/node/node_modules/sharp/package.json → 404 (node_modules denied)', async () => {
      const r = await fetch(BASE + '/dev/node/node_modules/sharp/package.json')
      ok(r.status === 404, 'HTTP ' + r.status)
      ok(!(await r.text()).includes('"name"'), 'package.json content leaked')
      return 'HTTP 404'
    })
  }

  await check('GET /station (no slash) → 301 to /station/', async () => {
    const r = await fetch(BASE + '/station', { redirect: 'manual' })
    ok(r.status === 301, 'HTTP ' + r.status)
    ok(r.headers.get('location') === '/station/', 'location ' + r.headers.get('location'))
    await r.text()
    return 'Location: /station/'
  })

  await check('GET /nope.txt → 404 JSON', async () => {
    const r = await fetch(BASE + '/nope.txt')
    ok(r.status === 404, 'HTTP ' + r.status)
    ok((r.headers.get('content-type') || '').startsWith('application/json'), 'content-type ' + r.headers.get('content-type'))
    ok((await r.json()).error === 'not found', 'unexpected body')
    return 'HTTP 404'
  })

  await check('OPTIONS /v1/responses → 204 with CORS headers', async () => {
    const r = await fetch(BASE + '/v1/responses', { method: 'OPTIONS' })
    ok(r.status === 204, 'HTTP ' + r.status)
    ok(r.headers.get('access-control-allow-origin') === '*', 'no allow-origin')
    ok(/X-Station-Token/i.test(r.headers.get('access-control-allow-headers') || ''), 'X-Station-Token not allowed')
    await r.text()
    return r.headers.get('access-control-allow-headers')
  })

  await check('POST /v1/responses model gpt-4 → 400', async () => {
    const r = await post('/v1/responses', { model: 'gpt-4', input: 'x' })
    ok(r.status === 400, 'HTTP ' + r.status)
    const j = await r.json()
    ok(/model not allowed/.test(j.error || ''), 'body ' + JSON.stringify(j))
    return j.error
  })

  await check('POST /v1/responses invalid JSON → 400', async () => {
    const r = await post('/v1/responses', '{not json')
    ok(r.status === 400, 'HTTP ' + r.status)
    return (await r.json()).error
  })

  await check('POST /v1/other → 404 (path allow-list)', async () => {
    const r = await post('/v1/other', { model: 'muse-spark-1.3' })
    ok(r.status === 404, 'HTTP ' + r.status)
    await r.text()
    return 'HTTP 404'
  })

  await check('10 concurrent POST /v1/responses (gpt-4) → all 400', async () => {
    const t0 = Date.now()
    const rs = await Promise.all(Array.from({ length: 10 }, () => post('/v1/responses', { model: 'gpt-4' })))
    ok(rs.every(r => r.status === 400), 'statuses ' + rs.map(r => r.status).join(','))
    await Promise.all(rs.map(r => r.text()))
    return `10 × 400 in ${Date.now() - t0} ms`
  })

  await check('POST /v1/responses with a 26 MB body → 413 JSON', async () => {
    const r = await post('/v1/responses', new Uint8Array(26 * 1024 * 1024)).catch(e => { throw new Error(e.message + ' / ' + (e.cause && (e.cause.code || e.cause.message))) })
    ok(r.status === 413, 'HTTP ' + r.status)
    const j = await r.json()
    ok(/too large/.test(j.error || ''), 'body ' + JSON.stringify(j))
    return 'HTTP 413 ' + j.error
  })

  await check('makeApi.responses() → model gpt-4 throws Error with .status 400 and "HTTP 400 …" message', async () => {
    const api = makeApi({ PROXY_URL: BASE, STATION_TOKEN: '' })
    let err
    try { await api.responses({ model: 'gpt-4', input: 'x' }) } catch (e) { err = e }
    ok(err && err.status === 400, 'status ' + (err && err.status))
    ok(/^HTTP 400 /.test(err.message), 'message ' + err.message)
    return err.message.slice(0, 60)
  })

  // SKIP_PAID=1 node dev/tests/test_serve.mjs → skips the single paid call (handy while iterating on the server)
  if (process.env.SKIP_PAID) console.log('SKIP makeApi.responses() muse-spark-1.3 → the one paid call (SKIP_PAID is set)')
  else await check('makeApi.responses() muse-spark-1.3 "Reply with the single word ok" → 200 JSON with output  (the ONE paid call)', async () => {
    const api = makeApi({ PROXY_URL: BASE, STATION_TOKEN: '' })
    const t0 = Date.now()
    const j = await api.responses({ model: 'muse-spark-1.3', input: 'Reply with the single word ok', reasoning: { effort: 'minimal' } })
    ok(j && Array.isArray(j.output), 'no output array in ' + JSON.stringify(j).slice(0, 200))
    let text = typeof j.output_text === 'string' ? j.output_text : ''
    if (!text) for (const o of j.output) for (const c of (o.content || [])) if (typeof c.text === 'string') text += c.text
    return `${Date.now() - t0} ms, model ${j.model || '?'}, reply ${JSON.stringify(text.trim().slice(0, 30))}, tokens in/out ${j.usage ? j.usage.input_tokens + '/' + j.usage.output_tokens : '?'}`
  })

  // ---- makeApi retry / abort / header rules against a local mock (free) ----
  await check('makeApi retries once after 1.5 s on 503 then succeeds', async () => {
    const m = await mockServer([503, 200])
    try {
      const api = makeApi({ PROXY_URL: m.url, STATION_TOKEN: 'tok-123' })
      const t0 = Date.now()
      const j = await api.responses({ model: 'muse-spark-1.3', input: 'x' })
      const ms = Date.now() - t0
      ok(j && j.n === 2, 'unexpected body ' + JSON.stringify(j))
      ok(m.seen.length === 2, 'requests seen: ' + m.seen.length)
      ok(ms >= 1400 && ms < 5000, 'retry delay was ' + ms + ' ms')
      ok(m.seen[0].headers['x-station-token'] === 'tok-123', 'X-Station-Token not sent')
      ok(m.seen[0].headers['content-type'] === 'application/json', 'content-type ' + m.seen[0].headers['content-type'])
      return `2 requests, ${ms} ms, token header sent`
    } finally { m.close() }
  })

  await check('makeApi does NOT retry on 500 (1 request) and omits X-Station-Token when empty', async () => {
    const m = await mockServer([500])
    try {
      const api = makeApi({ PROXY_URL: m.url, STATION_TOKEN: '' })
      let err
      const t0 = Date.now()
      try { await api.responses({ model: 'muse-spark-1.3', input: 'x' }) } catch (e) { err = e }
      ok(err && err.status === 500 && /^HTTP 500 /.test(err.message), 'err ' + (err && err.message))
      ok(m.seen.length === 1, 'requests seen: ' + m.seen.length)
      ok(Date.now() - t0 < 1000, 'took too long (retried?)')
      ok(!('x-station-token' in m.seen[0].headers), 'token header sent although empty')
      return err.message
    } finally { m.close() }
  })

  await check('makeApi retries once on 429 then gives up with the second error', async () => {
    const m = await mockServer([429, 429])
    try {
      const api = makeApi({ PROXY_URL: m.url, STATION_TOKEN: '' })
      let err
      try { await api.responses({ model: 'muse-spark-1.3', input: 'x' }) } catch (e) { err = e }
      ok(err && err.status === 429, 'err ' + (err && err.message))
      ok(m.seen.length === 2, 'requests seen: ' + m.seen.length)
      return '2 requests, then ' + err.message
    } finally { m.close() }
  })

  await check('makeApi strips body.signal from the JSON and passes it to fetch (abort → AbortError, no retry)', async () => {
    const m = await mockServer([200])
    try {
      const api = makeApi({ PROXY_URL: m.url, STATION_TOKEN: '' })
      const ac = new AbortController()
      await api.responses({ model: 'muse-spark-1.3', input: 'x', signal: ac.signal })
      ok(m.seen.length === 1 && !('signal' in JSON.parse(m.seen[0].body)), 'signal leaked into the JSON body')
      ok(JSON.parse(m.seen[0].body).model === 'muse-spark-1.3', 'body lost its fields')
      // already aborted → rejects at once, nothing sent
      ac.abort()
      let err; const t0 = Date.now()
      try { await api.responses({ model: 'muse-spark-1.3', input: 'x', signal: ac.signal }) } catch (e) { err = e }
      ok(err && err.name === 'AbortError', 'expected AbortError, got ' + (err && err.name + ' ' + err.message))
      ok(m.seen.length === 1, 'an aborted call still reached the server')
      ok(Date.now() - t0 < 1000, 'aborted call waited for a retry')
      return 'signal stripped; aborted call rejected in ' + (Date.now() - t0) + ' ms'
    } finally { m.close() }
  })

  await check('makeApi: abort during the retry pause rejects immediately with AbortError', async () => {
    const m = await mockServer([503, 200])
    try {
      const api = makeApi({ PROXY_URL: m.url, STATION_TOKEN: '' })
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 300)
      let err; const t0 = Date.now()
      try { await api.responses({ model: 'muse-spark-1.3', input: 'x', signal: ac.signal }) } catch (e) { err = e }
      const ms = Date.now() - t0
      ok(err && err.name === 'AbortError', 'expected AbortError, got ' + (err && err.name))
      ok(ms < 1200, 'did not wake up early: ' + ms + ' ms')
      ok(m.seen.length === 1, 'retry was still sent after abort')
      return `rejected after ${ms} ms, 1 request`
    } finally { m.close() }
  })
} finally {
  child.kill()
  await new Promise(resolve => { if (exited) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000) })
}

console.log('\n--- dev server log (method path status ms) ---')
for (const line of serverLog) console.log('  ' + line)
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed')
process.exit(fails ? 1 : 0)
