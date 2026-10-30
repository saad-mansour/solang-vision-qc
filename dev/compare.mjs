// What each verification layer adds, measured on the factory's own pieces: re-run saved inspections through the pipeline in variants and
// score every variant against the inspector's verdicts (✓ confirmed = truth, ✗ rejected = false alarm, within RADIUS px).
//   full      recall prompt, two tile passes, close-ups twice, both references   (= the station)
//   one-pass  one tile pass, one close-up pass
//   strict    the old strict tile prompt (what the first days ran)
//   no-decor  without the embroidery / print close-ups
//   no-ref    without the product's reference photos
// «candidates» (printed from the full run) = everything the tiles raised before the magnified check — the «no verification» number.
// usage (from dev/): node compare.mjs --ids 1,2,4 [--variants full,one-pass,strict,no-decor,no-ref] [--radius 150] [--dry]
// Photos are downloaded once to dev/out/factory/<id>.jpg (public bucket, gitignored). Costs real API calls: ~$0.10–0.15 per variant per piece.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { inspect } from '../shared/pipeline.js'
const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sharp = require(path.join(here, 'node/node_modules/sharp'))
const samParser = await import(path.join(here, 'node/node_modules/@meta-sam/parser/dist/index.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const ids = (arg('--ids', '') || '').split(',').map(s => s.trim()).filter(Boolean)
if (!ids.length) { console.error('usage: node compare.mjs --ids 1,2,4 [--variants …] [--dry]'); process.exit(1) }
const variants = (arg('--variants', 'full,one-pass,strict,no-decor,no-ref')).split(',').map(s => s.trim()).filter(Boolean)
const RADIUS = +arg('--radius', 150) || 150, DRY = process.argv.includes('--dry')
const cfg = fs.readFileSync(path.join(here, '../station/config.js'), 'utf8')
const SB = (cfg.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1], KEY = (cfg.match(/SUPABASE_KEY:\s*'([^']+)'/) || [])[1]
const META = DRY ? '' : fs.readFileSync(path.join(here, '../meta_key.txt'), 'utf8').replace(/^﻿/, '').trim()
const api = { async responses(body) { const r = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + META, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); return r.json() } }
async function get(table, params) { const u = new URL(`${SB}/rest/v1/${table}`); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v)); const r = await fetch(u, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }); if (!r.ok) throw new Error(`${table} HTTP ${r.status}`); return r.json() }
const outDir = path.join(here, 'out/factory'); fs.mkdirSync(outDir, { recursive: true })
async function download(storagePath, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file
  const r = await fetch(`${SB}/storage/v1/object/public/vision-photos/${storagePath}`); if (!r.ok) throw new Error(`download ${storagePath}: HTTP ${r.status}`)
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file
}
// same adapter as run_pipeline.mjs: EXIF applied, full-res, crops via sharp (keep() = flat fill outside the mask)
async function adapter(file) {
  const buf = await sharp(file).rotate().jpeg({ quality: 95 }).toBuffer(); const m = await sharp(buf).metadata()
  return { width: m.width, height: m.height, async jpeg({ x, y, w, h, resize, mirror, keep, fill, quality }) {
    let s = sharp(buf).extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
    if (resize) s = s.resize(Math.round(resize.w), Math.round(resize.h), { kernel: 'lanczos3' }); if (mirror) s = s.flop()
    if (typeof keep === 'function') {
      const { data, info } = await s.raw().toBuffer({ resolveWithObject: true }); const f = Array.isArray(fill) ? fill : [128, 128, 128], sx = w / info.width, sy = h / info.height, ch = info.channels
      for (let py = 0; py < info.height; py++) { const Y = y + (py + 0.5) * sy; for (let px = 0; px < info.width; px++) { const X = x + ((mirror ? info.width - 1 - px : px) + 0.5) * sx; if (!keep(X, Y)) { const i = (py * info.width + px) * ch; data[i] = f[0]; data[i + 1] = f[1]; data[i + 2] = f[2] } } }
      return (await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).jpeg({ quality: Math.round((quality ?? 0.9) * 100) }).toBuffer()).toString('base64')
    }
    return (await s.jpeg({ quality: Math.round((quality ?? 0.9) * 100) }).toBuffer()).toString('base64')
  } }
}
const VARIANTS = {
  'full': { tilePrompt: 'recall', tilePasses: 2, decor: true, decorPasses: 2, refs: true },
  'one-pass': { tilePrompt: 'recall', tilePasses: 1, decor: true, decorPasses: 1, refs: true },
  'strict': { tilePrompt: 'strict', tilePasses: 2, decor: true, decorPasses: 2, refs: true },
  'no-decor': { tilePrompt: 'recall', tilePasses: 2, decor: false, decorPasses: 2, refs: true },
  'no-ref': { tilePrompt: 'recall', tilePasses: 2, decor: true, decorPasses: 2, refs: false },
}
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
// score a list of {x,y} against the inspector: TP = within RADIUS of a confirmed spot, FP = of a rejected spot, new = neither; missed = confirmed spots nobody hit
function score(list, truth) {
  const conf = truth.filter(t => t.verdict === 'confirmed'), rej = truth.filter(t => t.verdict === 'rejected'), hit = new Set()
  let tp = 0, fp = 0, nw = 0
  for (const f of list) {
    const c = conf.findIndex(t => d2(f, t) <= RADIUS * RADIUS), r = rej.findIndex(t => d2(f, t) <= RADIUS * RADIUS)
    if (c >= 0) { tp++; hit.add(c) } else if (r >= 0) fp++; else nw++
  }
  return { n: list.length, tp, fp, new: nw, missed: conf.length - hit.size, truthConfirmed: conf.length, truthRejected: rej.length }
}
const rows = await get('vision_inspections', { select: 'id,order_number,model_code,side,photo_path,width,height,result->summary', id: 'in.(' + ids.join(',') + ')', order: 'id.asc' })
const orders = await get('demo_orders', { select: 'order_number,model_code,garment,reference_url,reference_back_url' })
const totals = {}
for (const row of rows) {
  const truth = (await get('vision_findings', { select: 'x,y,type,verdict,source', inspection_id: 'eq.' + row.id, verdict: 'not.is.null' }))
  const order = orders.find(o => o.order_number === row.order_number) || {}
  const file = await download(row.photo_path, path.join(outDir, row.id + '.jpg'))
  console.log(`\n### #${row.id} · ${row.order_number} · ${row.side} · ${order.garment || 'garment'} — inspector: ${truth.filter(t => t.verdict === 'confirmed').length} ✓ / ${truth.filter(t => t.verdict === 'rejected').length} ✗`)
  truth.forEach(t => console.log(`    ${t.verdict === 'confirmed' ? '✓' : '✗'} ${t.source}/${t.type} at (${t.x},${t.y})`))
  if (DRY) continue
  const img = await adapter(file)
  const refs = []
  for (const [side, url] of [['front', order.reference_url], ['back', order.reference_back_url]]) if (url) refs.push({ image: await adapter(await download(url.split('/vision-photos/')[1], path.join(outDir, `ref_${order.model_code}_${side}.jpg`))), side })
  console.log(`    variant | findings | ✓hit | ✗false | new | missed | candidates | s | $`)
  for (const name of variants) {
    const V = VARIANTS[name]; if (!V) { console.log(`    ${name}: unknown variant`); continue }
    const t0 = Date.now()
    try {
      const res = await inspect(img, { api, samParser, garment: order.garment || 'garment', concurrency: 6, tilePrompt: V.tilePrompt, tilePasses: V.tilePasses, decor: V.decor, decorPasses: V.decorPasses, references: V.refs ? refs : [], lang: 'ar', requireGarment: true, onProgress: () => {} })
      const s = score(res.findings, truth), c = score(res.candidates, truth), secs = (Date.now() - t0) / 1000
      const cost = (res.usage.input_tokens * 1.25 + res.usage.output_tokens * 4.25) / 1e6 + 0.0025 * (res.usage.sam_calls || 0)
      console.log(`    ${name.padEnd(8)}| ${String(s.n).padStart(8)} | ${String(s.tp).padStart(4)} | ${String(s.fp).padStart(6)} | ${String(s.new).padStart(3)} | ${String(s.missed).padStart(6)} | ${String(c.n).padStart(3)} (✓${c.tp} ✗${c.fp}) | ${secs.toFixed(0).padStart(3)} | ${cost.toFixed(2)}`)
      const T = totals[name] = totals[name] || { pieces: 0, n: 0, tp: 0, fp: 0, new: 0, missed: 0, cand: 0, candTp: 0, candFp: 0, secs: 0, cost: 0 }
      T.pieces++; T.n += s.n; T.tp += s.tp; T.fp += s.fp; T.new += s.new; T.missed += s.missed; T.cand += c.n; T.candTp += c.tp; T.candFp += c.fp; T.secs += secs; T.cost += cost
      fs.writeFileSync(path.join(outDir, `${row.id}_${name}.json`), JSON.stringify({ findings: res.findings, candidates: res.candidates, summary: res.summary, usage: res.usage, timings: res.timings }, null, 1))
    } catch (e) { console.log(`    ${name}: failed — ${e.message}`) }
  }
}
if (!DRY && Object.keys(totals).length) {
  console.log('\n## Totals\n\n| variant | pieces | findings | ✓ hit | ✗ false alarm | new (unjudged) | missed | precision | recall | s/piece | $/piece |\n|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [name, T] of Object.entries(totals)) {
    const prec = T.tp + T.fp ? Math.round(100 * T.tp / (T.tp + T.fp)) + '%' : '–', rec = T.tp + T.missed ? Math.round(100 * T.tp / (T.tp + T.missed)) + '%' : '–'
    console.log(`| ${name} | ${T.pieces} | ${T.n} | ${T.tp} | ${T.fp} | ${T.new} | ${T.missed} | ${prec} | ${rec} | ${(T.secs / T.pieces).toFixed(0)} | ${(T.cost / T.pieces).toFixed(2)} |`)
  }
  const F = totals.full; if (F) console.log(`| full · candidates only (no magnified check) | ${F.pieces} | ${F.cand} | ${F.candTp} | ${F.candFp} | ${F.cand - F.candTp - F.candFp} | – | ${F.candTp + F.candFp ? Math.round(100 * F.candTp / (F.candTp + F.candFp)) + '%' : '–'} | – | – | – |`)
  console.log('\nprecision = ✓ / (✓ + ✗) on judged spots · recall = ✓ / (✓ + missed) against the inspector\'s confirmed spots · «new» = spots she never saw (not counted either way)')
}
