// SOLANG Vision QC — inspection pipeline (shared by the browser station and the Node test harness)
// Built during the Meta Global AI Developer Hackathon, Oct 26 – Nov 4, 2026.
//
// Pipeline (one garment photo, full resolution):
//   1. SAM 3.1  — find the garment (concept prompt) → crop to it, drop the table clutter; keep its MASK
//   2. Muse Spark (tiles) — cut the garment into overlapping high-res tiles, each tile is inspected for LOCAL defects
//   3. merge    — the same defect seen in two overlapping tiles becomes one candidate
//   4. Muse Spark (verify) — each candidate is re-checked on a 2x magnified crop (lint / texture / print → not a defect)
//   5. silhouette (from the SAM mask, no model call) — leg / sleeve length difference measured from the waist/collar center
//   6. SAM 3.1 (parts) + Muse Spark (mirror) — left part vs mirrored right part → construction asymmetry (seams, panels, pockets)
//   7. Muse Spark (global) — whole garment (downscaled) + optional reference → misplaced print, missing part, twisted seams
// Coordinates everywhere are full-resolution photo pixels unless stated. Spark is asked for 0–1000 grid coords (its native grounding format).
//
// Dependencies are injected so this file has none besides ./focus.js (pure grid helpers):
//   api.responses(body) → Promise<json>          (Meta Model API /v1/responses, via proxy in the browser)
//   img.width, img.height                        (photo size after EXIF rotation)
//   img.jpeg({x,y,w,h, resize, mirror}) → Promise<base64 string without data: prefix>
//   samParser (optional) = { parseImageStream, recordsOfKind, decodeMaskToRaster } from @meta-sam/parser — enables mask-based measurement
//
// Scheduling: after step 1 the two independent branches run CONCURRENTLY (Promise.all):
//   branch L (local):  tiles → verify                      — up to opts.concurrency (default 6) calls at once
//   branch G (global): silhouette, then parts/mirror ∥ global — at most 3 Spark calls at once (the mirror pass fires 2, global 1);
//                      the parts SAM call is sent right after step 1's downscale, so it overlaps the garment SAM call
// so per-stage timings overlap; timings.total is wall-clock. opts.signal (AbortSignal) is checked before every stage and before every
// tile / verify item: when aborted, inspect() rejects with an Error whose name is 'AbortError'.
// Progress events: garment · framing{cut,small,areaPct,clutter?} · nogarment · tiles{count,skipped} · tile{i,n,defects} · verify{count,examples} ·
//   parts{part} · global · warn{stage,error} · stage_done{stage,ms}
// Focus (shared/focus.js): with a SAM mask, tiles that hold no garment are not sent, the table around the garment is painted flat gray
//   before a tile goes to Spark (img.jpeg({keep, fill})) and candidates that land outside the garment are dropped. No garment found →
//   the run stops with result.noGarment (unless opts.requireGarment === false). opts.examples (array or Promise, ≤ 6 of
//   {label:'defect'|'not_defect', type, note, b64}) ride along on both verify looks as labelled references from the same product.
//   opts.foreground (foregroundGrid of the station's empty-table photo) only adds the «clutter» framing warning.

import { garmentGrid, framingCheck, clutterPct } from './focus.js'

export const MODELS = { spark: 'muse-spark-1.3', sam: 'sam-3.1' }
const FILL = [128, 128, 128]                 // what the table becomes inside a tile (the tile prompt names it)

export const GARMENTS = {
  // concept for SAM, paired part to compare, kind of length measurement
  sweatshirt: { concept: 'sweatshirt', part: 'sleeve', measure: 'sleeve' },
  tshirt: { concept: 't-shirt', part: 'sleeve', measure: 'sleeve' },
  hoodie: { concept: 'hoodie', part: 'sleeve', measure: 'sleeve' },
  dress: { concept: 'dress', part: 'sleeve', measure: 'sleeve' },
  pants: { concept: 'pants', part: 'pant leg', measure: 'leg' },
  shorts: { concept: 'shorts', part: 'pant leg', measure: 'leg' },
  garment: { concept: 'garment', part: null, measure: null },
}

