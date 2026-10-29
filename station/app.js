// SOLANG Vision QC — station UI controller (owner: UI agent). Binding spec: station/CONTRACTS.md §6.
// Flow: live camera → StillnessDetector → full-res photo → inspect() from shared/pipeline.js → numbered circles + cards →
// inspector confirms / rejects / adds spots → decision → saved to the demo Supabase (inspection, photos, findings, examples).
// The page suggests, the inspector decides. All text goes through textContent (the model returns free text).
import { inspect } from '../shared/pipeline.js'
import * as samParser from './vendor/meta-sam-parser/index.js'
import { makeApi, makeDb } from './api.js'
import { fromBlob, makeCanvas, canvasToBlob, blobToBase64, freeCanvas } from './browser-image.js'
import { foregroundGrid } from '../shared/focus.js'
import { openCamera, takePhoto, StillnessDetector, grayscaleSample } from './camera.js'
import { openLink } from './link.js'
import { makeSender, makeViewer } from './live.js'
import { t, LANG, isEn, setLang, applyStatic, langChosen } from './i18n.js'
import { showWelcome, welcomed } from './welcome.js'

const TYPE_AR = { hole: t('خرم'), snag: t('سحبة'), stain: t('بقعة'), loose_thread: t('خيط طالع'), stitching: t('درزة'), puckering: t('تكرمش'), unfinished_edge: t('حافة مش مخلّصة'), asymmetry: t('فرق بين الجهتين'), length: t('طول مختلف'), print: t('طباعة'), missing_part: t('قطعة ناقصة'), other: t('شي تاني') }
const DEC_AR = { pass: t('سليمة'), repair: t('تصليح'), reject: t('مرفوضة') }
const DEC_EMOJI = { pass: '✅', repair: '🔧', reject: '❌' }
const SIDE_AR = { front: t('وجه'), back: t('ضهر') }
const PILL = { idle: t('جاهزة'), moving: t('في حركة'), settling: t('ثابتة…'), still: t('📸 لقطة!'), cooldown: t('جاهزة'), same: t('نفس القطعة') }
const SAMPLE_W = 64, SAMPLE_H = 48           // detector sample size (matches StillnessDetector defaults)
// Two-device setup: the phone above the table opens ?mode=camera (captures, inspects and saves automatically, decision left
// open), the inspector's tablet opens ?mode=review (no camera; new inspections pop up for confirm/reject/decision).
// The setup screen (role + pairing code + name) stores the role on the device; ?mode=all is the single-device mode (demo, desktop testing).
const PARAMS = new URLSearchParams(location.search)
const ROLES = ['camera', 'review', 'all']
// the device role: ?mode= (docs, tests) wins; otherwise what the setup screen stored on this device (localStorage vqc_role);
// nothing yet → MODE is null and init() shows the setup screen instead of starting anything
const MODE = ROLES.includes(PARAMS.get('mode')) ? PARAMS.get('mode') : ROLES.includes((() => { try { return localStorage.getItem('vqc_role') } catch (e) { return null } })()) ? localStorage.getItem('vqc_role') : null
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname)   // dev-only switches: ?fakecam=1 (drawn test pattern instead of a camera), ?station=x (own link channel)
const REVIEW_POLL_MS = 3000, CAMERA_NEXT_MS = 4000
const LINK_STATE_MS = 2000, PEER_TTL_MS = 7000, ACK_WAIT_MS = 4000   // phone ⇄ tablet link: state every 2 s, a peer silent for 7 s is gone, a shot request waits 4 s for its ack
const LIVE_RETRY_MS = 8000, LIVE_GRACE_MS = 5000                      // the tablet asks for the live view again when no frame arrived within 8 s; a stall shorter than 5 s keeps the last frame
const LIVE_ON_MS = 90000                                               // «📡 شوف الكاميرا» keeps the live view for 90 s (another tap extends it); the shot closes it
const SVG_NS = 'http://www.w3.org/2000/svg'
const BIG_PHOTO = 30 * 1024 * 1024           // JPEG originals are uploaded as-is below this (a 24 MP phone JPEG is 5–7 MB); only non-JPEG picks are re-encoded

// ── state ────────────────────────────────────────────────────────────────────
const S = {
  cfg: null, api: null, db: null,
  orders: [], workers: [], order: null, side: 'front', inspector: '',
  view: 'camera',                              // camera | inspect | history
  cam: null, facing: 'environment', det: null, sampleCanvas: null, loop: null, autoCapture: true, pillHold: 0, capturing: false,
  running: false, controller: null, runStarted: 0, timer: null, warns: [], tilesDone: 0,
  img: null, blob: null, res: null, findings: [], decision: null,
  job: null,                                   // the save job of the current inspection (resumable on retry)
  detached: [],                                // save jobs of previous pieces that are still running or failed (retry from the banner)
  incomplete: null,                            // set when model calls failed during the run: the result must not read as «clean»
  pending: null,                               // tap point waiting for a type in the picker
  history: [], histSeq: 0,
  camStarting: false, wakeLock: null,
  reviewId: null, reviewDate: null, reviewBusy: false, reviewLocked: false, reviewTimer: null, lastPending: 0,   // ?mode=review
  link: null, linkUp: false, peer: null, peerSeen: 0, capReq: null, lastSavedId: null, linkTimer: null,              // phone ⇄ tablet link (link.js)
  peers: new Map(), twinSeen: 0,                                                                                       // review: every camera page heard (by boot); camera: another camera page on this station
  live: null, liveBig: false, liveLostAt: 0, liveWasLive: false, peerBoot: null, boot: Math.random().toString(36).slice(2),   // live view (live.js); boot = this page load's identity
  liveFrozenAt: 0,                                                                                                     // the live tile shows the frozen shot while the phone inspects
  liveWanted: false, liveUntil: 0,                                                                                     // the live view is on demand: «📡» opens it for LIVE_ON_MS, a shot closes it
  seenReq: new Set(), lastRemoteShot: 0,                                                                              // remote shots: no replays, one per 6 s
  noGarment: false, framing: null,                                                                                    // focus / framing of the current run
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n }
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }
const opt = (v, t) => { const o = el('option', null, t); o.value = v; return o }
const msg = (e) => String((e && e.message) || e || t('خطأ غير معروف'))
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
const lsGet = (k) => { try { return localStorage.getItem(k) } catch (e) { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } }
const safeClose = (img) => { try { img && img.close() } catch (e) { /* already closed */ } }
const loadImage = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image load failed')); im.src = url })

let toastT = { t: 0, m: '' }
function toast(m, ms = 2400) {
  const now = Date.now(); if (m === toastT.m && now - toastT.t < 3000) return      // no toast spam for the same message
  toastT = { t: now, m }; const t = $('toast'); t.textContent = m; t.hidden = false
  clearTimeout(toast._h); toast._h = setTimeout(() => { t.hidden = true }, ms)
}
function banner(text, btnText, fn) {
  const b = $('banner'), row = el('div', null, text)
  if (btnText && fn) {
    const btn = el('button', 'btn small', btnText); btn.type = 'button'
    btn.addEventListener('click', () => { row.remove(); if (!b.children.length) b.hidden = true; fn() })
    row.appendChild(document.createTextNode(' ')); row.appendChild(btn)
  }
  b.appendChild(row); b.hidden = false
}
// keep the tablet awake while the station is open (hands-free use); re-acquired when the tab becomes visible again
async function requestWakeLock() {
  try { if (navigator.wakeLock && document.visibilityState === 'visible') S.wakeLock = await navigator.wakeLock.request('screen') } catch (e) { /* unsupported or denied */ }
}

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  applyStatic()                                 // English UI when chosen (i18n.js); the Arabic source text is the key
  wireSetup()
  // first visit: pick a language, then a 3-step how-to — before anything asks for the camera (welcome.js); «?» reopens the how-to
  if (!langChosen() || !welcomed() || PARAMS.has('welcome')) await showWelcome(langChosen() ? 'how' : 'lang')
  if (!MODE) { showSetup(); return }            // no role on this device yet: the setup screen (role + pairing code + name) ends with a reload
  document.body.classList.add('mode-' + MODE)
  if (MODE === 'camera') $('inspector').placeholder = t('اسم الجهاز (متل: كاميرا 1)')
  buildPicker(); wire()
  S.inspector = lsGet('vqc_inspector') || ''; $('inspector').value = S.inspector
  try { S.cfg = (await import('./config.js')).default } catch (e) { banner(t('ملف الإعدادات station/config.js مش موجود — انسخ config.example.js وعبّيه')) }
  if (S.cfg) {
    try { S.api = makeApi(S.cfg) } catch (e) { banner(t('ما قدرت جهّز الاتصال بالموديل: ') + msg(e)) }
    try { S.db = makeDb(S.cfg) } catch (e) { banner(t('ما قدرت جهّز الاتصال بالقاعدة: ') + msg(e)) }
  }
  renderCards(); renderBgStatus()
  // DB loads run in parallel with the camera start; each failure is shown and the page stays usable
  if (S.db) {
    S.db.listOrders().then(renderOrders, (e) => banner(t('ما قدرت جيب الطلبيات: ') + msg(e)))
    S.db.listWorkers().then((w) => { S.workers = w || [] }, (e) => banner(t('ما قدرت جيب العمال: ') + msg(e)))
    refreshStats(); loadHistory()
  }
  // the camera starts by itself once it worked on this device (vqc_cam_ok); the first time a clear «شغّل الكاميرا» tap asks for it
  if (MODE === 'review') startReview(); else if (lsGet('vqc_cam_ok') === '1' || (DEV && PARAMS.has('fakecam'))) startCamera(); else showCamStart('')
  $('linkBar').hidden = MODE !== 'review'
  if (MODE !== 'all' && S.cfg && S.cfg.SUPABASE_URL && S.cfg.SUPABASE_KEY) startLink()      // the two device modes talk over the Realtime link
  requestWakeLock(); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWakeLock() })
}

function wire() {
  $('orderSel').addEventListener('change', () => { S.order = S.orders[+$('orderSel').value] || null; if (S.order) lsSet('vqc_order', S.order.order_number); renderRef() })
  $('btnRef').addEventListener('click', setReferenceFromCurrent)
  $('btnRefFile').addEventListener('click', () => $('refInput').click())
  $('refInput').addEventListener('change', () => { const f = $('refInput').files && $('refInput').files[0]; $('refInput').value = ''; if (f) setReferenceFromFile(f) })
  $('btnRefClear').addEventListener('click', clearReference)
  $('sideFront').addEventListener('click', () => setSide('front'))
  $('sideBack').addEventListener('click', () => setSide('back'))
  $('inspector').addEventListener('input', () => { S.inspector = $('inspector').value.trim(); lsSet('vqc_inspector', S.inspector) })
  $('autoCap').addEventListener('change', () => { S.autoCapture = $('autoCap').checked })
  $('btnShoot').addEventListener('click', () => captureFromCamera(t('يدوي')))
  $('btnFile').addEventListener('click', () => $('fileInput').click())
  $('fileInput').addEventListener('change', () => { const f = $('fileInput').files && $('fileInput').files[0]; $('fileInput').value = ''; if (f) runInspection(f, t('ملف')) })
  $('btnFlip').addEventListener('click', () => { S.facing = S.facing === 'environment' ? 'user' : 'environment'; startCamera(); renderBgStatus() })
  $('btnBg').addEventListener('click', captureBackground)
  $('btnBgClear').addEventListener('click', clearBackground)
  $('btnCancel').addEventListener('click', () => { if (S.controller) S.controller.abort() })
  $('overlay').addEventListener('click', onOverlayTap)
  $('btnPickerCancel').addEventListener('click', closePicker)
  document.querySelectorAll('.btn.dec').forEach((b) => b.addEventListener('click', () => setDecision(b.dataset.dec)))
  $('btnSave').addEventListener('click', saveInspection)
  $('btnRetry').addEventListener('click', saveInspection)
  $('btnNew').addEventListener('click', newPiece)
  $('btnBack').addEventListener('click', newPiece)
  $('btnRemote').addEventListener('click', requestRemoteCapture)
  $('btnLive').addEventListener('click', toggleLive)
  $('btnCamStart').addEventListener('click', () => startCamera())
  document.querySelectorAll('.btn.sample').forEach((b) => b.addEventListener('click', () => runSample(b.dataset.sample, b.dataset.order)))
  $('btnMore').addEventListener('click', () => {                 // the options row sits below the controls: open it AND bring it on screen (on a phone it was off the bottom edge)
    const r = $('moreRow'); r.hidden = !r.hidden; $('btnMore').classList.toggle('on', !r.hidden)
    if (!r.hidden) setTimeout(() => { const b = r.getBoundingClientRect(); if (b.bottom > innerHeight) window.scrollBy({ top: b.bottom - innerHeight + 16, behavior: 'smooth' }) }, 120)
  })
  $('btnNet').addEventListener('click', checkConnection)
  // overlay alignment needs no JS on resize: the svg is positioned on the same box as the <img> (see style.css .photoWrap)
}

