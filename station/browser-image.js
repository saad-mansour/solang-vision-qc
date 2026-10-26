// SOLANG Vision QC — browser image adapter (media agent). Contract: station/CONTRACTS.md §4.
// Wraps an ImageBitmap so shared/pipeline.js can ask for crops as base64 JPEG. Crops are drawn straight
// from the bitmap into a canvas of the OUTPUT size, so a 24 MP photo costs one bitmap and never a second
// full-resolution RGBA copy. Nothing here touches window/document at module top level (Node can import it).

const MAX_SIDE = 4096   // iOS Safari refuses canvases above ~16.7 MP; 4096 on the longest side is safe everywhere we run

/** Largest {w, h} that fits inside maxSide × maxSide keeping the aspect ratio. Never upscales (scale ≤ 1). */
export function fitWithin(w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(1, w, h))
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale }
}

/** Clamp a crop rect (full-res px, may hang outside the image) to the W×H image. Missing fields = whole image. */
export function clampRect(r, W, H) {
  const x0 = Number.isFinite(r?.x) ? r.x : 0, y0 = Number.isFinite(r?.y) ? r.y : 0
  const w0 = Number.isFinite(r?.w) ? r.w : W - x0, h0 = Number.isFinite(r?.h) ? r.h : H - y0
  const x1 = clamp(Math.round(x0), 0, W - 1), y1 = clamp(Math.round(y0), 0, H - 1)
  const x2 = clamp(Math.round(x0 + w0), x1 + 1, W), y2 = clamp(Math.round(y0 + h0), y1 + 1, H)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// OffscreenCanvas only when it can also encode: some Safari builds have the class but no convertToBlob.
const offscreenOk = () => typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function'

/** A canvas we can draw on and encode: OffscreenCanvas, else a detached <canvas> (never appended to the page). */
export function makeCanvas(w, h) {
  if (offscreenOk()) return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

/** canvas (either kind) → Blob. */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('canvas.toBlob failed'))), type, quality))
}

// Release the backing store now instead of waiting for GC (iOS keeps canvas memory around otherwise).
export const freeCanvas = c => { c.width = 0; c.height = 0 }

/** Blob → base64 WITHOUT the data: prefix. arrayBuffer + chunked btoa; FileReader's data URL would be a second full copy. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function makeAdapter(bitmap, source) {
  const W = bitmap.width, H = bitmap.height
  const previews = new Map()   // maxSide → object URL (cached, revoked in close())
  let closed = false
  const alive = () => { if (closed) throw new Error('image adapter is closed') }

  // One crop of the bitmap into a fresh canvas of the output size.
  // resize: {w,h} | {w} | {h} (missing side keeps aspect) | number (max side). mirror → horizontal flip.
  function render({ x, y, w, h, resize, mirror } = {}) {
    alive()
    const r = clampRect({ x, y, w, h }, W, H)
    let ow = r.w, oh = r.h
    if (typeof resize === 'number') ({ w: ow, h: oh } = fitWithin(r.w, r.h, resize))
    else if (resize && (resize.w || resize.h)) {
      ow = resize.w ? Math.round(resize.w) : Math.round(resize.h * r.w / r.h)
      oh = resize.h ? Math.round(resize.h) : Math.round(resize.w * r.h / r.w)
    }
    ;({ w: ow, h: oh } = fitWithin(ow, oh, MAX_SIDE))
    const c = makeCanvas(ow, oh), ctx = c.getContext('2d', { alpha: false })
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (mirror) { ctx.translate(ow, 0); ctx.scale(-1, 1) }
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, ow, oh)
    return c
  }
  async function encode(opts, quality) {
    const c = render(opts)
    try { return await canvasToBlob(c, 'image/jpeg', quality) } finally { freeCanvas(c) }
  }

  return {
    width: W, height: H, source, bitmap,
    /** crop → base64 JPEG (quality 0.9), no data: prefix — what shared/pipeline.js calls. */
    jpeg: async (o = {}) => blobToBase64(await encode(o, 0.9)),
    /** crop → Blob image/jpeg (default quality 0.92) for uploads and thumbnails. Omit x/y/w/h for the whole photo. */
    blob: (o = {}) => encode(o, o.quality ?? 0.92),
    /** object URL of a downscaled JPEG for display; cached per maxSide, revoked by close(). */
    async previewUrl(maxSide = 1600) {
      alive()
      if (previews.has(maxSide)) return previews.get(maxSide)
      const url = URL.createObjectURL(await encode({ resize: maxSide }, 0.85))
      if (closed) { URL.revokeObjectURL(url); throw new Error('image adapter is closed') }   // closed while encoding
      previews.set(maxSide, url)
      return url
    },
    close() {
      if (closed) return
      closed = true
      for (const u of previews.values()) URL.revokeObjectURL(u)
      previews.clear()
      try { bitmap.close() } catch { /* already closed */ }
    },
  }
}

/** Blob (camera photo / picked file) → adapter, EXIF orientation applied. */
export async function fromBlob(blob) {
  let bmp
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }) }
  catch { bmp = await createImageBitmap(blob) }   // older Safari rejects the option; its decoder applies EXIF by default anyway
  return makeAdapter(bmp, blob.source || 'blob')
}

/** Current frame of a playing <video> at the track's own resolution → adapter. */
export async function fromVideoFrame(videoEl) {
  const w = videoEl && videoEl.videoWidth, h = videoEl && videoEl.videoHeight
  if (!w || !h) throw new Error('video has no frame yet')
  const c = makeCanvas(w, h)
  c.getContext('2d', { alpha: false }).drawImage(videoEl, 0, 0, w, h)
  try { return makeAdapter(await createImageBitmap(c), 'frame') } finally { freeCanvas(c) }   // the bitmap is a copy; the canvas can go
}
