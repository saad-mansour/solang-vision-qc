// SAM mask → silhouette metrics (leg bottoms / sleeve extents / mirror IoU) using Meta's own parser (@meta-sam/parser)
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
  const parsed = parseImageStream(ev())
  for await (const _ of parsed) { /* drain */ }
  return parsed.finalResult
}
// metrics on a binary raster (w×h, 1 = garment) placed at bounds {left, top}
function metrics(raster, w, h) {
  const colBottom = new Array(w).fill(-1), colTop = new Array(w).fill(-1)
  const rowLeft = new Array(h).fill(-1), rowRight = new Array(h).fill(-1)
  let area = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (raster[y * w + x]) {
    area++; if (colTop[x] < 0) colTop[x] = y; colBottom[x] = y; if (rowLeft[y] < 0) rowLeft[y] = x; rowRight[y] = x
  }
  const cx = Math.floor(w / 2)
  // leg bottoms: robust max over each half (95th percentile of column bottoms to ignore stray pixels)
  const pct = (arr, p) => { const a = arr.filter(v => v >= 0).sort((m, n) => m - n); return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : -1 }
  const leftBottom = pct(colBottom.slice(0, cx), 0.98), rightBottom = pct(colBottom.slice(cx), 0.98)
  // sleeve/side extents: leftmost and rightmost reach relative to center (98th percentile over rows)
  const leftReach = cx - pct(rowLeft.map(v => (v >= 0 ? v : 1e9)).filter(v => v < 1e9).map(v => -v).map(v => -v), 0.0) // min x
  const minX = Math.min(...rowLeft.filter(v => v >= 0)), maxX = Math.max(...rowRight.filter(v => v >= 0))
  // mirror IoU around the bbox center
  let inter = 0, union = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = raster[y * w + x], b = raster[y * w + (w - 1 - x)]; if (a && b) inter++; if (a || b) union++ }
  return { area, leftBottom, rightBottom, legDiffPx: Math.abs(leftBottom - rightBottom), legDiffPct: Math.round(1000 * Math.abs(leftBottom - rightBottom) / h) / 10, leftReach: cx - minX, rightReach: maxX - cx, reachDiffPct: Math.round(1000 * Math.abs((cx - minX) - (maxX - cx)) / Math.max(cx - minX, maxX - cx, 1)) / 10, mirrorIoU: Math.round(1000 * inter / Math.max(union, 1)) / 1000 }
}
const tests = [['IMG_1284', 'pants'], ['IMG_1289', 'pants'], ['IMG_1288', 'pants'], ['IMG_1290', 'pants'], ['IMG_1286', 'sweatshirt'], ['IMG_1285', 'sweatshirt'], ['IMG_1292', 'sweatshirt']]
for (const [n, concept] of tests) {
  const t0 = Date.now()
  const img = sharp(path.join(P, n + '.jpg')).rotate()
  const meta = await img.metadata(); const s = Math.min(1, 1600 / Math.max(meta.width, meta.height))
  const b64 = (await img.resize(Math.round(meta.width * s), Math.round(meta.height * s)).jpeg({ quality: 88 }).toBuffer()).toString('base64')
  const text = await sam(b64, concept)
  const res = await parse(text)
  const masks = recordsOfKind(res.records, 'mask')
  const boxes = recordsOfKind(res.records, 'box')
  if (!masks.length) { console.log(n, concept, 'no mask', res.diagnostics); continue }
  // largest by bounds area
  const m = masks.map(mr => ({ mr, a: (mr.bounds.right - mr.bounds.left) * (mr.bounds.bottom - mr.bounds.top) })).sort((p, q) => q.a - p.a)[0].mr
  const raster = decodeMaskToRaster(m.mask)
  const w = m.mask.width, h = m.mask.height
  const mt = metrics(raster, w, h)
  const pxcm = (s * 48)  // ~48 full-res px per cm at 90 cm camera height (rough) → downscaled
  console.log(`${n} «${concept}» objects=${masks.length} mask ${w}x${h} at (${m.bounds.left},${m.bounds.top}) · ${Date.now() - t0}ms`)
  console.log(`   legs: L bottom ${mt.leftBottom} R bottom ${mt.rightBottom} → diff ${mt.legDiffPx}px ≈ ${(mt.legDiffPx / pxcm).toFixed(1)}cm = ${mt.legDiffPct}% of height · reach L ${mt.leftReach} R ${mt.rightReach} → ${mt.reachDiffPct}% · mirrorIoU ${mt.mirrorIoU}`)
}
