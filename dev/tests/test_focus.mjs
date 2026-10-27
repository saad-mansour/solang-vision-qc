// Unit checks for shared/focus.js on synthetic masks (no model, no network). Run: node dev/tests/test_focus.mjs
import { garmentGrid, framingCheck, foregroundGrid, clutterPct, dilate } from '../../shared/focus.js'

let fail = 0
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fail++ }

// a 1000×800 «small» SAM image for a 2000×1600 photo (scale 0.5); the garment mask is a rectangle 200..700 × 100..600 (small px)
const W = 2000, H = 1600, scale = 0.5
const mask = { w: 500, h: 500, left: 200, top: 100, raster: new Uint8Array(500 * 500).fill(1) }
const f = garmentGrid(mask, scale, W, H, { cell: 32, marginFrac: 0.02 })
check(f && f.gw === 63 && f.gh === 50, `grid is ${f.gw}×${f.gh} cells of ${f.cell} px`)
check(f.margin === 2, `margin is ${f.margin} cells (2 % of 2000 px / 32)`)
check(f.has(900, 700), 'center of the garment is kept')
check(f.has(401 + 10, 700), 'just inside the left edge is kept')
check(f.has(400 - 40, 700), 'the 2-cell margin outside the left edge is still kept')
check(!f.has(400 - 200, 700), '200 px outside the garment is not kept')
check(!f.has(100, 100) && !f.has(1990, 1590), 'far corners are not kept')
check(!f.has(-5, 10) && !f.has(2005, 10), 'points outside the image are not kept (no throw)')
check(f.coverage({ x: 600, y: 400, w: 400, h: 400 }) === 1, 'a tile fully on the garment has coverage 1')
check(f.coverage({ x: 0, y: 0, w: 300, h: 150 }) === 0, 'a tile on the bare table has coverage 0')
const half = f.coverage({ x: 300, y: 400, w: 200, h: 400 })
check(half > 0.3 && half < 0.9, `a tile straddling the edge has partial coverage (${half.toFixed(2)})`)

const fr = framingCheck({ focus: f, box: { x: 400, y: 200, w: 1000, h: 1000 }, W, H })
check(fr.cut.length === 0 && fr.small === false && fr.areaPct === 31.3, `well-framed garment: no cut, not small, ${fr.areaPct} % of the frame`)
const edgeMask = { w: 300, h: 400, left: 0, top: 50, raster: new Uint8Array(300 * 400).fill(1) }   // touches the left edge
const fe = garmentGrid(edgeMask, scale, W, H)
const fre = framingCheck({ focus: fe, box: { x: 0, y: 100, w: 600, h: 800 }, W, H })
check(fre.cut.join() === 'left', `garment on the left edge → cut = [${fre.cut}]`)
const frb = framingCheck({ focus: null, box: { x: 10, y: 1500, w: 300, h: 100 }, W, H })
check(frb.cut.join() === 'bottom,left' && frb.small === true, `no mask: box touching bottom+left and tiny → cut = [${frb.cut}], small`)

// dilation: a single cell grows to a 3×3 block with r = 1
const g1 = new Uint8Array(25); g1[12] = 1
const d1 = dilate(g1, 5, 5, 1)
check(d1.reduce((a, b) => a + b, 0) === 9 && d1[0] === 0, 'dilate r=1 turns one cell into a 3×3 block')

// foreground: the empty table is flat gray; the current frame has a bright square (garment) and a small bright dot (a tool)
const w = 100, h = 80
const bg = new Uint8Array(w * h).fill(120), cur = new Uint8Array(w * h).fill(120)
for (let y = 20; y < 60; y++) for (let x = 30; x < 70; x++) cur[y * w + x] = 220            // garment
for (let y = 5; y < 10; y++) for (let x = 85; x < 95; x++) cur[y * w + x] = 230              // tool, far from the garment
const fg = foregroundGrid(cur, bg, w, h, { W, H, cell: 32 })
check(fg && fg.areaPct > 15 && fg.areaPct < 30, `foreground covers ${fg.areaPct} % (garment ≈ 20 % + a dot)`)
const fgNone = foregroundGrid(bg, bg, w, h, { W, H, cell: 32 })
check(fgNone.areaPct === 0, 'identical frames → no foreground')
// the garment mask that matches the bright square: small-image px of the SAM copy = cur grid scaled ×10 (1000×800) → left 300, top 200, 400×400
const gm = garmentGrid({ w: 400, h: 400, left: 300, top: 200, raster: new Uint8Array(400 * 400).fill(1) }, scale, W, H)
const cl = clutterPct(gm, fg)
check(cl > 0 && cl < 3, `clutter outside the garment = ${cl} % (the dot only)`)
const brighter = cur.map((v) => Math.min(255, v + 40))                                          // exposure shift of the whole frame
const fgShift = foregroundGrid(brighter, bg, w, h, { W, H, cell: 32 })
check(Math.abs(fgShift.areaPct - fg.areaPct) < 3, `a global exposure shift does not create foreground (${fgShift.areaPct} % vs ${fg.areaPct} %)`)

console.log(fail ? `\n${fail} check(s) failed` : '\nall focus checks passed')
process.exit(fail ? 1 : 0)