function setSide(side) { S.side = side; $('sideFront').classList.toggle('active', side === 'front'); $('sideBack').classList.toggle('active', side === 'back') }

function renderOrders(list) {
  S.orders = list || []; const sel = $('orderSel'); clear(sel)
  if (!S.orders.length) { sel.appendChild(opt('', t('ما في طلبيات'))); return }
  S.orders.forEach((o, i) => sel.appendChild(opt(String(i), [o.order_number, o.product, o.color, o.line].filter(Boolean).join(' · '))))
  const last = lsGet('vqc_order'); const idx = Math.max(0, S.orders.findIndex((o) => o.order_number === last))
  sel.value = String(idx); S.order = S.orders[idx]
  renderRef()
}

// ── the product's reference photo: a correct piece, flat, from above (demo_orders.reference_url, one per model_code) ────────────
// Set from the piece on the screen («📌 اعتمدها مرجع للموديل», decision bar) or from a photo file («⋯ → 📌 مرجع من صورة», no inspection).
// Used by the global pass (compare with the correct piece) and by the embroidery / print close-ups (how the designs should look).
function renderRef() {
  const has = !!(S.order && S.order.reference_url)
  $('refBadge').hidden = !has; $('btnRefClear').hidden = !has
  $('btnRef').hidden = !(S.order && S.order.model_code && S.view === 'inspect' && (S.img || S.reviewId) && !S.running)
}
function applyReference(modelCode, url) {
  S.orders.forEach((o) => { if (o.model_code === modelCode) o.reference_url = url })
  renderRef()
}
async function storeReference(modelCode, url) {
  await S.db.setReference(modelCode, url); applyReference(modelCode, url)
  toast(url ? t('📌 انحفظ المرجع للموديل {m}', { m: modelCode }) : t('انشال مرجع الموديل'))
}
// a 1600 px copy of an image adapter, uploaded under references/<model>/ → its public URL
async function uploadReferenceFrom(img, modelCode) {
  const blob = await (await fetch(await img.previewUrl(1600))).blob()
  return S.db.uploadPhoto(`references/${encodeURIComponent(modelCode)}/${Date.now()}.jpg`, blob)
}
async function setReferenceFromCurrent() {
  const o = S.order; if (!o || !o.model_code || !S.db) { toast(t('ما في طلبية مختارة')); return }
  if (!confirm(t('تعتمد هالقطعة صورة مرجعية صح للموديل {m}؟ (بتنبدّل القديمة إذا في)', { m: o.model_code }))) return
  try {
    toast(t('عم أحفظ المرجع…'))
    let url = null
    if (S.reviewId && S.reviewPhotoUrl) url = S.reviewPhotoUrl.replace(/photo\.jpg$/, 'preview.jpg')   // review screen: the camera device already uploaded the preview
    else if (S.img) url = await uploadReferenceFrom(S.img, o.model_code)
    if (!url) { toast(t('ما في صورة لاعتمادها')); return }
    await storeReference(o.model_code, url)
  } catch (e) { toast(t('ما قدرت أحفظ المرجع: ') + msg(e), 4000) }
}
async function setReferenceFromFile(file) {
  const o = S.order; if (!o || !o.model_code || !S.db) { toast(t('ما في طلبية مختارة')); return }
  if (!confirm(t('تعتمد هالصورة مرجع صح للموديل {m}؟ (بتنبدّل القديمة إذا في)', { m: o.model_code }))) return
  let img = null
  try { toast(t('عم أحفظ المرجع…')); img = await fromBlob(file); await storeReference(o.model_code, await uploadReferenceFrom(img, o.model_code)) }
  catch (e) { toast(t('ما قدرت أحفظ المرجع: ') + msg(e), 4000) } finally { safeClose(img) }
}
async function clearReference() {
  const o = S.order; if (!o || !o.model_code || !S.db) return
  if (!confirm(t('تشيل الصورة المرجعية للموديل {m}؟', { m: o.model_code }))) return
  try { await storeReference(o.model_code, null) } catch (e) { toast(t('ما قدرت أحفظ المرجع: ') + msg(e), 4000) }
}
// the reference photo as an image adapter for the pipeline (≤ 5 s, anything wrong → none)
async function loadReference(url) {
  if (!url) return null
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 5000)
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(tm)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await fromBlob(await r.blob())
  } catch (e) { return null }
}

async function refreshStats() {
  if (!S.db) return
  try { const s = await S.db.todayStats(); $('stats').textContent = t('اليوم: {n} فحص · {r} أحمر · {c} مؤكد', { n: s.inspections || 0, r: s.red || 0, c: s.confirmed || 0 }) } catch (e) { $('stats').textContent = '' }
}

// ── camera + stillness loop ──────────────────────────────────────────────────
function stopCamera() {
  clearInterval(S.loop); S.loop = null
  if (S.cam) { try { S.cam.stop() } catch (e) { /* ignore */ } }
  S.cam = null; S.det = null
}

async function startCamera() {
  if (S.camStarting) return                    // a double tap on «🔄 كاميرا» must not open two streams
  S.camStarting = true
  stopCamera()
  const video = $('video')
  try {
    S.cam = await openCamera(video, { facing: S.facing })
  } catch (e) {
    S.cam = DEV && PARAMS.has('fakecam') ? fakeCamera(video) : null     // desktop development only: a drawn test pattern stands in for the camera
    if (!S.cam) {
      // desktop / no permission: the start panel stays with the reason, the pill goes, «⋯» opens with the file button usable
      S.camStarting = false; $('pill').hidden = true; $('btnShoot').disabled = true; $('btnFlip').disabled = true
      showCamStart(t('الكاميرا ما اشتغلت على هالجهاز — استعمل «📁 صورة من الجهاز». ({err})', { err: msg(e) })); $('moreRow').hidden = false
      return
    }
  }
  S.camStarting = false
  $('pill').hidden = false; $('btnShoot').disabled = false; $('btnFlip').disabled = false; $('camMsg').hidden = true
  $('camStart').hidden = true; if (!(DEV && PARAMS.has('fakecam'))) lsSet('vqc_cam_ok', '1')   // next load starts the camera without the tap
  S.cam.onLost = cameraLost
  if (S.live && MODE === 'camera') S.live.replaceTrack(S.cam.track)          // tablets already watching get the new camera
  S.det = new StillnessDetector()
  S.det.onStill = () => { if (S.autoCapture && S.view === 'camera' && !S.running && !S.capturing) captureFromCamera(t('تلقائي')) }
  S.sampleCanvas = S.sampleCanvas || document.createElement('canvas')
  setPill('idle')
  S.loop = setInterval(sampleTick, 125)        // ~8 fps is plenty for a hands-left-the-frame detector
}

