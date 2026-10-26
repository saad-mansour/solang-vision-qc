// SOLANG Vision QC — camera + stillness detector (media agent). Contract: station/CONTRACTS.md §5.
// Imports cleanly in Node (dev/tests/test_stillness.mjs drives StillnessDetector with synthetic frames):
// every window/document/navigator access lives inside a function, never at module top level.
import { makeCanvas, canvasToBlob, freeCanvas } from './browser-image.js'

/* ───────────────────────────── camera ───────────────────────────── */

/**
 * Open the camera into videoEl (muted, inline) → { stream, track, settings, capabilities, facing, stop() }.
 * Needs a secure context (https or localhost) or getUserMedia does not exist at all.
 * A stream already attached to videoEl is stopped first: iOS allows one live camera at a time, so the
 * «🔄 كاميرا» switch is simply openCamera(videoEl, { facing: other }).
 */
export async function openCamera(videoEl, { facing = 'environment', idealWidth = 4096, idealHeight = 3072 } = {}) {
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices
  if (!md || typeof md.getUserMedia !== 'function') {
    const e = new Error('getUserMedia unavailable (needs https or localhost)'); e.name = 'NotSupportedError'; throw e
  }
  stopStream(videoEl.srcObject)
  const constraints = { video: { facingMode: { ideal: facing }, width: { ideal: idealWidth }, height: { ideal: idealHeight } }, audio: false }
  const stream = await md.getUserMedia(constraints)
  const track = stream.getVideoTracks()[0]
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.setAttribute('muted', ''); videoEl.setAttribute('playsinline', '')   // iOS checks the attributes for inline autoplay
  videoEl.srcObject = stream
  await videoEl.play()
  if (!videoEl.videoWidth) {   // play() resolved but the first frame size is not known yet on some browsers
    await new Promise(r => {
      let t
      const done = () => { clearTimeout(t); r() }
      t = setTimeout(done, 3000)
      for (const ev of ['loadedmetadata', 'resize']) videoEl.addEventListener(ev, done, { once: true })
    })
  }
  const settings = safe(() => track.getSettings(), {})
  const capabilities = safe(() => track.getCapabilities(), {})
  return {
    stream, track, settings, capabilities,
    facing: settings.facingMode || facing,
    stop() { stopStream(stream); if (videoEl.srcObject === stream) videoEl.srcObject = null },
  }
}

/**
 * Full-resolution photo → Blob image/jpeg with blob.source = 'imagecapture' | 'frame'.
 * ImageCapture (Chrome/Android) gives the sensor's photo resolution; anything going wrong there (missing API,
 * rejected sizes, a hang — 4 s cap) falls back to drawing the current video frame at track resolution.
 */
export async function takePhoto(cam, videoEl) {
  const track = cam && cam.track
  if (track && track.readyState === 'live' && typeof ImageCapture === 'function') {
    try {
      const blob = await withTimeout(captureViaImageCapture(track), 4000)
      if (blob && blob.size) { blob.source = 'imagecapture'; return blob }
    } catch (e) { console.warn('ImageCapture failed, using a frame grab:', e && e.message) }
  }
  const blob = await frameGrab(videoEl)
  blob.source = 'frame'
  return blob
}

async function captureViaImageCapture(track) {
  const ic = new ImageCapture(track)
  let opts = {}
  try {
    const cap = await ic.getPhotoCapabilities()
    if (cap?.imageWidth?.max > 0 && cap?.imageHeight?.max > 0) opts = { imageWidth: cap.imageWidth.max, imageHeight: cap.imageHeight.max }
  } catch { /* no photo capabilities: let the device pick */ }
  let blob
  try { blob = await ic.takePhoto(opts) }
  catch (e) { if (!Object.keys(opts).length) throw e; blob = await ic.takePhoto() }   // some phones reject explicit sizes
  return blob.type === 'image/jpeg' ? blob : reencodeJpeg(blob)   // desktop webcams hand back PNG; keep the contract
}

async function reencodeJpeg(blob) {
  const bmp = await createImageBitmap(blob)
  try {
    const c = makeCanvas(bmp.width, bmp.height)
    c.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0)
    try { return await canvasToBlob(c, 'image/jpeg', 0.95) } finally { freeCanvas(c) }
  } finally { bmp.close() }
}

async function frameGrab(videoEl) {
  const w = videoEl && videoEl.videoWidth, h = videoEl && videoEl.videoHeight
  if (!w || !h) throw new Error('no video frame to capture')
  const c = makeCanvas(w, h)
  c.getContext('2d', { alpha: false }).drawImage(videoEl, 0, 0, w, h)
  try { return await canvasToBlob(c, 'image/jpeg', 0.95) } finally { freeCanvas(c) }
}

