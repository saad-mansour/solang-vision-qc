// v2 metrics: lengths measured from the waist/collar center (rotation-invariant), using SAM masks via @meta-sam/parser
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sharp = require('./node/node_modules/sharp')
const { parseImageStream, recordsOfKind, decodeMaskToRaster } = await import('./node/node_modules/@meta-sam/parser/dist/index.js')
const KEY = fs.readFileSync(path.resolve('../meta_key.txt'), 'utf8').replace(/^\uFEFF/, '').trim()
const P = 'C:/Users/mrsaa/AppData/Local/Temp/claude/C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL/fc16d0f7-253c-42bb-94bb-922acd81a3e1/scratchpad/hack/photos'
async function sam(b64, concept) {
  const body = { model: 'sam-3.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_image', image_url: 'data:image/jpeg;base64,' + b64 }] }], metadata: { include_confidence: 'true', mask_encoding: 'one_bit' } }
  const r = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200))
  const j = await r.json()
  return (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('')
}
async function parse(text) {
  async function* ev() {
    yield { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text }
    yield { type: 'response.output_text.done', item_id: 'm', output_index: 0, content_index: 0, text }
    yield { type: 'response.completed' }
  }
  const parsed = parseImageStream(ev()); for await (const _ of parsed) {} ; return parsed.finalResult
}
export function silhouette(raster, w, h, kind) {
  // top anchor: median x of mask pixels in the top 6% of rows (waistband for pants, collar/shoulders for tops)
  const topRows = Math.max(2, Math.round(h * 0.06)); const xs = []
  for (let y = 0; y < topRows; y++) for (let x = 0; x < w; x++) if (raster[y * w + x]) xs.push(x)
  xs.sort((a, b) => a - b); const cx = xs.length ? xs[Math.floor(xs.length / 2)] : Math.floor(w / 2)
  const cy = 0
  let maxL = 0, maxR = 0, reachL = 0, reachR = 0, area = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (raster[y * w + x]) {
    area++
    const d = Math.hypot(x - cx, y - cy)
    if (x < cx) { if (d > maxL) maxL = d; if (cx - x > reachL) reachL = cx - x } else { if (d > maxR) maxR = d; if (x - cx > reachR) reachR = x - cx }
  }
  const lenDiffPct = Math.round(1000 * Math.abs(maxL - maxR) / Math.max(maxL, maxR, 1)) / 10
  const reachDiffPct = Math.round(1000 * Math.abs(reachL - reachR) / Math.max(reachL, reachR, 1)) / 10
  return { cx, area, maxL: Math.round(maxL), maxR: Math.round(maxR), lenDiffPct, reachL, reachR, reachDiffPct }
}
const tests = [['IMG_1284', 'pants', 'left leg +4cm'], ['IMG_1289', 'pants', 'clean'], ['IMG_1288', 'pants', 'clean lengths'], ['IMG_1290', 'pants', 'equal lengths'], ['IMG_1286', 'sweatshirt', 'equal sleeves'], ['IMG_1285', 'sweatshirt', 'equal sleeves'], ['IMG_1292', 'garment', 'equal sleeves']]
for (const [n, concept, truth] of tests) {
  const img = sharp(path.join(P, n + '.jpg')).rotate()
  const meta = await img.metadata(); const s = Math.min(1, 1600 / Math.max(meta.width, meta.height))
  const b64 = (await img.resize(Math.round(meta.width * s), Math.round(meta.height * s)).jpeg({ quality: 88 }).toBuffer()).toString('base64')
  let res = await parse(await sam(b64, concept)); let masks = recordsOfKind(res.records, 'mask')
  if (!masks.length) { res = await parse(await sam(b64, 'clothing')); masks = recordsOfKind(res.records, 'mask') }
  if (!masks.length) { console.log(n, 'no mask'); continue }
  const m = masks.map(mr => ({ mr, a: (mr.bounds.right - mr.bounds.left) * (mr.bounds.bottom - mr.bounds.top) })).sort((p, q) => q.a - p.a)[0].mr
  const raster = decodeMaskToRaster(m.mask); const w = m.mask.width, h = m.mask.height
  const mt = silhouette(raster, w, h)
  const pxcm = s * 48
  console.log(`${n.padEnd(9)} ${truth.padEnd(16)} len from top-center: L ${mt.maxL} R ${mt.maxR} → ${mt.lenDiffPct}% (≈${(Math.abs(mt.maxL - mt.maxR) / pxcm).toFixed(1)}cm) · side reach L ${mt.reachL} R ${mt.reachR} → ${mt.reachDiffPct}%`)
}