// «🧪 جرّب صورة جاهزة»: a factory photo bundled with the page (station/samples/), for a judge with no garment and no camera —
// the matching order is selected first so the pipeline knows the garment type, then it runs exactly like a shot
async function runSample(file, orderNumber) {
  if (S.running || S.capturing) { toast(t('في فحص شغّال — استنّي يخلص')); return }
  const idx = S.orders.findIndex((o) => o.order_number === orderNumber)
  if (idx >= 0) { $('orderSel').value = String(idx); S.order = S.orders[idx]; lsSet('vqc_order', orderNumber); renderRef() }
  try {
    toast(t('عم حمّل الصورة الجاهزة…'))
    const r = await fetch('samples/' + file, { cache: 'force-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status)
    S.sampleRun = true                                           // a 24 MP sample with every tile asked twice took 60 s: one tile pass is enough at that resolution (~40 s)
    await runInspection(await r.blob(), t('عينة'))
  } catch (e) { toast(t('ما قدرت حمّل الصورة الجاهزة: ') + msg(e), 4000) } finally { S.sampleRun = false }
}

// the «شغّل الكاميرا» panel: first time on a device (the permission prompt follows a clear tap), or after a camera failure (with the reason)
function showCamStart(text) { $('camStart').hidden = false; const m = $('camStartMsg'); m.textContent = text || ''; m.hidden = !text }

// ?fakecam=1 on localhost: a 640×480 canvas with a moving block, exposed like a camera (stills come from the frame grab) — lets the whole
// two-device flow, including the live view, be exercised on a desktop without a camera
function fakeCamera(video) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480; const ctx = c.getContext('2d'); let n = 0
  const draw = () => { n++; ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#b55'; ctx.fillRect(120 + Math.round(40 * Math.sin(n / 10)), 100, 400, 280); ctx.fillStyle = '#000'; ctx.font = '28px sans-serif'; ctx.fillText('FAKE CAM ' + n, 20, 40) }
  draw(); const t = setInterval(draw, 100)
  const stream = c.captureStream(10), track = stream.getVideoTracks()[0]
  video.srcObject = stream; video.play().catch(() => {})
  return { stream, track, settings: { width: 640, height: 480 }, facing: 'environment', live: () => track.readyState === 'live', stop() { clearInterval(t); track.stop() }, onLost: null }
}

// the track ended (OS took the camera, screen lock, another app): say so instead of silently re-shooting the frozen frame
function cameraLost() {
  if (!S.cam) return
  stopCamera(); $('pill').hidden = true; $('btnShoot').disabled = true
  const m = $('camMsg'); clear(m); m.appendChild(el('span', null, t('الكاميرا وقفت — ')))
  const b = el('button', 'btn small', t('🔄 عيد تشغيل الكاميرا')); b.type = 'button'; b.addEventListener('click', startCamera); m.appendChild(b); m.hidden = false
}

function sampleTick() {
  const video = $('video')
  if (!S.cam || !S.det || video.readyState < 2) return
  if (S.cam.track && S.cam.track.readyState !== 'live') { cameraLost(); return }
  // paused while a piece is being inspected: on return the detector sees a swapped garment as a motion burst and the same one as «نفس القطعة»
  if (S.view !== 'camera' || S.running || S.capturing) return
  try {
    const gray = grayscaleSample(video, S.sampleCanvas, SAMPLE_W, SAMPLE_H)
    const r = S.det.feed(gray, SAMPLE_W, SAMPLE_H, performance.now())
    setPill((r && r.state) || S.det.state)
  } catch (e) { /* a dropped frame is fine */ }
}

function setPill(state) {
  const now = Date.now()
  if (state === 'still') S.pillHold = now + 1500        // keep «📸 لقطة!» readable for a moment
  else if (now < S.pillHold) return
  const p = $('pill'); p.textContent = PILL[state] || PILL.idle
  p.className = 'pill ' + (PILL[state] ? state : 'idle')
}

async function captureFromCamera(label) {
  if (S.running || S.capturing) { toast(t('في فحص شغّال — استنّي يخلص')); return }
  if (!S.cam) { toast(t('ما في كاميرا — استعمل «صورة من الجهاز»')); return }
  S.capturing = true
  try {
    const blob = await takePhoto(S.cam, $('video'))
    await runInspection(blob, label)
  } catch (e) { toast(t('ما قدرت آخد الصورة: ') + msg(e)) } finally { S.capturing = false }
}

// ── inspection run ───────────────────────────────────────────────────────────
function setView(v) {
  S.view = v
  $('cameraPanel').hidden = v !== 'camera'
  $('inspectPanel').hidden = v === 'camera'
  $('viewHead').hidden = v !== 'history'
  $('tapHint').hidden = v !== 'inspect'
  if (v !== 'inspect') { $('progress').hidden = true; $('runError').hidden = true; $('costLine').textContent = ''; $('checkLine').textContent = '' }
  if (v !== 'inspect') $('decisionBar').hidden = true
}

async function runInspection(blob, sourceLabel) {
  if (S.running) { toast(t('في فحص شغّال — استنّي يخلص')); return }
  if (!blob || !blob.size) { toast(t('الصورة فاضية')); return }
  S.running = true
  resetInspection(); setView('inspect'); renderCards()           // placeholder «عم فحص…» while the run is in progress
  sendState()
  S.blob = blob; S.source = sourceLabel
  const controller = new AbortController(); S.controller = controller
  const order = S.order
  let reference = null
  S.warns = []; S.tilesDone = 0; S.progL = ''; S.progG = ''; $('progressWarn').textContent = ''; $('progressWarn').title = ''
  $('progress').hidden = false; $('btnCancel').hidden = false; $('runError').hidden = true; $('costLine').textContent = ''
  setProgress(t('عم جهّز الصورة…')); startTimer()
  try {
    const img = await fromBlob(blob); S.img = img
    await showPhoto(await img.previewUrl(1600), img.width, img.height)
    if (!S.api) throw new Error(t('ما في إعدادات (config.js) — ما فيني كلّم الموديل'))
    // references for the verifier (fetched while SAM runs) and the empty-table comparison (local, no model call)
    const examples = (S.db && order && order.model_code) ? loadExamples(order.model_code) : []
    const foreground = await foregroundFor(img)
    reference = await loadReference(order && order.reference_url)   // the product's correct piece, for the global pass and the design close-ups
    // the pipeline passes request bodies through untouched, so the AbortSignal rides along in each body (api.js strips it)
    const wrappedApi = { responses: (b) => S.api.responses({ ...b, signal: controller.signal }) }
    // signal goes to the pipeline too: it stops starting new tiles/stages and rejects with AbortError right away
    const res = await inspect(img, { api: wrappedApi, samParser, garment: (order && order.garment) || 'garment', onProgress, concurrency: 10, signal: controller.signal, examples, foreground, reference, requireGarment: true, lang: LANG, tilePasses: S.sampleRun ? 1 : 2, decorPasses: 2 })   // every tile and every design asked twice (Saad, Oct 28: «it found something I had not seen» — worth the seconds)
    if (S.img !== img) return                   // the inspector moved on while we were running
    // the pipeline turns aborted calls into stage warnings and resolves with an empty result — report the cancel, not «no defects»
    if (controller.signal.aborted) { setProgress(t('انلغى الفحص')); return }
    S.res = res; S.framing = res.framing || null; showFraming(S.framing)
    S.findings = (res.findings || []).map((f) => ({ ...f, verdict: null, worker_name: null, stage: null, window: f.window || globalWindow(f, res) }))
    // model calls that failed (proxy limit, 401, offline…) must not read as «nothing suspicious»
    const failed = S.warns.filter((w) => ['garment', 'tile', 'parts', 'global'].includes(w.stage))
    S.incomplete = failed.length ? { failed: failed.length, tilesFailed: failed.filter((w) => w.stage === 'tile').length, tiles: res.tiles || 0 } : null
    S.noGarment = !!res.noGarment && !S.incomplete                 // a failed model call is never «no garment» (the pipeline goes on over the whole frame, flagged incomplete)
    renderAll(); showCost(res); showCheck(res.summary)
    if (S.incomplete) {
      setProgress(t('الفحص ما كمل — {f}/{n} بلاطة ما انفحصت', { f: S.incomplete.tilesFailed, n: S.incomplete.tiles }))
      $('runErrorText').textContent = t('{n} طلب للموديل فشل — ما تعتمد على «ما لقيت شي»:', { n: S.incomplete.failed }) + '\n' + [...new Set(failed.map((w) => `${w.stage}: ${w.error}`))].slice(0, 8).join('\n')
      $('runError').hidden = false
    } else if (S.noGarment) setProgress(t('ما لقيت قطعة واضحة تحت الكاميرا — افردها بنص الكادر وجرّب'))
    else setProgress(S.findings.length ? t('خلص — {n} نقطة للمراجعة', { n: S.findings.length }) : t('خلص — ما لقيت شي مشبوه'))
    if (MODE === 'camera' && S.db && !S.noGarment) autoSave(img)       // camera device: hand the piece to the review screen right away (incomplete runs too, flagged)
    else if (MODE === 'camera' && S.noGarment) {                      // nothing to review: say so on the phone and go back to the camera
      $('camLast').textContent = t('ما لقيت قطعة بالكادر — ما انبعت شي للمراجعة'); $('camLast').hidden = false
      const mine = img; setTimeout(() => { if (S.img === mine && !S.running && !S.job) { resetInspection(); setView('camera'); renderCards() } }, CAMERA_NEXT_MS)
    }
  } catch (e) {
    if (controller.signal.aborted) setProgress(t('انلغى الفحص'))
    else { setProgress(t('وقف الفحص')); $('runErrorText').textContent = msg(e) + (e && e.stack && !String(e.stack).startsWith(msg(e)) ? '\n' + e.stack : ''); $('runError').hidden = false }
  } finally {
    stopTimer(); S.running = false; S.controller = null; $('btnCancel').hidden = true; safeClose(reference)
    sendState(); renderRef()
    // cards are refreshed here (after running=false) so a cancel / error / undecodable photo shows a way out instead of a stale «عم فحص…»
    if (S.view === 'inspect') { renderCards(); $('decisionBar').hidden = false; updateSaveEnabled(); $('tapHint').hidden = !S.img }
    // camera device: no decision bar here, so a cancelled / failed run would leave the phone stuck on the photo — show «⬅ رجوع» and go back by itself
    if (MODE === 'camera' && S.view === 'inspect' && !S.job) {
      $('viewHead').hidden = false; $('btnBack').textContent = t('⬅ رجوع للكاميرا'); $('viewTitle').textContent = ''
      const mine = S.img; setTimeout(() => { if (S.img === mine && !S.running && !S.job && S.view === 'inspect') newPiece() }, CAMERA_NEXT_MS)
    }
  }
}

// silhouette / mirror / global findings need the whole garment (or both compared parts) in their crop, not a 500 px patch
function globalWindow(f, res) {
  if (f.kind !== 'global') return null
  const bx = res.parts && res.parts.boxes
  if (f.source === 'mirror' && bx && bx.length === 2) {
    const x1 = Math.min(bx[0].x1, bx[1].x1), y1 = Math.min(bx[0].y1, bx[1].y1), x2 = Math.max(bx[0].x2, bx[1].x2), y2 = Math.max(bx[0].y2, bx[1].y2)
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  const g = res.garmentBox
  return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null
}

function showPhoto(url, w, h) {
  const photo = $('photo'), svg = $('overlay'); clear(svg)
  S.imgW = w; S.imgH = h                                        // full-res size the overlay/taps work in (the shown image may be a smaller preview)
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  return new Promise((res) => { photo.onload = () => res(); photo.onerror = () => res(); photo.src = url })
}

// The pipeline runs two branches at once after it finds the garment (local: tiles → verify · global: parts → overall look),
// so events interleave; the line shows the local stage and appends the global one («… + عم قارن اليمين بالشمال»).
function onProgress(stage, info) {
  info = info || {}
  if (!S.running || (S.controller && S.controller.signal.aborted)) return   // after a cancel the aborted calls are just noise
  const two = () => setProgress(S.progL + (S.progG ? ' + ' + S.progG : ''))
  switch (stage) {
    case 'garment': S.progL = t('عم دوّر عالقطعة…'); S.progG = ''; two(); break
    case 'tiles': S.progL = t('عم فحص {n} بلاطة{skipped}…', { n: info.count, skipped: info.skipped ? t(' (تخطّى {k} برّا القطعة)', { k: info.skipped }) : '' }); two(); break
    case 'tile': S.tilesDone++; S.progL = t('بلاطة {i}/{n}', { i: S.tilesDone, n: info.n }); two(); break          // tiles finish out of order → count completions
    case 'verify': S.progL = info.count ? t('عم أكد {n} نقطة{ex}…', { n: info.count, ex: info.examples ? t(' مع {k} أمثلة من المفتشة', { k: info.examples }) : '' }) : t('ما في نقاط مشبوهة بالبلاطات'); two(); break
    case 'parts': S.progG = t('عم قارن اليمين بالشمال…'); two(); break
    case 'global': S.progG = t('نظرة عامة…'); two(); break
    case 'decor': S.progG = info.count ? t('عم فحص {n} تطريز/طباعة عن قرب…', { n: info.count }) : S.progG; two(); break
    case 'stage_done':
      if (info.stage === 'verify') S.progL = t('النقاط المحلية خلصت ✓')
      if (info.stage === 'global') S.progG = ''
      two(); break
    case 'framing': S.framing = info; showFraming(info); break
    case 'nogarment': S.progL = t('ما لقيت قطعة واضحة بالصورة'); S.progG = ''; two(); break
    case 'warn': S.warns.push(info); $('progressWarn').textContent = `⚠ ${S.warns.length}`; $('progressWarn').title = S.warns.map((w) => `${w.stage}: ${w.error}`).join('\n'); break
  }
}
function setProgress(t) { $('progressText').textContent = t }
function startTimer() { S.runStarted = Date.now(); stopTimer(); S.timer = setInterval(tickTimer, 200); tickTimer() }
function tickTimer() { $('progressTimer').textContent = ((Date.now() - S.runStarted) / 1000).toFixed(1) + t(' ث') }
function stopTimer() { clearInterval(S.timer); S.timer = null; tickTimer() }

// the verification story of one piece, in one line: what the tiles raised, what the magnified check kept and dropped, what the close-ups added
function showCheck(s) {
  const e = $('checkLine')
  if (!s || typeof s.candidates !== 'number') { e.textContent = ''; return }
  let txt = t('🔎 البلاطات لقطت {n} مرشّح · التأكيد المكبّر أكّد {k} وشال {m}', { n: s.candidates, k: s.confirmed, m: s.dropped })
  if (s.unsure) txt += t(' · {u} مش متأكد (قرارك)', { u: s.unsure })
  if (s.decor) txt += t(' · التطريز عن قرب: {d}', { d: s.decor })
  if (s.global) txt += t(' · النظرة العامة والمقارنة: {g}', { g: s.global })
  e.textContent = txt
}
function showCost(res) {
  const u = res.usage || {}, tm = res.timings || {}
  const usd = ((u.input_tokens || 0) * 1.25 + (u.output_tokens || 0) * 4.25) / 1e6 + 0.0025 * (u.sam_calls || 0)
  const focus = res.focus ? t(' · ركّز عالقطعة: {sent}/{tiles} بلاطة{dropped}', { sent: res.focus.sent, tiles: res.focus.tiles, dropped: res.focus.droppedOutside ? t(' · شال {k} نقطة برّا القطعة', { k: res.focus.droppedOutside }) : '' }) : ''
  const learn = u.examples ? t(' · 🧠 {k} أمثلة من المفتشة', { k: u.examples }) : ''
  $('costLine').textContent = `~$${usd.toFixed(3)} · ${((tm.total || 0) / 1000).toFixed(1)} s · ${u.calls || 0} Spark · ${u.sam_calls || 0} SAM · ${res.tiles || 0} tiles · ${(u.input_tokens || 0)}/${(u.output_tokens || 0)} tok${focus}${learn}`
}

// ── framing warnings (sent by the pipeline right after SAM, ~5 s into the run, and kept with the result) ─────────
const SIDE_WORD = { top: t('فوق'), bottom: t('تحت'), left: t('شمال'), right: t('يمين') }
function framingText(f) {
  if (!f) return ''
  const parts = []
  if (f.cut && f.cut.length) parts.push(t('القطعة طالعة برّا الكادر من {sides}', { sides: f.cut.map((s) => SIDE_WORD[s] || s).join(t(' و')) }))
  if (f.small) parts.push(t('القطعة صغيرة بالصورة ({p}٪) — قرّب الكاميرا', { p: f.areaPct }))
  if (f.clutter) parts.push(t('في شي غير القطعة عالطاولة (إيد / عصاية / غرض) — شيلو'))
  return parts.length ? '⚠ ' + parts.join(' · ') : ''
}
function showFraming(f) { const txt = framingText(f); $('frameWarn').textContent = txt; $('frameWarn').hidden = !txt }

// ── learning loop: the inspector's earlier verdicts on this product become references for the verifier ─────────
// up to 2 «defect» + 2 «not_defect» crops, newest first, downscaled to 320 px (they ride on every verify call, bytes matter on a factory Wi-Fi)
async function loadExamples(modelCode) {
  try {
    const rows = (await S.db.examplesFor(modelCode, 30)) || []
    const pick = (label) => rows.filter((r) => r.label === label && r.crop_path).slice(0, 2)
    const out = await Promise.all([...pick('defect'), ...pick('not_defect')].map(async (r) => {
      try { return { label: r.label === 'defect' ? 'defect' : 'not_defect', type: TYPE_AR[r.type] ? r.type : 'other', note: '', b64: await urlToB64(S.db.publicUrl(r.crop_path), 320) } } catch (e) { return null }   // no free DB text in the prompt
    }))
    return out.filter(Boolean)
  } catch (e) { return [] }
}
async function urlToB64(url, maxSide) {
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status)
  const bmp = await createImageBitmap(await r.blob())
  try {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    const c = makeCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)))
    c.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0, c.width, c.height)
    try { return await blobToBase64(await canvasToBlob(c, 'image/jpeg', 0.85)) } finally { freeCanvas(c) }
  } finally { bmp.close() }
}

