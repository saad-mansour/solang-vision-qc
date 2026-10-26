// Round trip on the demo project's Realtime channel (network test, no camera needed):
//   tablet → capture{req} → phone → ack{req} → tablet, each hop within a few seconds, on a throwaway station topic.
// Run: node dev/tests/test_link.mjs   (uses the public demo values in station/config.js)
import { openLink } from '../../station/link.js'
import cfg from '../../station/config.js'

const station = 'test-' + process.pid + '-' + Date.now().toString(36)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const got = { phone: [], tablet: [] }, status = {}
let phone, tablet
const opts = (name) => ({ url: cfg.SUPABASE_URL, key: cfg.SUPABASE_KEY, station, onStatus: (s) => { status[name] = s } })
phone = openLink({ ...opts('phone'), onMessage: (e, p) => { got.phone.push([e, p]); if (e === 'capture') phone.send('ack', { req: p.req, ok: true }) } })
tablet = openLink({ ...opts('tablet'), onMessage: (e, p) => got.tablet.push([e, p]) })

let fail = 0
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++ }

for (let i = 0; i < 100 && !(phone.connected() && tablet.connected()); i++) await wait(100)
check(phone.connected() && tablet.connected(), `both joined (${JSON.stringify(status)})`)
check(tablet.send('nothing', {}) === true, 'send() is true on a joined channel')

const t0 = Date.now()
tablet.send('capture', { req: 'r1', by: 'test' })
for (let i = 0; i < 50 && !got.tablet.some(([e, p]) => e === 'ack' && p.req === 'r1'); i++) await wait(100)
const dt = Date.now() - t0
check(got.phone.some(([e, p]) => e === 'capture' && p.req === 'r1' && p.by === 'test'), 'phone received capture{req:r1}')
check(got.tablet.some(([e, p]) => e === 'ack' && p.req === 'r1' && p.ok === true), `tablet received ack{req:r1} — round trip ${dt} ms`)
check(!got.tablet.some(([e]) => e === 'capture'), 'sender does not get its own broadcast (self: false)')

phone.close(); tablet.close()
check(phone.connected() === false && tablet.connected() === false, 'closed links report not connected')
check(tablet.send('capture', { req: 'r2' }) === false, 'send() is false after close')
await wait(200)
console.log(fail ? `\n${fail} check(s) failed` : '\nall link checks passed')
process.exit(fail ? 1 : 0)
