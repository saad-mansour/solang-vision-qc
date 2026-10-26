// Live test of station/api.js makeDb against the DEMO Supabase project.
//   node dev/tests/test_api.mjs      → PASS/FAIL per check, exit 1 on any failure
// Config comes from station/config.js (publishable key of the throwaway demo project) — its values are never printed.
// Writes: one inspection + one finding + one example (all tagged _test / TEST) and a 2-byte probe object
// _probe/test-api.txt in storage. The rows are deleted at the end (scoped by their own ids); the storage probe
// stays because the publishable key has no DELETE policy by design.
import cfg from '../../station/config.js'
import { makeDb } from '../../station/api.js'

const db = makeDb(cfg)
const REST = String(cfg.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/'
const AUTH = { apikey: cfg.SUPABASE_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_KEY }

let fails = 0
const scrub = s => String(s).split(cfg.SUPABASE_KEY).join('[key]').split(cfg.SUPABASE_URL).join('[url]')
const ok = (cond, msg) => { if (!cond) throw new Error(msg) }
async function check(name, fn) {
  try {
    const info = await fn()
    console.log('PASS', name + (info ? '  — ' + info : ''))
  } catch (e) {
    fails++
    console.log('FAIL', name, '—', scrub((e && e.message) || e))
  }
}

// direct REST calls for cleanup / verification (not through api.js on purpose)
async function del(table, filter) {
  const r = await fetch(REST + table + '?' + filter, { method: 'DELETE', headers: { ...AUTH, Prefer: 'return=representation' } })
  const text = await r.text()
  if (!r.ok) throw new Error(`DELETE ${table} HTTP ${r.status} ${text.slice(0, 200)}`)
  return JSON.parse(text || '[]').length
}
async function get(table, filter) {
  const r = await fetch(REST + table + '?' + filter, { headers: AUTH })
  const text = await r.text()
  if (!r.ok) throw new Error(`GET ${table} HTTP ${r.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

let inspectionId, findingId, exampleId, statsBefore

try {
  await check('listOrders() → 5 rows W26-101..105', async () => {
    const rows = await db.listOrders()
    ok(Array.isArray(rows) && rows.length === 5, 'expected 5 rows, got ' + (rows && rows.length))
    const nums = rows.map(r => r.order_number)
    ok(nums.join(',') === 'W26-101,W26-102,W26-103,W26-104,W26-105', 'unexpected order_numbers: ' + nums.join(','))
    for (const k of ['order_number', 'model_code', 'product', 'garment', 'color', 'line', 'reference_url']) ok(k in rows[0], 'missing column ' + k)
    return nums.join(' ')
  })

  await check('listWorkers() → 9 rows ordered by line, id', async () => {
    const rows = await db.listWorkers()
    ok(rows.length === 9, 'expected 9 rows, got ' + rows.length)
    for (const k of ['id', 'name', 'line', 'stage']) ok(k in rows[0], 'missing column ' + k)
    const lines = rows.map(r => r.line)
    ok(lines.join() === [...lines].sort((a, b) => a.localeCompare(b)).join(), 'not ordered by line')
    return rows.length + ' workers, lines: ' + [...new Set(lines)].join(' / ')
  })

  await check('todayStats() → 4 numeric keys', async () => {
    statsBefore = await db.todayStats()
    for (const k of ['inspections', 'red', 'confirmed', 'rejected']) ok(Number.isFinite(statsBefore[k]), k + ' is not a number: ' + statsBefore[k])
    return JSON.stringify(statsBefore)
  })

  await check('uploadPhoto(_probe/test-api.txt) → public URL that fetches 200', async () => {
    const url = await db.uploadPhoto('_probe/test-api.txt', new Blob(['ok']), 'text/plain')
    ok(typeof url === 'string' && url.startsWith('http'), 'not a URL: ' + typeof url)
    ok(url === db.publicUrl('_probe/test-api.txt'), 'uploadPhoto URL differs from publicUrl()')
    const r = await fetch(url, { cache: 'no-store' })
    ok(r.status === 200, 'public fetch HTTP ' + r.status)
    const text = await r.text()
    ok(text === 'ok', 'public object body is ' + JSON.stringify(text.slice(0, 40)))
    return 'HTTP 200, body "ok"'
  })

  await check('insertInspection() → id', async () => {
    const row = await db.insertInspection({ inspector: '_test', decision: '_test', order_number: 'W26-101', garment: 'sweatshirt' })
    ok(row && Number.isInteger(row.id), 'no integer id in ' + JSON.stringify(row).slice(0, 120))
    ok(row.inspector === '_test' && row.order_number === 'W26-101', 'returned row does not echo the inserted values')
    inspectionId = row.id
    return 'id ' + inspectionId
  })

  await check('updateInspection(id, {n_red:1})', async () => {
    const row = await db.updateInspection(inspectionId, { n_red: 1 })
    ok(row && row.id === inspectionId && row.n_red === 1, 'patch not reflected: ' + JSON.stringify(row).slice(0, 120))
    return 'n_red = ' + row.n_red
  })

  await check('insertFindings([1 row]) → 1 row with id', async () => {
    const rows = await db.insertFindings([{ inspection_id: inspectionId, type: 'hole', x: 1, y: 1, confidence: 0.9, level: 'red' }])
    ok(Array.isArray(rows) && rows.length === 1, 'expected 1 row, got ' + (rows && rows.length))
    ok(Number.isInteger(rows[0].id), 'no id on returned finding')
    ok(rows[0].inspection_id === inspectionId && rows[0].type === 'hole', 'returned finding does not echo the input')
    findingId = rows[0].id
    return 'id ' + findingId
  })

  await check('updateFinding(id, {verdict:"confirmed"})', async () => {
    const row = await db.updateFinding(findingId, { verdict: 'confirmed', verdict_by: '_test' })
    ok(row && row.id === findingId && row.verdict === 'confirmed', 'patch not reflected')
    return 'verdict = ' + row.verdict
  })

  await check('findingsFor(id) → contains the finding', async () => {
    const rows = await db.findingsFor(inspectionId)
    ok(rows.length === 1 && rows[0].id === findingId, 'expected exactly the one finding, got ' + rows.length)
    return rows.length + ' finding'
  })

  await check('insertExamples([1 row]) → 1 row', async () => {
    const rows = await db.insertExamples([{ finding_id: findingId, model_code: 'TEST', type: 'hole', label: 'defect', crop_path: '_probe/x.jpg' }])
    ok(rows.length === 1 && Number.isInteger(rows[0].id), 'expected 1 row with id')
    exampleId = rows[0].id
    return 'id ' + exampleId
  })

  await check('examplesFor("TEST") → includes the example', async () => {
    const rows = await db.examplesFor('TEST', 5)
    ok(rows.some(r => r.id === exampleId), 'example not returned')
    return rows.length + ' example(s) for TEST'
  })

  await check('recentInspections(3) → includes the id', async () => {
    const rows = await db.recentInspections(3)
    ok(rows.length <= 3, 'limit not applied: ' + rows.length)
    ok(rows.some(r => r.id === inspectionId), 'test inspection not in the 3 most recent (ids: ' + rows.map(r => r.id).join(',') + ')')
    for (const k of ['id', 'created_at', 'order_number', 'decision', 'inspector', 'n_red']) ok(k in rows[0], 'missing column ' + k)
    return 'ids ' + rows.map(r => r.id).join(', ')
  })

  await check('todayStats() after the writes → inspections +1, red +1, confirmed +1', async () => {
    const s = await db.todayStats()
    ok(s.inspections >= statsBefore.inspections + 1, `inspections ${statsBefore.inspections} → ${s.inspections}`)
    ok(s.red >= statsBefore.red + 1, `red ${statsBefore.red} → ${s.red}`)
    ok(s.confirmed >= statsBefore.confirmed + 1, `confirmed ${statsBefore.confirmed} → ${s.confirmed}`)
    return JSON.stringify(s)
  })

  await check('errors carry "<what> HTTP <status>"', async () => {
    let err
    try { await db.findingsFor('not-a-number') } catch (e) { err = e }
    ok(err && /^findingsFor HTTP 4\d\d /.test(err.message), 'unexpected: ' + (err && err.message))
    ok(err.status >= 400, 'no .status on the error')
    return err.message.slice(0, 40) + '…'
  })
} finally {
  // ---- cleanup: only the rows this run created, each scoped by its own id ----
  await check('cleanup: DELETE vision_examples / vision_findings / vision_inspections (own ids only)', async () => {
    const parts = []
    if (findingId !== undefined) parts.push('examples ' + await del('vision_examples', 'finding_id=eq.' + findingId))
    if (inspectionId !== undefined) parts.push('findings ' + await del('vision_findings', 'inspection_id=eq.' + inspectionId))
    if (inspectionId !== undefined) parts.push('inspections ' + await del('vision_inspections', 'id=eq.' + inspectionId))
    ok(inspectionId === undefined || parts[parts.length - 1] === 'inspections 1', 'inspection delete count != 1: ' + parts.join(', '))
    return parts.join(', ') || 'nothing to clean'
  })
  if (inspectionId !== undefined) {
    await check('verify: the test inspection is gone', async () => {
      const rows = await get('vision_inspections', 'select=id&id=eq.' + inspectionId)
      ok(rows.length === 0, 'inspection still present')
      const f = await get('vision_findings', 'select=id&inspection_id=eq.' + inspectionId)
      ok(f.length === 0, 'findings still present')
      return 'id ' + inspectionId + ' not found (good)'
    })
  }
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed')
process.exit(fails ? 1 : 0)
