// SOLANG Vision QC — «stick to the garment». Coarse occupancy grids in FULL-RES pixel space, built from the SAM mask (and, when the
// station has a stored photo of the empty table, from what differs from it). Pure functions, no DOM: shared by the browser station,
// the Node harness and dev/tests/test_focus.mjs.
//
//   garmentGrid(mask, scale, W, H, {cell, marginFrac}) → focus
//       mask = {raster, w, h, left, top} as largestMask() returns it (pixels of the downscaled SAM image, scale = small / full)
//       focus.has(X, Y)       → the full-res point lies on the garment, with a safety margin (dilated)
//       focus.coverage(rect)  → share of the rect's cells on the dilated garment (0..1)
//       focus.raw / focus.grid → undilated / dilated cell arrays (gw × gh), focus.cell = cell size in full-res px, focus.margin = cells
//   framingCheck({focus, box, W, H}) → { cut: ['top'|'bottom'|'left'|'right'…], small: bool, areaPct }
//       cut = the UNdilated garment reaches the photo edge (part of it is outside the frame); small = the SAM box is under smallPct of the frame
//   foregroundGrid(cur, bg, w, h, {W, H, cell, z}) → { gw, gh, cell, grid, areaPct }
//       cur/bg = gray Uint8 arrays of the same small size; pixels that differ from the empty table after exposure normalisation
//   clutterPct(focus, fg, extraCells) → % of the frame that is foreground but not garment (hand, tool, a second piece)

export function makeGrid(W, H, cell) {
  const gw = Math.max(1, Math.ceil(W / cell)), gh = Math.max(1, Math.ceil(H / cell))
  return { W, H, cell, gw, gh, grid: new Uint8Array(gw * gh) }
}

// square dilation by r cells, separable (two passes), new array
export function dilate(grid, gw, gh, r) {
  if (!(r > 0)) return grid.slice()
  const tmp = new Uint8Array(gw * gh), out = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let v = 0
    for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < gw && grid[y * gw + xx]) v = 1 }
    tmp[y * gw + x] = v
  }
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let v = 0
    for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < gh && tmp[yy * gw + x]) v = 1 }
    out[y * gw + x] = v
  }
  return out
}

export function garmentGrid(mask, scale, W, H, { cell = 32, marginFrac = 0.02 } = {}) {
  if (!mask || !mask.raster || !mask.w || !mask.h) return null
  const g = makeGrid(W, H, cell), raw = g.grid, inv = 1 / (scale || 1)
  for (let y = 0; y < mask.h; y++) {
    const gy = Math.min(g.gh - 1, Math.max(0, Math.floor(((mask.top || 0) + y) * inv / cell)))
    const row = y * mask.w
    for (let x = 0; x < mask.w; x++) {
      if (!mask.raster[row + x]) continue
      const gx = Math.min(g.gw - 1, Math.max(0, Math.floor(((mask.left || 0) + x) * inv / cell)))
      raw[gy * g.gw + gx] = 1
    }
  }
  const margin = Math.max(1, Math.ceil(marginFrac * Math.max(W, H) / cell))
  const grid = dilate(raw, g.gw, g.gh, margin)
  let cells = 0
  for (let i = 0; i < raw.length; i++) cells += raw[i]
  const { gw, gh } = g
  return {
    W, H, cell, gw, gh, raw, grid, margin, cells,
    has(X, Y) {
      const gx = Math.floor(X / cell), gy = Math.floor(Y / cell)
      return gx >= 0 && gy >= 0 && gx < gw && gy < gh && grid[gy * gw + gx] === 1
    },
    coverage(rect) {
      const x0 = Math.max(0, Math.floor(rect.x / cell)), y0 = Math.max(0, Math.floor(rect.y / cell))
      const x1 = Math.min(gw - 1, Math.floor((rect.x + rect.w - 1) / cell)), y1 = Math.min(gh - 1, Math.floor((rect.y + rect.h - 1) / cell))
      if (x1 < x0 || y1 < y0) return 0
      let on = 0, n = 0
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { n++; on += grid[y * gw + x] }
      return n ? on / n : 0
    },
  }
}

export function framingCheck({ focus, box, W, H, smallPct = 6, edgeCells = 1, edgeFrac = 0.01 } = {}) {
  const cut = []
  if (focus) {
    const { raw, gw, gh } = focus
    const any = (pred) => { for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (raw[y * gw + x] && pred(x, y)) return true; return false }
    if (any((x, y) => y < edgeCells)) cut.push('top')
    if (any((x, y) => y >= gh - edgeCells)) cut.push('bottom')
    if (any((x) => x < edgeCells)) cut.push('left')
    if (any((x) => x >= gw - edgeCells)) cut.push('right')
  } else if (box) {
    if (box.y <= edgeFrac * H) cut.push('top')
    if (box.y + box.h >= (1 - edgeFrac) * H) cut.push('bottom')
    if (box.x <= edgeFrac * W) cut.push('left')
    if (box.x + box.w >= (1 - edgeFrac) * W) cut.push('right')
  }
  const areaPct = box ? Math.round(1000 * (box.w * box.h) / (W * H)) / 10 : 0
  return { cut, small: !!box && areaPct < smallPct, areaPct }
}

// exposure-normalised absolute difference against the empty table, pooled into the full-res cell grid
export function foregroundGrid(cur, bg, w, h, { W, H, cell = 32, z = 0.9, minShare = 0.5 } = {}) {
  if (!cur || !bg || cur.length !== w * h || bg.length !== w * h) return null
  const norm = (a) => {
    let s = 0, s2 = 0
    for (let i = 0; i < a.length; i++) { s += a[i]; s2 += a[i] * a[i] }
    const mean = s / a.length, sd = Math.sqrt(Math.max(1e-6, s2 / a.length - mean * mean))
    const out = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) out[i] = (a[i] - mean) / sd
    return out
  }
  const nc = norm(cur), nb = norm(bg)
  const g = makeGrid(W, H, cell), hits = new Uint16Array(g.gw * g.gh), tot = new Uint16Array(g.gw * g.gh)
  const sx = W / w, sy = H / h
  for (let y = 0; y < h; y++) {
    const gy = Math.min(g.gh - 1, Math.floor(y * sy / cell))
    for (let x = 0; x < w; x++) {
      const gx = Math.min(g.gw - 1, Math.floor(x * sx / cell)), k = gy * g.gw + gx
      tot[k]++
      if (Math.abs(nc[y * w + x] - nb[y * w + x]) > z) hits[k]++
    }
  }
  let on = 0
  for (let k = 0; k < g.grid.length; k++) { if (tot[k] && hits[k] / tot[k] >= minShare) { g.grid[k] = 1; on++ } }
  return { gw: g.gw, gh: g.gh, cell, grid: g.grid, areaPct: Math.round(1000 * on / g.grid.length) / 10 }
}

// share of the frame (%) that differs from the empty table but is not the garment (even with an extra margin for its shadow)
export function clutterPct(focus, fg, extraCells = 2) {
  if (!fg) return 0
  if (!focus) return fg.areaPct
  if (focus.gw !== fg.gw || focus.gh !== fg.gh) return 0
  const wide = dilate(focus.grid, focus.gw, focus.gh, extraCells)
  let n = 0
  for (let k = 0; k < fg.grid.length; k++) if (fg.grid[k] && !wide[k]) n++
  return Math.round(1000 * n / fg.grid.length) / 10
}