// ── the empty table: one photo per station + camera facing, kept on this device as 256 px gray. What differs from it is «not table». ──
const BG_W = 256
const bgKey = () => `vqc_bg_${(S.cfg && S.cfg.STATION) || 'final-qc-1'}_${S.facing}`
function loadBg() {
  try {
    const j = JSON.parse(lsGet(bgKey()) || 'null'); if (!j || !j.g || !j.w || !j.h) return null
    const bin = atob(j.g), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
    return a.length === j.w * j.h ? { w: j.w, h: j.h, gray: a, at: j.at } : null
  } catch (e) { return null }
}
// bitmap → luma bytes at BG_W wide (same weights as the stillness sampler)
function grayOf(bitmap) {
  const w = BG_W, h = Math.max(1, Math.round(BG_W * bitmap.height / bitmap.width))
  const c = makeCanvas(w, h), ctx = c.getContext('2d', { alpha: false, willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h)
  for (let i = 0, k = 0; k < g.length; i += 4, k++) g[k] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
  freeCanvas(c)
  return { w, h, gray: g }
}
async function captureBackground() {
  if (S.running || S.capturing) { toast(t('في فحص شغّال — استنّي يخلص')); return }
  if (!S.cam) { toast(t('ما في كاميرا — ما فيني صوّر الطاولة')); return }
  S.capturing = true
  try {
    const img = await fromBlob(await takePhoto(S.cam, $('video')))
    try {
      const g = grayOf(img.bitmap)
      let bin = ''; for (let i = 0; i < g.gray.length; i += 0x8000) bin += String.fromCharCode.apply(null, g.gray.subarray(i, i + 0x8000))
      lsSet(bgKey(), JSON.stringify({ w: g.w, h: g.h, g: btoa(bin), at: new Date().toISOString() }))
      if (!loadBg()) throw new Error(t('التخزين المحلي رفض الحفظ'))
    } finally { safeClose(img) }
    toast(t('✓ انحفظت صورة الطاولة الفاضية — صار يعرف شو مش قطعة')); renderBgStatus()
  } catch (e) { toast(t('ما قدرت صوّر الطاولة: ') + msg(e)) } finally { S.capturing = false }
}
function clearBackground() { try { localStorage.removeItem(bgKey()) } catch (e) { /* ignore */ } renderBgStatus(); toast(t('انمسحت صورة الطاولة الفاضية')) }
function renderBgStatus() {
  const bg = loadBg(), s = $('bgStatus')
  s.textContent = bg ? t('الطاولة الفاضية محفوظة ({date} {time})', { date: ymd(new Date(bg.at)), time: hhmm(bg.at) }) : t('اختياري: صوّر الطاولة وهي فاضية مرة، فبيعرف شو مش قطعة (إيد، عصاية، غرض)')
  $('btnBgClear').hidden = !bg
}
// current photo vs the stored empty table → coarse foreground grid for the pipeline (null when none is stored or the frame size changed)
async function foregroundFor(img) {
  const bg = loadBg(); if (!bg) return null
  try {
    const g = grayOf(img.bitmap)
    if (g.w !== bg.w || g.h !== bg.h) return null
    return foregroundGrid(g.gray, bg.gray, g.w, g.h, { W: img.width, H: img.height })
  } catch (e) { return null }
}

// ── overlay (circles) ────────────────────────────────────────────────────────
// Color: red level → red; global kind (silhouette / mirror / global) below red → blue, dashed; everything else amber.
const colorClass = (f) => f.level === 'red' ? 'red' : f.kind === 'global' ? 'blue' : 'amber'
const ringR = (W, H) => Math.max(40, 0.02 * Math.max(W, H))

function renderOverlay() {
  const svg = $('overlay'); clear(svg)
  if (!S.imgW || !S.imgH) return
  const W = S.imgW, H = S.imgH, r = ringR(W, H)
  const gb = S.res && S.res.garmentBox
  if (gb) svg.appendChild(svgEl('rect', { x: gb.x, y: gb.y, width: gb.w, height: gb.h, class: 'gbox', 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': `${r * 0.3} ${r * 0.2}` }))
  S.findings.forEach((f, i) => svg.appendChild(markGroup(f, i, r)))
}

function markGroup(f, i, r) {
  const g = svgEl('g', { class: 'mark ' + colorClass(f) + (f.verdict ? ' v-' + f.verdict : '') })
  g.appendChild(svgEl('circle', { cx: f.x, cy: f.y, r, class: 'hit' }))      // invisible filled disc: a tap inside the ring focuses the card
  const ring = { cx: f.x, cy: f.y, r, class: 'ring', 'vector-effect': 'non-scaling-stroke' }
  if (f.kind === 'global') ring['stroke-dasharray'] = `${r * 0.35} ${r * 0.2}`
  g.appendChild(svgEl('circle', ring))
  const bx = f.x + r * 0.78, by = f.y - r * 0.78, br = r * 0.42          // number badge at the ring's top-right
  g.appendChild(svgEl('circle', { cx: bx, cy: by, r: br, class: 'badge' }))
  const t = svgEl('text', { x: bx, y: by, dy: '0.36em', 'text-anchor': 'middle', 'font-size': br * 1.25, class: 'num' })
  t.textContent = String(i + 1); g.appendChild(t)
  g.addEventListener('click', (ev) => { ev.stopPropagation(); focusCard(i) })
  return g
}

function highlightMark(i) {
  const g = $('overlay').querySelectorAll('g.mark')[i]; if (!g) return
  g.classList.add('active'); setTimeout(() => g.classList.remove('active'), 1500)
}
function focusCard(i) {
  const card = $('findings').children[i]; if (!card) return
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1500); highlightMark(i)
}

// tap on the photo → type picker → added finding at that point (full-res coordinates via the svg's CTM)
function onOverlayTap(ev) {
  if (S.view !== 'inspect' || !S.imgW) return
  if (S.running) { toast(t('استنّي يخلص الفحص')); return }
  if (S.job) { toast(S.job.done ? t('انحفظ هالفحص — افحص قطعة جديدة لتعدّل') : t('عم يحفظ — ما فيك تعدّل النقاط هلق')); return }
  if (S.reviewLocked) { toast(t('انحفظت المراجعة — القطعة الجاية عم تنفتح')); return }
  if (S.pending) closePicker()                                  // a second tap while the picker is open just moves the mark
  const svg = $('overlay'); let pt
  const box = svg.getBoundingClientRect(); if (!box.width || !box.height) return
  try { const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; const q = p.matrixTransform(svg.getScreenCTM().inverse()); pt = { x: Math.round(q.x), y: Math.round(q.y) } }
  catch (e) { const b = svg.getBoundingClientRect(); pt = { x: Math.round((ev.clientX - b.left) / b.width * S.imgW), y: Math.round((ev.clientY - b.top) / b.height * S.imgH) } }
  pt.x = Math.max(0, Math.min(pt.x, S.imgW - 1)); pt.y = Math.max(0, Math.min(pt.y, S.imgH - 1))
  S.pending = pt
  const r = ringR(S.imgW, S.imgH)
  const g = svgEl('g', { class: 'mark pending', id: 'pendingMark' }); g.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r, class: 'ring', 'vector-effect': 'non-scaling-stroke' })); svg.appendChild(g)
  $('picker').hidden = false
}
function buildPicker() { const grid = $('pickerGrid'); for (const k in TYPE_AR) { const b = el('button', 'btn', TYPE_AR[k]); b.type = 'button'; b.addEventListener('click', () => pickType(k)); grid.appendChild(b) } }
function closePicker() { $('picker').hidden = true; S.pending = null; const g = $('pendingMark'); if (g) g.remove() }
function pickType(type) {
  const pt = S.pending; closePicker(); if (!pt || !S.imgW) return
  S.findings.push({ kind: 'local', source: 'inspector', type, x: pt.x, y: pt.y, confidence: 1, level: 'red', severity: 'major', why: t('علّمتها المفتشة'), verdict: 'added', verdict_at: new Date().toISOString(), worker_name: null, stage: null })
  renderAll(); focusCard(S.findings.length - 1)
}

// ── cards ────────────────────────────────────────────────────────────────────
function renderAll() { renderOverlay(); renderCards(); updateSaveEnabled() }
// the decision buttons judge the WHOLE piece; this line above them says what the per-spot verdicts add up to
function renderDecSummary() {
  const s = $('decSummary'), n = S.findings.length
  renderRef()
  if (!n || !(S.img || S.reviewId)) { s.textContent = ''; return }
  const c = S.findings.filter((f) => f.verdict === 'confirmed' || f.verdict === 'added').length, r = S.findings.filter((f) => f.verdict === 'rejected').length
  s.textContent = t('القرار تحت للقطعة كلها · النقاط: ✓ {c} عيب مؤكد · ✗ {r} مش عيب · {o} بلا حكم', { c, r, o: n - c - r })
}

function renderCards() {
  const box = $('findings'); clear(box); box.classList.toggle('locked', !!S.job || S.reviewLocked || S.reviewBusy)   // frozen as soon as a save job exists (busy, failed or done)
  $('findingsCount').textContent = S.findings.length ? String(S.findings.length) : ''
  renderDecSummary()
  if (S.view === 'camera') { box.appendChild(el('div', 'empty', t('حطّ القطعة تحت الكاميرا وشيل إيديك — أو اختار صورة من الجهاز'))); return }
  if (S.view === 'history') return
  if (!S.findings.length) {
    const txt = S.running ? t('عم فحص…') : S.noGarment ? t('ما لقيت قطعة واضحة بالصورة — افردها بنص الكادر وافحص من جديد') : (MODE === 'review' && !S.reviewId) ? t('بانتظار قطعة من الكاميرا… أول ما تخلص بتطلع هون لحالها') : !(S.img || S.imgW) ? t('ما قدرت أفتح الصورة — افحص قطعة جديدة') : S.incomplete ? t('الفحص ما كمل — ما تعتمد على النتيجة، افحص القطعة من جديد') : S.res ? t('ما لقيت شي مشبوه 👍 — كبس عالصورة إذا شفت عيب') : t('ما في نتيجة — كبس عالصورة إذا شفت عيب، أو افحص قطعة جديدة')
    box.appendChild(el('div', 'empty', txt)); return
  }
  S.findings.forEach((f, i) => box.appendChild(buildCard(f, i)))
}

function cardHead(f, i) {
  const head = el('div', 'cardHead')
  head.appendChild(el('span', 'num', String(i + 1)))
  head.appendChild(el('span', 'type', TYPE_AR[f.type] || f.type || t('شي تاني')))
  head.appendChild(el('span', 'conf', Math.round((+f.confidence || 0) * 100) + '%'))
  if (f.kind === 'global') head.appendChild(el('span', 'tag', f.source === 'silhouette' ? t('قياس') : f.source === 'mirror' ? t('مقارنة') : t('عام')))
  if (f.source === 'decor' || f.decor) head.appendChild(el('span', 'tag', t('تطريز/طباعة')))
  if (f.unsure) head.appendChild(el('span', 'tag unsure', t('مش متأكد')))
  if (f.severity === 'major' && f.source !== 'inspector') head.appendChild(el('span', 'tag unsure', t('كبير')))
  head.addEventListener('click', () => highlightMark(i))
  return head
}

function buildCard(f, i) {
  const card = el('div', 'card ' + colorClass(f) + (f.verdict ? ' v-' + f.verdict : ''))
  card.appendChild(cardHead(f, i))
  const body = el('div', 'cardBody')
  const thumb = el('img', 'thumb'); thumb.alt = ''; body.appendChild(thumb)
  cropUrl(f, S.img).then((u) => { if (u) thumb.src = u })
  body.appendChild(el('div', 'why', f.why || ''))
  card.appendChild(body)
  const foot = el('div', 'cardFoot')
  if (f.source === 'inspector') {
    foot.appendChild(el('span', 'chip added', t('➕ علّمتها المفتشة')))
    const rm = el('button', 'btn', t('✗ شيلها')); rm.type = 'button'
    rm.addEventListener('click', () => { S.findings.splice(i, 1); renderAll() }); foot.appendChild(rm)
  } else {
    const yes = el('button', 'btn yes' + (f.verdict === 'confirmed' ? ' active' : ''), t('✓ عيب')); yes.type = 'button'
    const no = el('button', 'btn no' + (f.verdict === 'rejected' ? ' active' : ''), t('✗ مش عيب')); no.type = 'button'
    yes.addEventListener('click', () => setVerdict(f, 'confirmed')); no.addEventListener('click', () => setVerdict(f, 'rejected'))
    foot.appendChild(yes); foot.appendChild(no)
  }
  if (f.verdict === 'confirmed' || f.verdict === 'added') foot.appendChild(workerSelect(f))
  card.appendChild(foot)
  if (S.job || S.reviewLocked) card.querySelectorAll('button, select').forEach((c) => { c.disabled = true })   // real disable, not only pointer-events (keyboard too)
  return card
}

function setVerdict(f, v) {
  f.verdict = f.verdict === v ? null : v                        // tapping the active button clears it
  f.verdict_at = f.verdict ? new Date().toISOString() : null
  if (!f.verdict) { f.worker_name = null; f.stage = null; f._workerId = '' }
  f._dirty = true
  renderAll()
}

function workerSelect(f) {
  const sel = el('select', 'worker'); sel.appendChild(opt('', t('— مين خيّطها؟ —')))
  const line = S.order && S.order.line
  let ws = S.workers.filter((w) => !line || w.line === line); if (!ws.length) ws = S.workers
  ws.forEach((w) => sel.appendChild(opt(String(w.id), [w.name, w.stage].filter(Boolean).join(' · '))))
  sel.value = f._workerId || ''
  sel.addEventListener('change', () => { const w = S.workers.find((x) => String(x.id) === sel.value); f._workerId = sel.value; f.worker_name = w ? w.name : null; f.stage = w ? (w.stage || null) : null; f._dirty = true })
  return sel
}