export const PROMPTS = {
  tile: 'You are a strict garment quality inspector in a children\'s clothing factory. This is ONE TILE cut from a high-resolution top-down photo of a garment lying flat on a table. ' +
    'Look only at fabric and seams. Report REAL manufacturing defects only: hole, snag/pull, stain or discoloration, loose or hanging thread, broken/skipped/double stitching, puckering, unfinished edge. ' +
    'Ignore printed designs, intended decorations, fabric texture or heather, wrinkles, shadows, the table, labels and the tile edges. ' +
    'Flat mid-gray areas are OUTSIDE the garment (painted out on purpose): ignore them completely and never report their border. ' +
    'Answer ONLY JSON: {"defects":[{"type":"hole|snag|stain|loose_thread|stitching|puckering|unfinished_edge","x":0-1000,"y":0-1000,"confidence":0-1,"why":"short"}]}. Coordinates are on a 0-1000 grid of THIS tile, (0,0) top-left. If nothing, {"defects":[]}.',
  verify: 'You are a strict garment quality inspector. This is a 2x magnified crop (about 5x5 cm of fabric) around a spot that an automatic pass flagged as a possible defect, from a children\'s garment lying flat. ' +
    'Decide what is at or near the center. verdict "defect": a real manufacturing defect (hole, snag/pull, stain or discoloration, loose thread attached to a seam or hanging from the fabric, broken/skipped/double stitching, puckering, unfinished edge). ' +
    'verdict "lint": a removable surface fiber, dust or fluff lying on the fabric. verdict "texture": normal fabric texture/heather, a printed design, a wrinkle or a shadow. verdict "unsure": you cannot tell at this magnification. ' +
    'Answer ONLY JSON: {"verdict":"defect|lint|texture|unsure","type":"hole|snag|stain|loose_thread|stitching|puckering|unfinished_edge|none","confidence":0-1,"severity":"minor|major","why":"one sentence"}',
  verifyRefs: (k) => `The first ${k} image${k > 1 ? 's are' : ' is'} REFERENCE crop${k > 1 ? 's' : ''} from earlier pieces of this SAME product, each already judged by the human inspector as listed. ` +
    'Use them to tell this product\'s normal prints, seams, labels and texture apart from real defects. The LAST image is the spot to judge now. ',
  mirror: (part) => `Image 1 is the LEFT ${part} of a children's garment lying flat (top-down). Image 2 is the RIGHT ${part}, flipped horizontally so it should look like a mirror image of the left one. ` +
    'Compare the construction: seam lines and their positions along the body, panel shapes, pocket or decoration position, stitching lines. Ignore wrinkles, lighting, shadows, how the fabric is laid, the angle of the hem/cuff edge (it depends on the lay), and differences in where the crop was cut. ' +
    'Are there real construction differences a quality inspector would reject (seams in different positions or angles, missing or extra seam, different panel shape, decoration in a different place)? ' +
    'Answer ONLY JSON: {"different":true|false,"confidence":0-1,"differences":["short description with location"],"why":"one sentence"}',
  global: (hasRef) => 'You are a senior garment quality inspector. ' + (hasRef
    ? 'Image 1 is the garment being inspected, lying flat, top-down. Image 2 is a KNOWN GOOD reference piece of the same model. Compare them. '
    : 'The image is a garment lying flat, top-down. ') +
    'Report only GLOBAL defects that need the whole garment to see: misplaced, rotated, missing or incomplete print or decoration, missing part (button, snap, drawstring, label), twisted or misaligned seam across the body, wrong proportions. ' +
    'Do not report tiny local spots (holes, threads, stains) and do not judge leg/sleeve length here. Be conservative: wrinkles, folds and how the piece is laid do not count. ' +
    'Answer ONLY JSON: {"findings":[{"type":"print|missing_part|stitching|other","x":0-1000,"y":0-1000,"confidence":0-1,"why":"one sentence"}]}. Coordinates are on a 0-1000 grid of Image 1. If none, {"findings":[]}.',
}

// ── SAM output parsing ────────────────────────────────────────────────────────
// Wire format: <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;...|>,1<|box;...|>...
const BOX_RE = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>/g
export function parseSamBoxes(text) {
  const out = []
  let m
  BOX_RE.lastIndex = 0
  while ((m = BOX_RE.exec(text || ''))) out.push({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], w: +m[5], h: +m[6], c: m[7] != null ? +m[7] : null })
  return out
}

// All mask records of a SAM response, parsed with Meta's parser (@meta-sam/parser).
async function samMaskRecords(text, samParser) {
  if (!samParser || !text) return []
  const { parseImageStream, recordsOfKind } = samParser
  async function* ev() {
    yield { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text }
    yield { type: 'response.output_text.done', item_id: 'm', output_index: 0, content_index: 0, text }
    yield { type: 'response.completed' }
  }
  const parsed = parseImageStream(ev())
  for await (const _ of parsed) { /* drain snapshots */ }
  const res = await parsed.finalResult
  return recordsOfKind(res.records, 'mask')
}
const maskOut = (m, samParser) => ({ raster: samParser.decodeMaskToRaster(m.mask), w: m.mask.width, h: m.mask.height, left: m.bounds.left, top: m.bounds.top })
const maskArea = (mr) => (mr.bounds.right - mr.bounds.left) * (mr.bounds.bottom - mr.bounds.top)

