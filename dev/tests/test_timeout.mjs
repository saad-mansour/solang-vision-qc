// A model call that never answers must fail after cfg.CALL_TIMEOUT_MS (no retry, .timeout = true), a slow body too, a fast call still
// works, and the caller's own cancel still arrives as the caller's reason. Local http server, no network. usage: node tests/test_timeout.mjs
import http from 'node:http'
import { makeApi } from '../../station/api.js'

let failed = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++ }

let mode = 'hang'
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (mode === 'hang') return                                              // headers never sent
    if (mode === 'slowbody') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"output_text":"'); return }   // body never completes
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ output_text: 'fine', echo: JSON.parse(body).model }))
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + srv.address().port
const api = makeApi({ PROXY_URL: base, CALL_TIMEOUT_MS: 400 })
const sockets = new Set(); srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

// 1. hanging request → timeout, not retried
let t0 = Date.now(), err = null
try { await api.responses({ model: 'x', input: [] }) } catch (e) { err = e }
let dt = Date.now() - t0
ok(err && err.timeout === true && err.network === true && err.status === 0, 'hanging call fails with .timeout (' + (err && err.message) + ')')
ok(dt >= 350 && dt < 1500, 'and fails once, after the timeout, no retry (' + dt + ' ms)')

// 2. headers arrive, body stalls → timeout as well
mode = 'slowbody'; t0 = Date.now(); err = null
try { await api.responses({ model: 'x', input: [] }) } catch (e) { err = e }
dt = Date.now() - t0
ok(err && err.timeout === true, 'stalled body fails with .timeout (' + (err && err.message) + ')')
ok(dt < 1500, 'within one timeout (' + dt + ' ms)')

// 3. a normal call still works
mode = 'ok'
const j = await api.responses({ model: 'muse-spark-1.3', input: [] })
ok(j && j.output_text === 'fine' && j.echo === 'muse-spark-1.3', 'fast call answers normally')

// 4. the caller's cancel wins and keeps its own reason
mode = 'hang'
const ac = new AbortController(); setTimeout(() => ac.abort(new DOMException('user cancelled', 'AbortError')), 100)
t0 = Date.now(); err = null
try { await api.responses({ model: 'x', input: [], signal: ac.signal }) } catch (e) { err = e }
dt = Date.now() - t0
ok(err && err.name === 'AbortError' && !err.timeout, 'caller cancel arrives as AbortError (' + (err && err.name) + ')')
ok(dt < 350, 'immediately (' + dt + ' ms)')

for (const s of sockets) s.destroy()
srv.close()
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall timeout checks passed')
process.exit(failed ? 1 : 0)