// 2× crop around the spot: the verify window when the pipeline has one, else 500×500 around (x, y); 400 px wide for cards + uploads
function clampWin(w, W, H) {
  const x = Math.max(0, Math.min(Math.round(w.x), W - 1)), y = Math.max(0, Math.min(Math.round(w.y), H - 1))
  return { x, y, w: Math.max(1, Math.min(Math.round(w.w), W - x)), h: Math.max(1, Math.min(Math.round(w.h), H - y)) }
}
function cropBlob(f, img) {
  if (!img) return Promise.resolve(null)
  if (!f._crop) {
    const win = clampWin(f.window && f.window.w ? f.window : { x: f.x - 250, y: f.y - 250, w: 500, h: 500 }, img.width, img.height)
    f._crop = img.blob({ ...win, resize: { w: 400, h: Math.max(1, Math.round(400 * win.h / win.w)) } }).catch(() => null)
  }
  return f._crop
}
function cropUrl(f, img) {
  if (f.crop_path && S.db) return Promise.resolve(S.db.publicUrl(f.crop_path))     // review mode: the camera device already stored the crop
  return cropBlob(f, img).then((b) => { if (!b) return null; if (!f._cropUrl) f._cropUrl = URL.createObjectURL(b); return f._cropUrl })
}

// ── decision + save ──────────────────────────────────────────────────────────
function setDecision(dec) {
  if (S.job) { toast(S.job.done ? t('انحفظ هالفحص — افحص قطعة جديدة') : t('عم يحفظ — القرار متثبّت')); return }
  if (S.reviewLocked) { toast(t('انحفظت المراجعة — القطعة الجاية عم تنفتح')); return }
  S.decision = dec
  document.querySelectorAll('.btn.dec').forEach((b) => b.classList.toggle('active', b.dataset.dec === dec))
  updateSaveEnabled()
}
function updateSaveEnabled() {
  const b = $('btnSave'), done = (S.job && S.job.done) || S.reviewLocked, busy = (S.job && S.job.busy) || S.reviewBusy
  b.disabled = !S.decision || !(S.img || S.reviewId) || !S.db || !!done || !!busy || S.noGarment
  b.textContent = done ? t('✓ انحفظ') : busy ? t('عم يحفظ…') : t('💾 حفظ')
  b.classList.toggle('busy', !!busy)
  document.querySelectorAll('.btn.dec').forEach((d) => { d.disabled = !!S.job || S.reviewLocked })
  if (!S.db && S.img) $('saveStatus').textContent = t('ما في اتصال بالقاعدة (config.js) — الحفظ معطّل')
  else if (S.noGarment && S.img) $('saveStatus').textContent = t('ما في قطعة بالصورة — ما في شي ينحفظ، افحص من جديد')
}
function saveStatus(t, cls) { const s = $('saveStatus'); s.textContent = t; s.className = 'status' + (cls ? ' ' + cls : '') }

function saveInspection() {
  if (S.reviewId) return saveReview()
  if (!S.decision || !S.img || !S.db) return
  if (S.job && (S.job.busy || S.job.done)) return
  // the job takes a SNAPSHOT of the list and the cards are frozen from now on: a retry writes exactly what the inspector saw
  if (!S.job) S.job = { busy: false, done: false, img: S.img, blob: S.blob, res: S.res, findings: S.findings.slice(), order: S.order, side: S.side, inspector: S.inspector, decision: S.decision, incomplete: S.incomplete, id: null, date: null, paths: {}, prep: null, released: false, patched: false, findingIds: null, examples: false, closeAfter: false, photoScaled: false }
  renderCards(); updateSaveEnabled()
  runSave(S.job)
}

// ?mode=camera: no decision on this device — save right after the run (decision null = waiting for the review screen), then go back to the camera
function autoSave(img) {
  if (S.job || S.img !== img) return
  S.job = { busy: false, done: false, img: S.img, blob: S.blob, res: S.res, findings: S.findings.slice(), order: S.order, side: S.side, inspector: S.inspector, decision: null, incomplete: S.incomplete, id: null, date: null, paths: {}, prep: null, released: false, patched: false, findingIds: null, examples: false, closeAfter: false, photoScaled: false, auto: true }
  renderCards(); updateSaveEnabled()
  runSave(S.job)
}

// Resumable: every step is skipped once it succeeded, so «🔁 حاول الحفظ مرة تانية» continues where it stopped. Nothing here blocks the UI.
// Crops are tied to the finding objects (f._cropPath), never to a position in a list.
async function runSave(job) {
  job.busy = true; if (S.job === job) { updateSaveEnabled(); $('btnRetry').hidden = true }
  sendState()
  const db = S.db, n = job.findings.length
  const st = (t, cls) => { if (S.job === job) saveStatus(t, cls) }   // a job detached by «قطعة جديدة» never writes into the next inspection's status
  try {
    if (!job.prep) { st(t('عم جهّز الصور…')); job.prep = await prepareBlobs(job) }
    if (!job.id) {
      st(t('عم سجّل الفحص…'))
      const r0 = await db.insertInspection(inspectionRow(job)); const r = Array.isArray(r0) ? r0[0] : r0
      if (!r || r.id == null) throw new Error(t('القاعدة ما رجّعت رقم الفحص'))
      job.id = r.id; job.date = ymd(r.created_at ? new Date(r.created_at) : new Date())
    }
    const base = `${job.date}/${job.id}/`
    // light files first (preview, crops, rows), then the piece is RELEASED to the review screen; the heavy full photo and the annotated
    // copy follow in the background — on a slow Wi-Fi the tablet sees the piece 20–40 s earlier (the review screen works from preview.jpg)
    if (!job.paths.preview && job.prep.preview) { st(t('عم رفع المعاينة…')); await db.uploadPhoto(base + 'preview.jpg', job.prep.preview); job.paths.preview = base + 'preview.jpg' }
    for (let i = 0; i < n; i++) {
      const f = job.findings[i]
      if (f._cropPath || !job.prep.crops[i]) continue
      st(t('عم رفع القصّات {i}/{n}…', { i: i + 1, n }))
      const p = base + `crop-${i + 1}.jpg`; await db.uploadPhoto(p, job.prep.crops[i]); f._cropPath = p
    }
    if (!job.findingIds) {
      st(t('عم سجّل النقاط…'))
      const rows = job.findings.map((f) => findingRow(job, f))
      const ins = rows.length ? await db.insertFindings(rows) : []
      job.findingIds = (Array.isArray(ins) ? ins : []).map((r) => r.id)
    }
    if (!job.examples) {
      st(t('عم سجّل الأمثلة…'))
      const ex = []
      job.findings.forEach((f, i) => {
        if (!f.verdict || !f._cropPath) return                  // vision_examples.crop_path is NOT NULL
        ex.push({ finding_id: job.findingIds[i] == null ? null : job.findingIds[i], model_code: job.order ? job.order.model_code : null, type: f.type || 'other', label: f.verdict === 'rejected' ? 'not_defect' : 'defect', crop_path: f._cropPath, note: f.why || null })
      })
      if (ex.length) await db.insertExamples(ex)
      job.examples = true
    }
    if (!job.released) {
      // photo_path set = preview, crops and rows are in place: the tablet polls and opens only such rows; photo.jpg itself lands below
      await db.updateInspection(job.id, { photo_path: base + 'photo.jpg', decision: job.decision }); job.released = true
      if (job.auto) {                                          // camera device: tell the tablet now, show the result briefly, then wait for the next piece
        S.lastSavedId = job.id; if (S.link) S.link.send('saved', { id: job.id })
        const nf = job.findings.length, nr = job.findings.filter((f) => f.level === 'red').length
        $('camLast').textContent = t('آخر قطعة #{id}: {what} — انبعتت للمراجعة', { id: job.id, what: nf ? t('{n} نقطة', { n: nf }) + (nr ? t(' ({r} أحمر)', { r: nr }) : '') : t('ما في نقاط') }); $('camLast').hidden = false
        if (S.job === job) setTimeout(() => { if (S.job === job && !S.running) newPiece() }, CAMERA_NEXT_MS)   // the uploads below go on detached
      } else st(t('✓ انحفظ — عم رفع الصورة الكاملة…'), 'ok')
      refreshStats(); loadHistory()
    }
    if (!job.paths.photo) { if (!job.auto) st(t('عم رفع الصورة…')); await db.uploadPhoto(base + 'photo.jpg', job.prep.photo); job.paths.photo = base + 'photo.jpg' }
    if (!job.paths.annotated && job.prep.annotated) { if (!job.auto) st(t('عم رفع الصورة المعلّمة…')); await db.uploadPhoto(base + 'annotated.jpg', job.prep.annotated); job.paths.annotated = base + 'annotated.jpg' }
    if (!job.patched) { await db.updateInspection(job.id, { annotated_path: job.paths.annotated || null }); job.patched = true }
    job.done = true; st(job.auto ? t('✓ انبعتت للمراجعة') : t('✓ انحفظ'), 'ok')
    S.detached = S.detached.filter((j) => j !== job)
    if (S.job === job) { renderCards(); updateSaveEnabled() } else if (!job.auto) toast(t('✓ انحفظ فحص القطعة السابقة{id}', { id: job.id ? ' (#' + job.id + ')' : '' }))
    loadHistory()
  } catch (e) {
    st(t('ما انحفظ: ') + msg(e), 'bad')
    if (S.job === job) { $('btnRetry').hidden = false; if (job.auto) $('camLast').textContent = t('آخر قطعة ما انبعتت: ') + msg(e) }
    else banner(t('فحص القطعة السابقة{id} ما خلص حفظو: {err}', { id: job.id ? ' (#' + job.id + ')' : '', err: msg(e) }), t('🔁 حاول مرة تانية'), () => runSave(job))
  } finally {
    job.busy = false; sendState()
    if (S.job === job) updateSaveEnabled()
    if (job.closeAfter && job.done) safeClose(job.img)         // the inspector already moved on; a failed detached job keeps its bitmap for the retry
  }
}

// everything that needs the image adapter is made up-front, so «📷 قطعة جديدة» can free the bitmap while uploads continue
async function prepareBlobs(job) {
  const { img, blob } = job
  const full = { x: 0, y: 0, w: img.width, h: img.height }
  // the original JPEG is stored untouched (its pixels are what x/y refer to); a HEIC/PNG pick or an oversized file is re-encoded,
  // which the image adapter caps at 4096 px — that case is flagged in result.photo_scaled
  const reencode = (blob.type && blob.type !== 'image/jpeg') || blob.size > BIG_PHOTO
  const photo = reencode ? await img.blob({ ...full, quality: 0.9 }) : blob
  job.photoScaled = reencode
  // clean 1600 px preview for the review screen (10× lighter than the photo; circles are drawn live from the DB rows there)
  let preview = null
  try { preview = await (await fetch(await img.previewUrl(1600))).blob() } catch (e) { /* optional */ }
  let annotated = null
  try { annotated = await renderAnnotated(job) } catch (e) { /* optional */ }
  const crops = []
  for (let i = 0; i < job.findings.length; i++) crops.push(await cropBlob(job.findings[i], img))
  return { photo, preview, annotated, crops }
}

// preview (≤1600 px) + the same circles/numbers drawn on a canvas → annotated.jpg
async function renderAnnotated(job) {
  const im = await loadImage(await job.img.previewUrl(1600))
  const W = job.img.width, H = job.img.height, sc = im.naturalWidth / W
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight
  const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0)
  const r = ringR(W, H) * sc, colors = { red: '#d32f2f', amber: '#f59e0b', blue: '#2563eb' }
  job.findings.forEach((f, i) => {
    const x = f.x * sc, y = f.y * sc, col = colors[colorClass(f)]
    ctx.globalAlpha = f.verdict === 'rejected' ? 0.45 : 1
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.setLineDash(f.kind === 'global' ? [r * 0.35, r * 0.2] : [])
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
    const bx = x + r * 0.78, by = y - r * 0.78, br = r * 0.42
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(br * 1.25)}px system-ui, Segoe UI, Tahoma, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), bx, by)
  })
  ctx.globalAlpha = 1
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.9))
}

function inspectionRow(job) {
  const o = job.order || {}, res = job.res, u = (res && res.usage) || {}, t = (res && res.timings) || {}
  return {
    station: S.cfg.STATION || 'final-qc-1', inspector: job.inspector || null,
    order_number: o.order_number || null, model_code: o.model_code || null, garment: o.garment || 'garment', side: job.side,
    width: job.img.width, height: job.img.height, garment_box: (res && res.garmentBox) || null,
    result: res ? { ...res, photo_scaled: job.photoScaled || undefined, incomplete: job.incomplete || undefined } : null,
    // what the CAMERA flagged (inspector-added spots are not camera reds)
    n_red: job.findings.filter((f) => f.level === 'red' && f.source !== 'inspector').length, n_amber: job.findings.filter((f) => f.level === 'amber' && f.source !== 'inspector').length,
    decision: job.decision, duration_ms: t.total == null ? null : Math.round(t.total), input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
  }
}
function findingRow(job, f) {
  return {
    inspection_id: job.id, kind: f.kind || 'local', source: f.source || 'tiles', type: f.type || 'other', x: Math.round(f.x), y: Math.round(f.y),
    confidence: Math.round(Math.min(1, +f.confidence || 0) * 1000) / 1000, level: f.level || null, severity: f.severity || null, why: f.why || null,
    crop_path: f._cropPath || null, verdict: f.verdict || null, verdict_by: f.verdict ? (job.inspector || null) : null,
    verdict_at: f.verdict ? (f.verdict_at || new Date().toISOString()) : null, worker_name: f.worker_name || null, stage: f.stage || null,
  }
}