// The largest mask of a SAM response → {raster, w, h, left, top} in the sent image's pixels, or null.
export async function largestMask(text, samParser) {
  const masks = await samMaskRecords(text, samParser)
  if (!masks.length) return null
  return maskOut(masks.map(mr => ({ mr, a: maskArea(mr) })).sort((p, q) => q.a - p.a)[0].mr, samParser)
}
// The mask that belongs to the chosen box (best IoU of its bounds with the box), not simply the largest of the response: SAM also returns
// masks for other things it saw (the table, a second piece) and painting with the wrong one would gray out the garment itself.
export async function maskForBox(text, samParser, box) {
  const masks = await samMaskRecords(text, samParser)
  if (!masks.length) return null
  const iou = (bd) => {
    const ix = Math.max(0, Math.min(bd.right, box.x2) - Math.max(bd.left, box.x1)), iy = Math.max(0, Math.min(bd.bottom, box.y2) - Math.max(bd.top, box.y1))
    const inter = ix * iy, a = (bd.right - bd.left) * (bd.bottom - bd.top), bb = (box.x2 - box.x1) * (box.y2 - box.y1)
    return inter / Math.max(1, a + bb - inter)
  }
  const best = masks.map(mr => ({ mr, s: iou(mr.bounds) })).sort((p, q) => q.s - p.s)[0]
  return maskOut(best.s >= 0.3 ? best.mr : masks.map(mr => ({ mr, a: maskArea(mr) })).sort((p, q) => q.a - p.a)[0].mr, samParser)
}

// Silhouette metrics from a binary raster: lengths measured from the top-center anchor (waistband / collar), so a splayed leg or a bent sleeve
// changes little. Returns percentages of the longer side.
export function silhouette(raster, w, h) {
  const topRows = Math.max(2, Math.round(h * 0.06)); const xs = []
  for (let y = 0; y < topRows; y++) for (let x = 0; x < w; x++) if (raster[y * w + x]) xs.push(x)
  xs.sort((a, b) => a - b); const cx = xs.length ? xs[Math.floor(xs.length / 2)] : Math.floor(w / 2)
  let maxL = 0, maxR = 0, reachL = 0, reachR = 0, area = 0, yL = 0, yR = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (raster[y * w + x]) {
    area++
    const d = Math.hypot(x - cx, y)
    if (x < cx) { if (d > maxL) { maxL = d; yL = y }; if (cx - x > reachL) reachL = cx - x } else { if (d > maxR) { maxR = d; yR = y }; if (x - cx > reachR) reachR = x - cx }
  }
  const pct = (a, b) => Math.round(1000 * Math.abs(a - b) / Math.max(a, b, 1)) / 10
  return { cx, area, maxL, maxR, yL, yR, lenDiffPct: pct(maxL, maxR), reachL, reachR, reachDiffPct: pct(reachL, reachR) }
}

// ── Geometry ──────────────────────────────────────────────────────────────────
export function tileGrid(w, h, size = 1200, overlap = 200) {
  const step = size - overlap
  const axis = (len) => {
    if (len <= size) return [0]
    const xs = []
    for (let x = 0; x + size < len; x += step) xs.push(x)
    xs.push(len - size)
    return xs
  }
  const tiles = []
  for (const y of axis(h)) for (const x of axis(w)) tiles.push({ x, y, w: Math.min(size, w - x), h: Math.min(size, h - y) })
  return tiles
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

export function gridToPx(gx, gy, region) {
  return { x: Math.round(region.x + clamp(+gx || 0, 0, 1000) * region.w / 1000), y: Math.round(region.y + clamp(+gy || 0, 0, 1000) * region.h / 1000) }
}

export function mergeCandidates(cands, dist = 120) {
  const merged = []
  for (const c of cands) {
    const hit = merged.find(m => Math.abs(m.x - c.x) < dist && Math.abs(m.y - c.y) < dist)
    if (hit) { hit.hits += 1; hit.confidence = Math.max(hit.confidence, c.confidence); if (!hit.types.includes(c.type)) hit.types.push(c.type) }
    else merged.push({ x: c.x, y: c.y, type: c.type, types: [c.type], confidence: c.confidence, why: c.why, hits: 1 })
  }
  return merged
}

export function extractJson(text) {
  const s = String(text || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch (e) { return null }
}

export function outputText(resp) {
  if (!resp) return ''
  if (typeof resp.output_text === 'string') return resp.output_text
  return (resp.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ')
}

export const LEVELS = { red: 0.8, amber: 0.5 }
export function level(conf) { return conf >= LEVELS.red ? 'red' : conf >= LEVELS.amber ? 'amber' : 'low' }
// Length difference thresholds (% of the longer part). Tops need BOTH length and side-reach to agree (a bent sleeve fools one of them).
export const LENGTH_DIFF = { leg: { amber: 5, red: 8 }, sleeve: { amber: 6, red: 10 } }

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) }
  })
  await Promise.all(workers)
  return out
}