const safe = (fn, dflt) => { try { return fn() ?? dflt } catch { return dflt } }
function stopStream(s) { if (s && typeof s.getTracks === 'function') s.getTracks().forEach(t => t.stop()) }
function withTimeout(p, ms) {
  let t
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout after ' + ms + ' ms')), ms) })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

/* ───────────────────────── stillness detector ───────────────────────── */

/**
 * Draw the video frame downscaled to w×h into `canvas` (reused between calls) and return its luma bytes
 * (0.299 R + 0.587 G + 0.114 B), one byte per pixel, row-major. ~3 KB per frame at 64×48.
 */
export function grayscaleSample(videoEl, canvas, w, h) {
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(videoEl, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  return out
}

function meanAbsDiff(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d < 0 ? -d : d }
  return a.length ? s / a.length : 0
}
const nowMsDefault = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

/**
 * Pure state machine over downscaled grayscale frames (no DOM). Score = mean |Δ| between consecutive frames (0–255).
 *
 *   idle ──score>move──▶ moving ──score<still──▶ settling ──stillMs elapsed──▶ still (onStill fires once)
 *                           ▲                       │ score>move                     │ or 'same' when the settled frame
 *                           │                       ▼                                ▼   equals the last captured one
 *                           └──────── score>move ── cooldown ◀──────────────────────┘
 *                                                   │ cooldownMs elapsed, no motion
 *                                                   ▼
 *                                                  idle
 *
 * Thresholds (defaults, luma units on a 64×48 sample):
 *   moveThreshold 8      a hand crossing the frame or a garment being laid down scores 15–60; a resting scene with
 *                        sensor noise + auto-exposure drift stays at 0.5–2. 8 is well above noise, well below motion.
 *   stillThreshold 2.5   below this two consecutive samples are "the same picture" (noise only).
 *   stillMs 1200         the scene must hold still this long: hands have let go, but the table is not slowed down.
 *   cooldownMs 4000      after a capture ignore small changes (shutter/exposure glitch) unless real motion restarts.
 *   sameSceneThreshold 1.5  settled frame vs last captured frame: < 1.5 is the same garment in the same place →
 *                        state 'same', no second photo. Moving the garment even 1 cm scores > 3.
 *   sampleW/H 64×48      the size the app should pass to grayscaleSample (exposed as det.sampleW / det.sampleH).
 * Stillness is timed from the EARLIER frame of the first still pair: a low score at t means the scene already
 * looked like this at the previous sample, so that is when it stopped moving.
 */
export class StillnessDetector {
  constructor({ moveThreshold = 8, stillThreshold = 2.5, stillMs = 1200, cooldownMs = 4000, sameSceneThreshold = 1.5, sampleW = 64, sampleH = 48 } = {}) {
    Object.assign(this, { moveThreshold, stillThreshold, stillMs, cooldownMs, sameSceneThreshold, sampleW, sampleH })
    this.onStill = null   // callback({ gray, w, h, score, at }) assigned by the app
    this.reset()
  }

  reset() {
    this.state = 'idle'
    this.lastScore = 0
    this._prev = null; this._prevAt = 0       // previous sample (own copy) and its time
    this._captured = null                     // sample at the last emitted 'still' (same-scene check)
    this._settleStart = 0; this._cooldownStart = 0
  }

  /** Tell the detector the current scene was photographed by hand (manual «📸 افحص هلق»), so auto-capture skips it. */
  markScene(gray) { this._captured = gray ? gray.slice() : null }

  /** One downscaled grayscale frame → { state, score }. */
  feed(gray, w, h, nowMs) {
    const now = nowMs ?? nowMsDefault()
    const prev = this._prev, prevAt = this._prevAt
    const score = prev && prev.length === gray.length ? meanAbsDiff(gray, prev) : 0   // first frame / size change → 0
    this._prev = gray.slice()   // own copy: the caller may reuse its buffer
    this._prevAt = now
    this.lastScore = score

    let s = this.state
    if (s === 'still' || s === 'same') s = 'cooldown'   // both are one-frame states, reported once
    if (s === 'idle') {
      if (score > this.moveThreshold) s = 'moving'
    } else if (s === 'moving') {
      if (score < this.stillThreshold) { s = 'settling'; this._settleStart = prev ? prevAt : now }
    } else if (s === 'settling') {
      if (score > this.moveThreshold) s = 'moving'
      else if (score >= this.stillThreshold) this._settleStart = now   // small jitter: keep waiting, restart the clock
      else if (now - this._settleStart >= this.stillMs) {
        const cap = this._captured
        if (cap && cap.length === gray.length && meanAbsDiff(gray, cap) < this.sameSceneThreshold) s = 'same'
        else { s = 'still'; this._captured = this._prev }
        this._cooldownStart = now
      }
    } else if (s === 'cooldown') {
      if (score > this.moveThreshold) s = 'moving'
      else if (now - this._cooldownStart >= this.cooldownMs) s = 'idle'
    }
    this.state = s

    if (s === 'still' && typeof this.onStill === 'function') {
      try { this.onStill({ gray: this._captured, w, h, score, at: now }) }
      catch (e) { console.error('onStill handler failed:', e) }
    }
    return { state: s, score }
  }
}