// ── setup screen: the role of this device (phone above the table / inspector tablet / one device), the pairing code and the name ──
// Stored on the device (vqc_role, vqc_link_code, vqc_inspector) and applied by a reload: MODE is fixed per page load.
function wireSetup() {
  $('btnLang').addEventListener('click', () => setLang(isEn() ? 'ar' : 'en'))
  $('btnHelp').addEventListener('click', () => showWelcome('how'))
  $('btnSetup').addEventListener('click', showSetup)
  document.querySelectorAll('#setup .role').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#setup .role').forEach((x) => x.classList.toggle('sel', x === b))
    $('setName').placeholder = b.dataset.role === 'review' ? t('اسم المفتشة') : t('متل: كاميرا 1')
  }))
  $('btnSetupStart').addEventListener('click', saveSetup)
  $('btnSetupClose').addEventListener('click', () => { $('setup').hidden = true })
  $('btnNet2').addEventListener('click', checkConnection)
}
function showSetup() {
  document.querySelectorAll('#setup .role').forEach((x) => x.classList.toggle('sel', x.dataset.role === MODE))
  $('setCode').value = linkCode(); $('setName').value = lsGet('vqc_inspector') || ''
  $('setName').placeholder = MODE === 'review' ? t('اسم المفتشة') : t('متل: كاميرا 1')
  $('btnSetupClose').hidden = !MODE
  $('setup').hidden = false
}
function saveSetup() {
  const sel = document.querySelector('#setup .role.sel'); if (!sel) { toast(t('اختار دور الجهاز أول')); return }
  const code = $('setCode').value.trim()
  lsSet('vqc_role', sel.dataset.role); lsSet('vqc_inspector', $('setName').value.trim())
  if (code) lsSet('vqc_link_code', code); else { try { localStorage.removeItem('vqc_link_code') } catch (e) { /* ignore */ } }
  const u = new URL(location.href); u.searchParams.delete('mode'); u.searchParams.delete('welcome'); location.replace(u.toString())   // dev switches (?station, ?fakecam) stay
}

// ── «📶 فحص الاتصال»: ~1 MB of random bytes up to the proxy (/ping) + one small round trip — says whether the Wi-Fi here is why pieces take long ──
async function checkConnection() {
  const base = S.cfg && S.cfg.PROXY_URL ? String(S.cfg.PROXY_URL).replace(/\/+$/, '') : ''
  const say = (txt) => ['netStatus', 'netStatus2'].forEach((id) => { const e = $(id); if (e) e.textContent = txt })
  say(t('📶 عم قيس سرعة الرفع…'))
  try {
    const bytes = 1024 * 1024, data = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(bytes, i + 65536)))   // random: nothing to compress on the way
    const t0 = performance.now()
    const r = await fetch(base + '/ping', { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const up = performance.now() - t0
    const t1 = performance.now(); await fetch(base + '/health', { cache: 'no-store' }); const rtt = Math.round(performance.now() - t1)
    const mbps = Math.round(bytes * 8 / 1000 / up * 10) / 10                 // Mbit/s
    const perPiece = Math.max(1, Math.round(8 * 8 / Math.max(0.1, mbps)))    // ~8 MB leave the device per piece (tiles + crops + the photo)
    const grade = mbps < 2 ? t('ضعيف') : mbps < 8 ? t('متوسط') : t('منيح')
    S.net = { mbps, rtt, at: Date.now() }
    say(t('📶 رفع {mbps} ميغابت/ث ({grade}) · ردّ {rtt} ms — الرفع لحالو حوالي {s} ث للقطعة', { mbps, grade, rtt, s: perPiece }))
  } catch (e) { say(t('📶 ما قدرت قيس: ') + msg(e)) }
}

// ── two-device link: camera phone ⇄ review tablet (link.js, Realtime broadcast) ──────────────────────
// The phone reports its state every 2 s (idle / running + its progress line / uploading / nocam) and the tablet can ask it to shoot:
// «📸» → capture{req} → the phone answers ack{req, ok, reason} at once and shoots; when its save is done it sends saved{id} so the
// tablet polls right away instead of waiting for the next tick. Nothing is queued: a request with no ack in 4 s is reported as such.
// ── pairing code (optional): the same short code typed on the phone and the tablet (tap the status line on either device). With a code set
// on the phone, a shot request or a live-view request must carry sha256(code|req); anything else on the public channel is ignored.
const REMOTE_MIN_MS = 6000
const linkCode = () => lsGet('vqc_link_code') || ''
async function linkSig(req) {
  const code = linkCode(); if (!code || !(globalThis.crypto && crypto.subtle)) return ''
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code + '|' + String(req)))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function linkOk(p) { if (!linkCode()) return true; return !!(p && p.req && p.sig) && (await linkSig(p.req)) === p.sig }
function setLinkCode() {
  const v = prompt(t('رمز الربط بين الموبايل والتابلت (نفسو عالجهازين؛ فاضي = بلا رمز):'), linkCode())
  if (v == null) return
  if (v.trim()) lsSet('vqc_link_code', v.trim()); else { try { localStorage.removeItem('vqc_link_code') } catch (e) { /* ignore */ } }
  toast(v.trim() ? t('🔑 انحفظ رمز الربط') : t('انشال رمز الربط')); renderLink()
}

function startLink() {
  S.link = openLink({
    url: S.cfg.SUPABASE_URL, key: S.cfg.SUPABASE_KEY, station: (DEV && PARAMS.get('station')) || S.cfg.STATION || 'final-qc-1', onMessage: onLinkMessage,
    onStatus: (st) => { S.linkUp = st === 'joined'; if (S.linkUp) sendState(); renderLink() },
  })
  const send = (e, p) => S.link.send(e, p)
  if (MODE === 'review') {
    S.live = makeViewer({ send: (e, p) => { if (e === 'rtc-want') { linkSig(p.req).then((sig) => S.link.send(e, { ...p, sig })); return true } return send(e, p) }, video: $('liveView'), onState: renderLive })   // rtc-want carries the pairing signature
    $('liveWrap').addEventListener('click', () => { S.liveBig = !S.liveBig; renderLive() })
    document.addEventListener('visibilitychange', maintainLive)
  } else S.live = makeSender({ send, getStream: () => S.cam && S.cam.stream, onState: () => renderLink() })
  $('linkText').title = $('camLink').title = t('كبسة: رمز الربط بين الجهازين')
  $('linkText').addEventListener('click', setLinkCode); $('camLink').addEventListener('click', setLinkCode)
  S.linkTimer = setInterval(() => { sendState(); renderLink(); maintainLive(); renderTwin() }, LINK_STATE_MS)
  renderLink()
}
function camState() { return (S.running || S.capturing) ? 'running' : (S.job && S.job.busy) ? 'uploading' : S.camStarting ? 'starting' : !S.cam ? 'nocam' : 'idle' }   // a file-input run on a camera-less device still reads «running»
function sendState() {
  if (!S.link || !S.linkUp) return
  if (MODE === 'camera') S.link.send('state', { role: 'camera', device: S.inspector || '', state: camState(), note: S.running ? [$('progressText').textContent, framingText(S.framing)].filter(Boolean).join(' · ') : '', lastId: S.lastSavedId, boot: S.boot, viewers: S.live ? S.live.viewers() : 0,
    err: S.incomplete ? t('الفحص ما كمل عالموبايل — ') + String((S.warns[0] && S.warns[0].error) || '').slice(0, 80) : S.noGarment ? t('ما لقيت قطعة بالكادر') : '', code: !!linkCode() })
  else if (MODE === 'review') S.link.send('state', { role: 'review', by: S.inspector || '' })
}
function onLinkMessage(event, p) {
  if (event.startsWith('rtc-')) { onRtc(event, p); return }
  if (event === 'state') {
    if (p.role === MODE && p.boot && p.boot !== S.boot) { S.twinSeen = Date.now(); renderTwin(); return }   // another page with OUR role on this station (an old tab, a home-screen copy, a second phone)
    if (p.role && p.role !== MODE) {
      if (MODE === 'review') { pickPeer(p); return }
      S.peer = p; S.peerSeen = Date.now(); renderLink()
    }
    return
  }
  if (MODE === 'camera' && event === 'capture') { remoteCapture(p); return }
  if (MODE !== 'review') return
  if (event === 'ack' && S.capReq && p.req === S.capReq.req) {
    clearTimeout(S.capReq.timer); S.capReq = null
    toast(p.ok ? t('📷 الموبايل عم يصوّر…') : t('الموبايل ما صوّر: ') + (p.reason || '')); renderLink()
    if (p.ok) { freezeLive(); S.liveWanted = false }           // hold the shot instead of the moving feed, and stop the stream: the phone's Wi-Fi now carries the uploads
  } else if (event === 'saved') reviewTick()
}
// The tablet may hear several camera pages on one station (an old tab left open, the home-screen copy, a second phone): they alternate every
// second and the status line and the live view flap between them. Keep ONE phone — the current one while it is fresh, otherwise the one in
// the best state — and say how many there are so the extra pages get closed.
const PEER_RANK = { running: 4, uploading: 3, idle: 3, starting: 2, nocam: 1 }
function pickPeer(p) {
  const now = Date.now()
  if (p.boot) S.peers.set(p.boot, { p, seen: now }); else { S.peer = p; S.peerSeen = now; renderLink(); return }   // a page without boot (old build): as before
  for (const [b, v] of S.peers) if (now - v.seen > PEER_TTL_MS) S.peers.delete(b)
  const cur = S.peerBoot ? S.peers.get(S.peerBoot) : null, fresh = cur && now - cur.seen <= LINK_STATE_MS * 1.5
  let best = fresh ? cur : null
  for (const v of S.peers.values()) if (!best || (PEER_RANK[v.p.state] || 0) > (PEER_RANK[best.p.state] || 0)) best = v
  if (best) {
    if (S.peerBoot && best.p.boot !== S.peerBoot && S.live) S.live.close()     // the phone page changed (reload / another phone): its old stream is gone, ask again
    S.peerBoot = best.p.boot; S.peer = best.p; S.peerSeen = best.seen
  }
  renderLink()
}
// camera page: another camera page is talking on this station — the tablet would flap between the two
function renderTwin() {
  if (MODE !== 'camera') return
  const m = $('camMsg'), twin = Date.now() - S.twinSeen < PEER_TTL_MS
  if (twin) { m.textContent = t('⚠ في صفحة كاميرا تانية مفتوحة على نفس المحطة (تبويب قديم أو نسخة الشاشة الرئيسية) — سكّرها، وإلا التابلت بيلخبط بيناتهن'); m.hidden = false }
  else if (m.textContent.startsWith('⚠')) m.hidden = true
}