// ── API call wrappers ─────────────────────────────────────────────────────────
function imgPart(b64, mime = 'image/jpeg') { return { type: 'input_image', image_url: `data:${mime};base64,${b64}` } }

async function spark(api, text, images, effort) {
  const body = { model: MODELS.spark, input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map(b => imgPart(b))] }], reasoning: { effort: effort || 'low' } }
  const r = await api.responses(body)
  return { json: extractJson(outputText(r)), usage: (r && r.usage) || {}, raw: outputText(r) }
}

async function samRaw(api, concept, b64) {
  const body = { model: MODELS.sam, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, imgPart(b64)] }], metadata: { include_confidence: 'true', mask_encoding: 'one_bit' } }
  return outputText(await api.responses(body))
}

// opts.examples may be an array or a promise of one (the station fetches the crops while SAM runs); anything broken → no references
async function resolveExamples(ex, ms = 4000) {
  try { const list = await Promise.race([Promise.resolve(ex), new Promise(res => setTimeout(() => res([]), ms))]); return (Array.isArray(list) ? list : []).filter(e => e && typeof e.b64 === 'string' && e.b64.length > 100).slice(0, 6) } catch (e) { return [] }
}

function boxesToFull(boxes, scale, region, minFrac) {
  return boxes.map(b => ({ x1: b.x1 / scale, y1: b.y1 / scale, x2: b.x2 / scale, y2: b.y2 / scale, c: b.c }))
    .filter(b => {
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2
      const inside = cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h
      return inside && (b.x2 - b.x1) * (b.y2 - b.y1) >= minFrac * region.w * region.h
    })
}

// ── The inspection ────────────────────────────────────────────────────────────
// text the pipeline itself writes into `why` (the model's sentences stay as they come); opts.lang 'en' switches it to English
const WHY = {
  ar: { unsure: 'مش متأكد — ', two: 'شافوها بلاطتين (', leg: 'رجل', sleeve: 'كم', shorter: ' أقصر من التانية بحوالي ', approx: '% (قياس تقريبي من شكل القطعة — تأكد بالمتر)' },
  en: { unsure: 'Not sure — ', two: 'Seen in two tiles (', leg: 'One leg', sleeve: 'One sleeve', shorter: ' is shorter than the other by about ', approx: '% (rough estimate from the garment outline — check with a tape)' },
}