// the tablet asked for a shot: answer at once, revive the camera if it had stopped, leave the previous piece (its upload goes on detached), shoot
async function remoteCapture(p) {
  const reply = (ok, reason) => { if (S.link) S.link.send('ack', { req: p.req, ok, reason: reason || null }) }
  if (!p || !p.req || S.seenReq.has(p.req)) return                                       // replayed or malformed: ignored
  S.seenReq.add(p.req); if (S.seenReq.size > 300) S.seenReq.delete(S.seenReq.values().next().value)
  if (!(await linkOk(p))) { reply(false, t('رمز الربط مش مطابق — كبسي على سطر الحالة لتكتبيه')); return }
  if (Date.now() - S.lastRemoteShot < REMOTE_MIN_MS) { reply(false, t('استنّي كم ثانية بين لقطة ولقطة')); return }
  if (S.running || S.capturing) { reply(false, t('في فحص شغّال — استنّي يخلص')); return }
  if (!S.cam && !S.camStarting) await startCamera()
  for (let i = 0; i < 25 && S.camStarting; i++) await new Promise((r) => setTimeout(r, 200))   // a camera that is just (re)starting gets up to 5 s
  if (!S.cam) { reply(false, t('الكاميرا مش شغّالة عالموبايل')); return }
  if (S.view !== 'camera') { resetInspection(); setView('camera'); renderCards() }
  reply(true); sendState(); S.lastRemoteShot = Date.now()
  setTimeout(() => captureFromCamera(t('من شاشة المراجعة')), 350)      // let the live view paint a frame after the panel switch
}
async function requestRemoteCapture() {
  if (!S.link || !S.linkUp || S.capReq) return
  const req = Math.random().toString(36).slice(2) + Date.now().toString(36)
  if (!S.link.send('capture', { req, by: S.inspector || '', sig: await linkSig(req) })) { toast(t('ما في اتصال بالموبايل')); return }
  S.capReq = { req, timer: setTimeout(() => { if (S.capReq && S.capReq.req === req) { S.capReq = null; toast(t('الموبايل ما ردّ — تأكدي إنو صفحة الكاميرا مفتوحة عليه')); renderLink() } }, ACK_WAIT_MS) }
  renderLink()
}
// WebRTC signaling rides on the link (live.js): the tablet asks, the phone offers, the tablet answers
function onRtc(event, p) {
  if (!S.live || !p) return
  if (MODE === 'camera') { if (event === 'rtc-want') linkOk(p).then((ok) => ok ? S.live.makeOffer(p.req) : S.link.send('rtc-fail', { req: p.req, reason: t('رمز الربط مش مطابق') })); else if (event === 'rtc-answer') S.live.onAnswer(p.req, p.sdp); else if (event === 'rtc-ice') S.live.onIce(p.req, p.cand) }
  else if (MODE === 'review') { if (event === 'rtc-offer') S.live.onOffer(p.req, p.sdp); else if (event === 'rtc-ice') S.live.onIce(p.req, p.cand); else if (event === 'rtc-fail') S.live.onFail(p.req, p.reason) }
}
// the shot the phone just confirmed: the live tile holds that frame (drawn from the stream) until the piece opens on this screen,
// or until the phone is idle again for a while (nothing came — no garment, a failure), or 2 minutes at most
function freezeLive() {
  const v = $('liveView'), c = $('liveStill')
  if (!S.live || !S.live.live() || !v.videoWidth) return
  c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
  c.hidden = false; S.liveFrozenAt = Date.now(); renderLive()
}
function unfreezeLive() { if (!S.liveFrozenAt) return; S.liveFrozenAt = 0; $('liveStill').hidden = true; renderLive() }
// «📡 شوف الكاميرا»: the live view is on demand — a tap opens it for LIVE_ON_MS (another tap while open closes it); the shot closes it too
function toggleLive() {
  if (S.liveWanted) { S.liveWanted = false; S.liveUntil = 0 } else { S.liveWanted = true; S.liveUntil = Date.now() + LIVE_ON_MS }
  maintainLive(); renderLive()
}

// the tablet keeps a live view while the phone has a working camera and this page is visible; drops it otherwise
function maintainLive() {
  if (MODE !== 'review' || !S.live || !S.live.supported()) return
  const alive = !!S.peer && Date.now() - S.peerSeen < PEER_TTL_MS
  if (S.liveFrozenAt) {
    const idleFor = alive && (S.peer.state === 'idle' || S.peer.state === 'nocam') && !S.capReq
    if (Date.now() - S.liveFrozenAt > 120000 || (idleFor && Date.now() - S.liveFrozenAt > 8000) || !alive) unfreezeLive()
  }
  if (S.liveWanted && Date.now() > S.liveUntil) S.liveWanted = false                      // the 90 s window ran out
  const can = S.liveWanted && alive && S.peer.state !== 'nocam' && document.visibilityState === 'visible'   // a signaling blip (link down for a moment) does not kill a running stream
  if (!can) { if (S.live.connecting() || S.live.live() || S.live.askedAt()) S.live.close(); S.liveLostAt = 0; S.liveWasLive = false; renderLive(); return }
  const now = Date.now()
  if (S.live.live()) { S.liveLostAt = 0; S.liveWasLive = true }
  else if (!S.liveLostAt) S.liveLostAt = now
  // a short stall (phone busy encoding a still, Wi-Fi hiccup) keeps the connection; a longer one asks for a fresh stream
  const stalled = !!S.liveLostAt && now - S.liveLostAt > LIVE_GRACE_MS
  if (!S.live.live() && S.linkUp && (!S.live.askedAt() || (stalled && now - S.live.askedAt() > LIVE_RETRY_MS))) { S.liveWasLive = false; S.live.ask() }   // first ask at once, later ones after a real stall
  renderLive()
}
// the live tile: full width while waiting for a piece, a small corner tile (tap to enlarge) while one is being reviewed
function renderLive() {
  if (MODE !== 'review' || !S.live) return
  const w = $('liveWrap'), reason = S.live.reason()
  const live = S.live.live() || (S.liveWasLive && !!S.liveLostAt && Date.now() - S.liveLostAt < LIVE_GRACE_MS && S.live.connecting())   // inside the grace window the last frame stays up (only once frames had arrived)
  const frozen = !!S.liveFrozenAt
  $('btnLive').textContent = S.liveWanted ? t('⏹ سكّر البث') : t('📡 شوف الكاميرا')
  const show = frozen || (S.liveWanted && (live || S.live.connecting() || !!reason))
  w.hidden = !show; if (!show) return
  w.classList.toggle('live', live); w.classList.toggle('frozen', frozen); w.classList.toggle('small', !!S.reviewId && !S.liveBig)
  const tl = S.live.timeline ? S.live.timeline() : null, s = tl ? Math.round(tl.since) : 0
  const step = tl && tl.since >= 2 ? (tl.connected != null ? t(' · {s} ث: اتصل، ناطر أول صورة', { s }) : tl.offer != null ? t(' · {s} ث: العرض وصل، عم يتصل', { s }) : t(' · {s} ث: ناطر عرض من الموبايل', { s })) : ''   // where the attempt stands (the «why is it slow» line)
  $('liveCap').textContent = frozen ? t('📸 هي اللقطة — الموبايل عم يفحصها…') : live ? t('📡 مباشر من الموبايل') + (S.reviewId && !S.liveBig ? t(' — كبسي للتكبير') : '') : reason ? '📡 ' + reason + step : t('📡 عم وصل بث الكاميرا…') + step
}
// status line on both devices; on the tablet also the «📸» button (enabled only when the phone can shoot now)
function renderLink() {
  const alive = !!S.peer && Date.now() - S.peerSeen < PEER_TTL_MS
  if (MODE === 'camera') {
    const m = $('camLink'); if (!S.link) { m.hidden = true; return }
    m.textContent = (!S.linkUp ? t('🔌 عم وصل بشاشة المراجعة…') : alive ? t('🧐 شاشة المراجعة متصلة{by} — فيها تطلب الفحص من عندها', { by: S.peer.by ? ' (' + S.peer.by + ')' : '' }) : t('🧐 شاشة المراجعة مش مفتوحة — افتح الرابط عالتابلت واختار «تابلت المفتشة»')) + (S.live && S.live.viewers() ? t(' · 📡 البث شغّال') : '') + (linkCode() ? ' 🔑' : '')
    m.className = 'msg' + (alive ? ' ok' : ''); m.hidden = false; return
  }
  if (MODE !== 'review') return
  const dev = alive && S.peer.device ? ' (' + S.peer.device + ')' : '', st = alive ? S.peer.state : null
  let txt, cls = 'off', on = false
  if (!S.link) txt = t('ما في اتصال بالموبايل (config.js)')
  else if (!S.linkUp) txt = t('🔌 عم وصل…')
  else if (!alive) txt = t('📷 الموبايل مش متصل — افتحي رابط الكاميرا عليه')
  else if (S.capReq) { txt = t('📨 بعتت للموبايل…'); cls = 'busy' }
  else if (st === 'running') { txt = t('⏳ الموبايل عم يفحص{dev}{note}', { dev, note: S.peer.note ? ' — ' + S.peer.note : '' }); cls = 'busy' }
  else if (st === 'starting') { txt = t('📷 الموبايل عم يشغّل الكاميرا{dev}…', { dev }); cls = 'busy' }
  else if (st === 'uploading') { txt = t('⏫ الموبايل عم يرفع القطعة السابقة{dev} — فيكي تصوّري التالية', { dev }); cls = 'ok'; on = true }
  else if (st === 'nocam') { txt = t('📷 الموبايل متصل{dev} بس كاميرتو واقفة — الكبسة بتجرّب تشغيلها', { dev }); cls = 'busy'; on = true }
  else { txt = t('📷 الموبايل جاهز{dev} — حطّي القطعة واكبسي', { dev }) + (S.peer.err ? t(' · ⚠ آخر فحص: ') + S.peer.err : ''); cls = S.peer.err ? 'busy' : 'ok'; on = true }
  if (linkCode()) txt += ' 🔑'; else if (alive && S.peer.code) txt += t(' · الموبايل بدو رمز ربط — كبسي هون لتكتبيه')
  if (alive && S.peers.size > 1) txt += t(' · ⚠ في {n} صفحات كاميرا على هالمحطة — سكّري الزيادة', { n: S.peers.size })
  $('linkText').textContent = txt; $('linkBar').className = 'linkBar ' + cls; $('btnRemote').disabled = !on
  $('btnLive').disabled = !alive || st === 'nocam' || !(S.live && S.live.supported())
}

// ── ?mode=review: the inspector's screen ─────────────────────────────────────
// Polls the demo DB; inspections saved by the camera device with no decision yet are «pending» and open automatically (oldest first).
// A row without photo_path is still being uploaded by the camera (files and finding rows not all there yet): shown as ⏫, never opened.
const isPending = (h) => !h.decision && !!h.photo_path
const isUploading = (h) => !h.decision && !h.photo_path
function startReview() {
  setView('inspect'); $('cameraPanel').hidden = true; $('tapHint').hidden = true
  $('progress').hidden = false; setProgress(t('بانتظار قطعة من الكاميرا…')); $('btnCancel').hidden = true
  renderCards()
  if (!S.db) { banner(t('وضع المراجعة بدو اتصال بالقاعدة (config.js)')); return }
  S.reviewTimer = setInterval(reviewTick, REVIEW_POLL_MS); reviewTick()
}

async function reviewTick() {
  if (!S.db || S.reviewBusy || S.running) return
  let list
  try { list = (await S.db.recentInspections(12)) || [] } catch (e) { return }
  const changed = JSON.stringify(list.map((h) => [h.id, h.decision, h.photo_path, h.annotated_path])) !== JSON.stringify(S.history.map((h) => [h.id, h.decision, h.photo_path, h.annotated_path]))
  S.history = list
  if (changed) renderStrip()
  const pending = list.filter(isPending).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const waiting = !S.reviewId && !S.reviewOpening && S.view === 'inspect' && !S.img      // the «بانتظار قطعة» screen — never while the inspector browses an old piece
  if (pending.length > S.lastPending) { notifyNew(); if (!waiting) toast(S.view === 'history' ? t('وصلت قطعة جديدة للمراجعة — «⬅ رجوع» لتفتحها') : t('وصلت قطعة جديدة — بتنفتح بعد ما تخلّصي هالقطعة'), 4000) }
  S.lastPending = pending.length
  if (waiting && pending.length) openReview(pending[0])
  else if (waiting && !pending.length) setProgress(t('بانتظار قطعة من الكاميرا… ({n} فحص محفوظ)', { n: list.length }))
}

function notifyNew() {
  try {                                                        // short beep (works after the first tap on the page)
    const ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(); const g = ac.createGain()
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.18)
  } catch (e) { /* no audio */ }
}

async function openReview(h) {
  if (S.reviewOpening) return
  S.reviewOpening = true
  try {
    resetInspection(); setView('inspect'); $('viewHead').hidden = true; unfreezeLive()   // the piece is here: back to the live feed
    S.reviewId = h.id; S.reviewDate = (h.photo_path || '').split('/')[0] || ymd(new Date(h.created_at)); S.reviewLocked = false
    S.order = S.orders.find((o) => o.order_number === h.order_number) || null
    if (S.order) { $('orderSel').value = String(S.orders.indexOf(S.order)) }
    setSide(h.side === 'back' ? 'back' : 'front')
    $('progress').hidden = false; $('btnCancel').hidden = true
    setProgress(t('قطعة #{id} · {order} — عم نزّل الصورة…', { id: h.id, order: h.order_number || '' })); startTimer()
    // the light 1600 px preview is enough to look and decide; the full photo is fetched only if the inspector adds a spot (crop)
    S.reviewPhotoUrl = h.photo_path ? S.db.publicUrl(h.photo_path) : null
    const previewUrl = h.photo_path ? S.db.publicUrl(h.photo_path.replace(/photo\.jpg$/, 'preview.jpg')) : null
    const [rows, blob] = await Promise.all([
      S.db.findingsFor(h.id),
      previewUrl ? fetch(previewUrl).then((r) => r.ok ? r.blob() : null).catch(() => null) : Promise.resolve(null),
    ])
    if (S.reviewId !== h.id) return                           // the reviewer moved on
    if (blob) { S.previewObjUrl = URL.createObjectURL(blob); await showPhoto(S.previewObjUrl, h.width, h.height) }
    else if (S.reviewPhotoUrl) {                              // older inspections without preview.jpg: full photo
      const fr = await fetch(S.reviewPhotoUrl); if (!fr.ok) throw new Error(t('الصورة مش موجودة بالمخزن ({status})', { status: fr.status }))
      const full = await fr.blob(); if (S.reviewId !== h.id) return
      S.img = await fromBlob(full); S.blob = full; await showPhoto(await S.img.previewUrl(1600), S.img.width, S.img.height)
    }
    S.res = { garmentBox: h.garment_box || null }; S.incomplete = h.incomplete || null      // the phone's failed model calls must not read as «clean» here either
    S.framing = h.framing || null; showFraming(S.framing); showCheck(h.summary || null)
    S.findings = (rows || []).map((r) => ({ id: r.id, kind: r.kind, source: r.source, type: r.type, x: r.x, y: r.y, confidence: +r.confidence || 0, level: r.level, severity: r.severity, why: r.why || '', crop_path: r.crop_path, verdict: r.verdict || null, verdict_at: r.verdict_at || null, worker_name: r.worker_name || null, stage: r.stage || null, _workerId: r.worker_name ? String((S.workers.find((w) => w.name === r.worker_name) || {}).id || '') : '', unsure: /مش متأكد|شافوها بلاطتين|خيط أم وبرة|^Not sure|two tiles|^Thread or lint/.test(r.why || '') }))
    S.decision = null
    renderAll(); renderStrip(); renderLive(); $('decisionBar').hidden = false; $('tapHint').hidden = !S.imgW
    stopTimer(); setProgress(t('قطعة #{id} · {order} · {time} — {what}', { id: h.id, order: h.order_number || '', time: hhmm(h.created_at), what: S.incomplete ? t('⚠ الفحص ما كمل عالموبايل — ما تعتمدي على «ما لقت شي»') : S.findings.length ? t('{n} نقطة للمراجعة', { n: S.findings.length }) : t('الكاميرا ما لقت شي — قرّري') }))
  } catch (e) {
    stopTimer(); setProgress(t('ما قدرت أفتح القطعة: ') + msg(e)); S.reviewId = null
  } finally { S.reviewOpening = false }
}

// writes the reviewer's verdicts / worker / decision on the rows the camera device created; new tapped spots get a crop + a row
async function saveReview() {
  if (!S.reviewId || S.reviewBusy || !S.decision || !S.db) return
  S.reviewBusy = true; updateSaveEnabled(); renderCards(); saveStatus(t('عم يحفظ المراجعة…'))
  const db = S.db, by = S.inspector || null, now = new Date().toISOString(), id = S.reviewId, base = `${S.reviewDate}/${id}/`
  try {
    let k = S.findings.filter((f) => f.id).length
    const added = S.findings.filter((f) => !f.id)
    if (added.length && !S.img && S.reviewPhotoUrl) {           // crops need the full photo: fetch it once, only now
      saveStatus(t('عم نزّل الصورة الكاملة للقصّات…'))
      try { const full = await (await fetch(S.reviewPhotoUrl)).blob(); S.img = await fromBlob(full) } catch (e) { /* no crop then */ }
    }
    for (const f of added) {                                     // spots the inspector added on this screen
      k++
      let crop = null
      const b = S.img ? await cropBlob(f, S.img) : null
      if (b) { crop = base + `crop-${k}.jpg`; await db.uploadPhoto(crop, b) }
      const ins = await db.insertFindings([{ inspection_id: id, kind: f.kind || 'local', source: 'inspector', type: f.type || 'other', x: Math.round(f.x), y: Math.round(f.y), confidence: 1, level: 'red', severity: 'major', why: f.why || null, crop_path: crop, verdict: 'added', verdict_by: by, verdict_at: now }])
      f.id = ins && ins[0] ? ins[0].id : null; f.crop_path = crop; f._dirty = false
    }
    const changed = new Set(added.map((f) => f.id))              // learning examples only for verdicts given on this screen now (no duplicates on a re-review)
    for (const f of S.findings) {
      if (!f.id || !f._dirty) continue
      await db.updateFinding(f.id, { verdict: f.verdict || null, verdict_by: f.verdict ? by : null, verdict_at: f.verdict ? (f.verdict_at || now) : null, worker_name: f.worker_name || null, stage: f.stage || null })
      f._dirty = false; changed.add(f.id)
    }
    await db.updateInspection(id, { decision: S.decision, inspector: by })
    const ex = S.findings.filter((f) => f.verdict && f.crop_path && f.id && changed.has(f.id)).map((f) => ({ finding_id: f.id, model_code: S.order ? S.order.model_code : null, type: f.type || 'other', label: f.verdict === 'rejected' ? 'not_defect' : 'defect', crop_path: f.crop_path, note: f.why || null }))
    if (ex.length) await db.insertExamples(ex)
    S.reviewLocked = true; saveStatus(t('✓ انحفظت المراجعة — القطعة الجاية عم تنفتح'), 'ok'); renderCards(); updateSaveEnabled()
    refreshStats()
    setTimeout(() => { if (S.reviewId === id && S.reviewLocked) { S.reviewId = null; resetInspection(); renderCards(); setProgress(t('بانتظار قطعة من الكاميرا…')); $('progress').hidden = false; renderLive(); reviewTick() } }, 2500)
  } catch (e) {
    saveStatus(t('ما انحفظت المراجعة: ') + msg(e), 'bad'); $('btnRetry').hidden = false
  } finally { S.reviewBusy = false; updateSaveEnabled(); if (!S.reviewLocked) renderCards() }
}

// ── new piece / reset ────────────────────────────────────────────────────────
function resetInspection() {
  closePicker()
  S.findings.forEach((f) => { if (f._cropUrl) { try { URL.revokeObjectURL(f._cropUrl) } catch (e) { /* ignore */ } f._cropUrl = null } })
  // a save that is still running or waiting for a retry stays alive (detached) and keeps its bitmap until it is done
  if (S.job && !S.job.done) { S.job.closeAfter = true; if (!S.detached.includes(S.job)) S.detached.push(S.job) } else safeClose(S.img)
  S.img = null; S.blob = null; S.res = null; S.findings = []; S.decision = null; S.job = null; S.warns = []; S.incomplete = null; S.noGarment = false; S.framing = null; $('frameWarn').hidden = true
  S.reviewId = null; S.reviewLocked = false; S.reviewPhotoUrl = null; S.imgW = 0; S.imgH = 0
  if (S.previewObjUrl) { try { URL.revokeObjectURL(S.previewObjUrl) } catch (e) { /* ignore */ } S.previewObjUrl = null }
  $('photo').removeAttribute('src'); clear($('overlay'))
  document.querySelectorAll('.btn.dec').forEach((b) => b.classList.remove('active'))
  saveStatus(''); $('btnRetry').hidden = true; $('runError').hidden = true; $('costLine').textContent = ''; $('checkLine').textContent = ''
  $('findings').classList.remove('locked'); updateSaveEnabled()
}
function newPiece() {
  if (S.running) { toast(t('في فحص شغّال — استنّي يخلص أو ألغيه')); return }
  if (MODE === 'review') {                                     // «قطعة جديدة» on the review screen = skip to the next pending piece
    if (S.reviewId && !S.reviewLocked && S.findings.some((f) => f._dirty || !f.id) && !confirm(t('المراجعة ما انحفظت — تتركها؟'))) return
    resetInspection(); setView('inspect'); $('cameraPanel').hidden = true; renderCards(); $('progress').hidden = false; setProgress(t('بانتظار قطعة من الكاميرا…')); renderLive(); reviewTick(); return
  }
  if (MODE !== 'camera' && S.img && S.view === 'inspect' && !S.job && !S.noGarment && !confirm(t('هالفحص ما انحفظ — تتركو؟'))) return   // the camera device never saves by hand: nothing to lose, no question
  resetInspection(); setView('camera'); renderCards()
  // no detector reset here: it remembers the last captured scene, so the same garment is not re-shot and a swapped one
  // (even one already lying still) is seen as a motion burst when sampling resumes
}

// ── history strip + read-only view ───────────────────────────────────────────
async function loadHistory() {
  if (!S.db) return
  try { S.history = (await S.db.recentInspections(12)) || [] } catch (e) { banner(t('ما قدرت جيب آخر الفحوصات: ') + msg(e)); return }
  renderStrip()
}
function renderStrip() {
  const strip = $('historyStrip'); clear(strip)
  if (!S.history.length) { strip.appendChild(el('div', 'empty', t('بعد ما في فحوصات'))); return }
  S.history.forEach((h) => {
    const pending = isPending(h), uploading = isUploading(h)
    const b = el('button', 'hist' + (pending ? ' pending' : '') + (uploading ? ' uploading' : '') + (S.reviewId === h.id ? ' current' : '')); b.type = 'button'
    const im = el('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'
    // the 1600 px annotated copy is far lighter than the full-res photo; photo_path is the fallback
    const p = h.annotated_path || (h.photo_path ? h.photo_path.replace(/photo\.jpg$/, 'preview.jpg') : null); if (p) im.src = S.db.publicUrl(p)   // preview.jpg is there from the release; annotated.jpg lands later
    b.appendChild(im)
    b.appendChild(el('span', 'hdec', uploading ? '⏫' : pending ? '⏳' : (DEC_EMOJI[h.decision] || '·')))
    b.appendChild(el('span', 'hord', '#' + h.id + ' · ' + (h.order_number || h.model_code || '')))   // the piece's own number first: the order repeats, the piece does not
    b.appendChild(el('span', 'htime', uploading ? t('عم توصل من الكاميرا…') : pending ? t('بانتظار المراجعة') : `${hhmm(h.created_at)} · ${SIDE_AR[h.side] || ''}`))
    b.addEventListener('click', () => uploading ? toast(t('لسا عم توصل من الكاميرا — ثواني')) : (pending && MODE === 'review') ? switchReview(h) : openHistory(h))
    strip.appendChild(b)
  })
}
function switchReview(h) {
  if (S.reviewId === h.id) return
  if (S.reviewId && !S.reviewLocked && S.findings.some((f) => f._dirty || !f.id) && !confirm(t('المراجعة الحالية ما انحفظت — تتركها؟'))) return
  openReview(h)
}

async function openHistory(h) {
  if (S.running) { toast(t('في فحص شغّال — استنّي يخلص')); return }
  if (S.reviewId && !S.reviewLocked && S.findings.some((f) => f._dirty || !f.id) && !confirm(t('المراجعة الحالية ما انحفظت — تتركها؟'))) return
  if (S.img && S.view === 'inspect' && !S.job && !confirm(t('هالفحص ما انحفظ — تتركو؟'))) return
  resetInspection(); setView('history'); $('btnBack').textContent = MODE === 'review' ? t('⬅ رجوع للمراجعة') : t('⬅ رجوع للكاميرا')
  const seq = ++S.histSeq                                        // a later tap on another thumbnail invalidates this one
  $('viewTitle').textContent = t('فحص #{id} · {order} · {side} · {dec} · {by} · {time}', { id: h.id, order: h.order_number || '', side: SIDE_AR[h.side] || '', dec: (DEC_EMOJI[h.decision] || '') + ' ' + (DEC_AR[h.decision] || t('بلا قرار')), by: h.inspector || '', time: hhmm(h.created_at) })
  const p = h.annotated_path || h.photo_path
  clear($('overlay')); $('photo').src = p ? S.db.publicUrl(p) : ''
  const box = $('findings'); clear(box); $('findingsCount').textContent = ''; box.appendChild(el('div', 'empty', t('عم جيب النقاط…')))
  let rows = []
  try { rows = (await S.db.findingsFor(h.id)) || [] } catch (e) { if (seq === S.histSeq && S.view === 'history') { clear(box); box.appendChild(el('div', 'empty', t('ما قدرت جيب النقاط: ') + msg(e))) } return }
  if (S.view !== 'history' || seq !== S.histSeq) return
  clear(box); $('findingsCount').textContent = rows.length ? String(rows.length) : ''
  if (!rows.length) { box.appendChild(el('div', 'empty', t('ما كان في نقاط'))); return }
  rows.forEach((f, i) => {
    const card = el('div', 'card ' + colorClass(f) + (f.verdict ? ' v-' + f.verdict : '')); card.appendChild(cardHead(f, i))
    const body = el('div', 'cardBody'); const thumb = el('img', 'thumb'); thumb.alt = ''; thumb.loading = 'lazy'
    if (f.crop_path) thumb.src = S.db.publicUrl(f.crop_path); body.appendChild(thumb); body.appendChild(el('div', 'why', f.why || '')); card.appendChild(body)
    const foot = el('div', 'cardFoot')
    const chipText = { confirmed: t('✓ عيب'), rejected: t('✗ مش عيب'), added: t('➕ علّمتها المفتشة') }[f.verdict] || t('بلا قرار')
    foot.appendChild(el('span', 'chip ' + (f.verdict || ''), chipText))
    if (f.worker_name) foot.appendChild(el('span', 'chip', [f.worker_name, f.stage].filter(Boolean).join(' · ')))
    card.appendChild(foot); box.appendChild(card)
  })
}

init()