export async function inspect(img, opts) {
  const WT = WHY[opts && opts.lang === 'en' ? 'en' : 'ar']
  const t0 = Date.now()
  const { api } = opts
  const progress = opts.onProgress || (() => {})
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0, sam_calls: 0 }
  const acct = (u) => { usage.input_tokens += (u && u.input_tokens) || 0; usage.output_tokens += (u && u.output_tokens) || 0; usage.calls += 1 }
  // pre-seeded so the key order stays stable even though the branches finish in any order (stages overlap; total = wall-clock)
  const timings = { garment: 0, tiles: 0, verify: 0, silhouette: 0, parts: 0, global: 0, total: 0 }
  const W = img.width, H = img.height
  const g = GARMENTS[opts.garment] || GARMENTS.garment
  const conc = opts.concurrency || 6   // tiles and verify (branch L). Branch G is sequential except the 2 mirror calls → never more than 3 at once
  const warn = (stage, e, extra) => progress('warn', Object.assign({ stage, error: String((e && e.message) || e) }, extra || {}))
  const signal = opts.signal
  // Cancel (inspector pressed الغاء): the abort error is thrown OUTSIDE the per-item try/catch so it propagates instead of becoming a warn
  const checkAbort = () => { if (signal && signal.aborted) throw Object.assign(new Error('inspection aborted'), { name: 'AbortError' }) }
  const stageDone = (stage, t) => { timings[stage] = Date.now() - t; progress('stage_done', { stage, ms: timings[stage] }) }

  // ── 1) garment region + mask via SAM (downscaled copy) — the only stage both branches depend on
  checkAbort()
  progress('garment', {})
  const tG = Date.now()
  const samMax = opts.samMaxSide || 1600
  const scale = Math.min(1, samMax / Math.max(W, H))
  const small = await img.jpeg({ x: 0, y: 0, w: W, h: H, resize: { w: Math.round(W * scale), h: Math.round(H * scale) } })
  // the parts SAM call needs only this downscaled copy, not the garment region: sent now, it overlaps the garment call (~5 s off branch G)
  const partsSam = g.part ? samRaw(api, g.part, small).then((text) => { usage.sam_calls += 1; return text }) : null
  if (partsSam) partsSam.catch(() => { /* reported as a parts warning when branch G awaits it */ })
  let region = { x: 0, y: 0, w: W, h: H }, garmentBox = null, rawBox = null, mask = null, garmentFailed = false
  try {
    for (const c of [...new Set([g.concept, 'garment', 'clothing'])]) {
      const text = await samRaw(api, c, small); usage.sam_calls += 1
      const boxes = parseSamBoxes(text).filter(b => b.c == null || b.c >= 0.4)
      if (boxes.length) {
        const b = boxes.sort((p, q) => (q.x2 - q.x1) * (q.y2 - q.y1) - (p.x2 - p.x1) * (p.y2 - p.y1))[0]
        const padX = Math.round((b.x2 - b.x1) * 0.04), padY = Math.round((b.y2 - b.y1) * 0.04)
        const x1 = clamp(Math.round((b.x1 - padX) / scale), 0, W - 1), y1 = clamp(Math.round((b.y1 - padY) / scale), 0, H - 1)
        const x2 = clamp(Math.round((b.x2 + padX) / scale), x1 + 1, W), y2 = clamp(Math.round((b.y2 + padY) / scale), y1 + 1, H)
        garmentBox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, concept: c, c: b.c }
        rawBox = { x: clamp(Math.round(b.x1 / scale), 0, W), y: clamp(Math.round(b.y1 / scale), 0, H), w: Math.round((b.x2 - b.x1) / scale), h: Math.round((b.y2 - b.y1) / scale) }   // unpadded, for the edge test
        region = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
        try { mask = await maskForBox(text, opts.samParser, b) } catch (e) { warn('mask', e) }
        break
      }
    }
  } catch (e) { garmentFailed = true; warn('garment', e) }   // an API failure is NOT «no garment»: the run goes on over the whole frame and is flagged incomplete
  stageDone('garment', tG)

  // ── focus: where exactly the garment is (coarse grid from the mask) and how it sits in the frame
  let focus = null
  if (mask && opts.focus !== 'off') { try { focus = garmentGrid(mask, scale, W, H, { cell: opts.focusCell || 32, marginFrac: opts.focusMargin == null ? 0.02 : opts.focusMargin }) } catch (e) { warn('focus', e) } }
  const framing = framingCheck({ focus, box: garmentBox, rawBox, W, H })
  if (opts.foreground) { const cl = clutterPct(focus, opts.foreground); if (cl >= (opts.clutterPct == null ? 1.5 : opts.clutterPct)) framing.clutter = cl }
  progress('framing', framing)
  if (!garmentBox && !garmentFailed && opts.requireGarment !== false) {          // nothing SAM would call a garment: say so instead of inspecting the table
    progress('nogarment', { foreground: opts.foreground ? opts.foreground.areaPct : null })
    timings.total = Date.now() - t0
    return { width: W, height: H, garmentBox: null, hasMask: false, noGarment: true, tiles: 0, candidates: [], verified: [], findings: [], parts: null, usage, timings, framing, focus: null }
  }
  const paint = !!focus && opts.focus !== 'tiles'                // 'paint' (default): gray out the table inside each tile · 'tiles': only skip empty tiles

  // ── branch L: 2) tiles → Spark (local defects), then 3) verify each candidate on a 2x crop (tri-state)
  async function localBranch() {
    checkAbort()
    let t = Date.now()
    const allTiles = tileGrid(region.w, region.h, opts.tileSize || 1200, opts.overlap || 200)
    const minCov = opts.minTileCoverage == null ? 0.08 : opts.minTileCoverage
    // a tile with (almost) no garment in it is table: not sent at all
    const tiles = focus ? allTiles.filter(tl => focus.coverage({ x: region.x + tl.x, y: region.y + tl.y, w: tl.w, h: tl.h }) >= minCov) : allTiles
    progress('tiles', { count: tiles.length, skipped: allTiles.length - tiles.length })
    const tileResults = await mapLimit(tiles, conc, async (tl, i) => {
      checkAbort()
      const abs = { x: region.x + tl.x, y: region.y + tl.y, w: tl.w, h: tl.h }
      try {
        const b64 = await img.jpeg(paint ? { ...abs, keep: focus.has, fill: FILL } : abs)   // table painted out: the model only sees fabric
        const r = await spark(api, PROMPTS.tile, [b64], 'low')   // minimal was faster but missed a known hole 1 run in 3
        acct(r.usage)
        const defects = ((r.json && r.json.defects) || []).map(d => ({ ...gridToPx(d.x, d.y, abs), type: String(d.type || 'other'), confidence: clamp(+d.confidence || 0, 0, 1), why: d.why || '' }))
        progress('tile', { i, n: tiles.length, defects: defects.length })
        return { tile: abs, defects }
      } catch (e) { warn('tile', e, { i }); return { tile: abs, defects: [], error: String((e && e.message) || e) } }
    })
    const merged = mergeCandidates(tileResults.flatMap(r => r.defects))
    const candidates = focus ? merged.filter(c => focus.has(c.x, c.y)) : merged   // a spot on the table is not a garment defect
    const droppedOutside = merged.length - candidates.length
    stageDone('tiles', t)

    checkAbort()
    t = Date.now()
    const examples = candidates.length ? await resolveExamples(opts.examples) : []   // no candidates → no references needed, no wait for them
    usage.examples = examples.length
    progress('verify', { count: candidates.length, examples: examples.length })
    const win = opts.verifyWindow || 500
    const refText = examples.length ? PROMPTS.verifyRefs(examples.length) + examples.map((e, i) => `Image ${i + 1}: ${e.label === 'defect' ? 'DEFECT' : 'NOT A DEFECT'}${e.type ? ' (' + e.type + ')' : ''}${e.note ? ' — ' + String(e.note).slice(0, 100) : ''}`).join('; ') + '. ' : ''
    const refImgs = examples.map(e => e.b64)
    const verified = await mapLimit(candidates, conc, async (c) => {
      checkAbort()
      const x = clamp(c.x - win / 2, 0, Math.max(0, W - win)), y = clamp(c.y - win / 2, 0, Math.max(0, H - win))
      const abs = { x: Math.round(x), y: Math.round(y), w: Math.min(win, W), h: Math.min(win, H) }
      try {
        const b64 = await img.jpeg({ ...abs, resize: { w: 1000, h: Math.round(1000 * abs.h / abs.w) } })
        const r = await spark(api, refText + PROMPTS.verify, [...refImgs, b64], 'low')   // the references ride along on both looks
        acct(r.usage)
        let j = r.json || {}
        const norm = (o) => ['defect', 'lint', 'texture', 'unsure'].includes(o.verdict) ? o.verdict : (o.defect === true ? 'defect' : 'unsure')
        let verdict = norm(j), second = null
        // رأي تاني بتكبير أقوى (3x) لما الأول ما يأكد: «عيب» من أي واحد منهن بيكفي (المفتشة بتحسم)
        if (verdict !== 'defect') {
          const w3 = Math.round(win * 0.66)
          const x3 = clamp(c.x - w3 / 2, 0, Math.max(0, W - w3)), y3 = clamp(c.y - w3 / 2, 0, Math.max(0, H - w3))
          const abs3 = { x: Math.round(x3), y: Math.round(y3), w: Math.min(w3, W), h: Math.min(w3, H) }
          const b3 = await img.jpeg({ ...abs3, resize: { w: 1000, h: Math.round(1000 * abs3.h / abs3.w) } })
          const r3 = await spark(api, refText + PROMPTS.verify, [...refImgs, b3], 'low')   // same references: a not_defect example must be able to veto the 3x look too
          acct(r3.usage)
          second = r3.json || {}
          if (norm(second) === 'defect') { j = second; verdict = 'defect' }
          else if (norm(second) === 'unsure') verdict = 'unsure'
        }
        return { ...c, window: abs, verdict, vtype: j.type || null, vconfidence: clamp(+j.confidence || 0, 0, 1), severity: j.severity || 'minor', vwhy: j.why || '', second: second && { verdict: norm(second), confidence: second.confidence } }
      } catch (e) { return { ...c, window: abs, verdict: 'error', error: String((e && e.message) || e) } }
    })
    const findings = []
    for (const v of verified) {
      const type = v.vtype && v.vtype !== 'none' ? v.vtype : v.type
      if (v.verdict === 'defect') findings.push({ kind: 'local', source: 'tiles', type, x: v.x, y: v.y, confidence: v.vconfidence, level: level(Math.max(v.vconfidence, LEVELS.amber)), severity: v.severity, why: v.vwhy, window: v.window, hits: v.hits })   // a confirmed defect is at least amber
      else if (v.verdict === 'unsure' || v.verdict === 'error') findings.push({ kind: 'local', source: 'tiles', type, x: v.x, y: v.y, confidence: Math.min(0.79, v.confidence * 0.8), level: 'amber', severity: 'minor', why: WT.unsure + (v.vwhy || v.why || ''), window: v.window, hits: v.hits, unsure: true })
      else if ((v.hits >= 2 && v.confidence >= 0.85) || v.confidence >= 0.9) findings.push({ kind: 'local', source: 'tiles', type, x: v.x, y: v.y, confidence: 0.6, level: 'amber', severity: 'minor', why: WT.two + v.verdict + ') — ' + (v.vwhy || ''), window: v.window, hits: v.hits, unsure: true })
    }
    stageDone('verify', t)
    return { tileResults, candidates, verified, findings, allTiles: allTiles.length, droppedOutside }
  }

  // ── branch G: 4) silhouette (no model call) → 5) parts/mirror → 6) global pass. Findings kept in that order.
  async function globalBranch() {
    const parts = { part: g.part, measure: g.measure, boxes: [], silhouette: null, lengthDiffPct: null, mirror: null }
    const silFindings = [], mirrorFindings = []
    let globalFindings = []

    // ── 4) silhouette measurement from the SAM mask
    checkAbort()
    let t = Date.now()
    if (mask && g.measure) {
      try {
        const s = silhouette(mask.raster, mask.w, mask.h)
        parts.silhouette = { lenDiffPct: s.lenDiffPct, reachDiffPct: s.reachDiffPct, cx: s.cx }
        const th = LENGTH_DIFF[g.measure]
        const agree = g.measure === 'leg' ? s.lenDiffPct : Math.min(s.lenDiffPct, s.reachDiffPct)
        parts.lengthDiffPct = agree
        if (agree >= th.amber) {
          const shorterLeft = s.maxL < s.maxR
          const px = mask.left + (shorterLeft ? Math.round(s.cx - s.reachL / 2) : Math.round(s.cx + s.reachR / 2)), py = mask.top + (shorterLeft ? s.yL : s.yR)
          const conf = clamp(0.55 + (agree - th.amber) / (th.red - th.amber) * 0.35, 0.55, 0.95)
          silFindings.push({ kind: 'global', source: 'silhouette', type: 'length', x: Math.round(px / scale), y: Math.round(py / scale), confidence: conf, level: agree >= th.red ? 'red' : 'amber', severity: 'major',
            why: (g.measure === 'leg' ? WT.leg : WT.sleeve) + WT.shorter + agree + WT.approx, measure: { lenDiffPct: s.lenDiffPct, reachDiffPct: s.reachDiffPct } })
        }
      } catch (e) { warn('silhouette', e) }
    }
    stageDone('silhouette', t)

    // steps 5 and 6 only need step 1's region / small image → side by side (the mirror pass is the slowest call of the whole run)
    async function partsStep() {
      // ── 5) parts: mirror comparison (left vs mirrored right) with equalized crops
      checkAbort()
      const tP = Date.now()
      if (g.part) {
        progress('parts', { part: g.part })
        try {
          const text = await partsSam   // sent during step 1
          let boxes = boxesToFull(parseSamBoxes(text).filter(b => b.c == null || b.c >= 0.4), scale, region, 0.04)
          boxes = boxes.sort((p, q) => (q.x2 - q.x1) * (q.y2 - q.y1) - (p.x2 - p.x1) * (p.y2 - p.y1)).slice(0, 2).sort((p, q) => p.x1 - q.x1)
          parts.boxes = boxes
          if (boxes.length === 2) {
            // equalize: same height span for legs (top of both → bottom of the longer), same width span for sleeves
            let A = { ...boxes[0] }, B = { ...boxes[1] }
            if (g.measure === 'leg') { const yTop = Math.min(A.y1, B.y1), yBot = Math.max(A.y2, B.y2); A.y1 = B.y1 = yTop; A.y2 = B.y2 = yBot }
            else { const h = Math.max(A.y2 - A.y1, B.y2 - B.y1); A.y2 = A.y1 + h; B.y2 = B.y1 + h; const w = Math.max(A.x2 - A.x1, B.x2 - B.x1); A.x2 = A.x1 + w; B.x1 = B.x2 - w }   // الكفة الخارجية هي المرجع: شمال = x1، يمين = x2
            const clip = b => ({ x1: clamp(b.x1, 0, W - 2), y1: clamp(b.y1, 0, H - 2), x2: clamp(b.x2, 2, W), y2: clamp(b.y2, 2, H) })
            A = clip(A); B = clip(B)
            const crop = (b, mirror) => img.jpeg({ x: Math.round(b.x1), y: Math.round(b.y1), w: Math.round(b.x2 - b.x1), h: Math.round(b.y2 - b.y1), resize: fit(b, 1200), mirror })
            const [a, m] = await Promise.all([crop(A, false), crop(B, true)])
            // مرتين، ولازم الاتنين يقولوا «مختلف» (الحكم الواحد بيتأثر بطريقة الفرد) — الثقة = الأصغر
            const [r1, r2] = await Promise.all([spark(api, PROMPTS.mirror(g.part), [a, m], 'medium'), spark(api, PROMPTS.mirror(g.part), [a, m], 'medium')])
            acct(r1.usage); acct(r2.usage)
            const j1 = r1.json || {}, j2 = r2.json || {}
            const both = !!j1.different && !!j2.different
            const j = both ? (clamp(+j1.confidence || 0, 0, 1) <= clamp(+j2.confidence || 0, 0, 1) ? j1 : j2) : (!j1.different ? j1 : j2)
            parts.mirror = { different: both, confidence: clamp(+j.confidence || 0, 0, 1), differences: j.differences || [], why: j.why || '', votes: [!!j1.different, !!j2.different] }
            if (both && parts.mirror.confidence >= LEVELS.amber) {
              mirrorFindings.push({ kind: 'global', source: 'mirror', type: 'asymmetry', x: Math.round((B.x1 + B.x2) / 2), y: Math.round((B.y1 + B.y2) / 2), confidence: parts.mirror.confidence, level: level(parts.mirror.confidence), severity: 'major', why: (parts.mirror.differences[0] || parts.mirror.why) })
            }
          }
        } catch (e) { warn('parts', e) }
      }
      stageDone('parts', tP)

    }
    async function globalStep() {
      // ── 6) global pass (whole garment, optional reference)
      checkAbort()
      const tGl = Date.now()
      progress('global', {})
      try {
        const gMax = opts.globalMaxSide || 1600
        const gs = Math.min(1, gMax / Math.max(region.w, region.h))
        const b64 = await img.jpeg({ ...region, resize: { w: Math.round(region.w * gs), h: Math.round(region.h * gs) } })
        const imgs = [b64]
        if (opts.reference) {
          const R = opts.reference
          const rs = Math.min(1, gMax / Math.max(R.width, R.height))
          imgs.push(await R.jpeg({ x: 0, y: 0, w: R.width, h: R.height, resize: { w: Math.round(R.width * rs), h: Math.round(R.height * rs) } }))
        }
        const r = await spark(api, PROMPTS.global(!!opts.reference), imgs, 'low')
        acct(r.usage)
        globalFindings = ((r.json && r.json.findings) || []).map(f => { const c = clamp(+f.confidence || 0, 0, 1); return { kind: 'global', source: 'global', type: String(f.type || 'other'), ...gridToPx(f.x, f.y, region), confidence: c, level: level(c), severity: 'major', why: f.why || '' } }).filter(f => f.confidence >= LEVELS.amber)
      } catch (e) { warn('global', e) }
      stageDone('global', tGl)
    }
    await Promise.all([partsStep(), globalStep()])
    return { parts, findings: [...silFindings, ...mirrorFindings, ...globalFindings] }
  }

  // both branches only need step 1's region / mask / small image → run them side by side (an abort in either rejects the whole inspection)
  const [L, G] = await Promise.all([localBranch(), globalBranch()])
  timings.total = Date.now() - t0

  return {
    width: W, height: H, garmentBox, hasMask: !!mask, tiles: L.tileResults.length, candidates: L.candidates, verified: L.verified, findings: [...L.findings, ...G.findings], parts: G.parts, usage, timings,
    framing, focus: focus ? { tiles: L.allTiles, sent: L.tileResults.length, skipped: L.allTiles - L.tileResults.length, droppedOutside: L.droppedOutside, painted: paint, marginPx: focus.margin * focus.cell } : null,
  }
}

function fit(b, max) {
  const w = b.x2 - b.x1, h = b.y2 - b.y1, s = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) }
}
