// SOLANG Vision QC — station UI controller (owner: UI agent). Binding spec: station/CONTRACTS.md §6.
// Flow: live camera → StillnessDetector → full-res photo → inspect() from shared/pipeline.js → numbered circles + cards →
// inspector confirms / rejects / adds spots → decision → saved to the demo Supabase (inspection, photos, findings, examples).
// The page suggests, the inspector decides. All text goes through textContent (the model returns free text).
import { inspect } from '../shared/pipeline.js'
import * as samParser from './vendor/meta-sam-parser/index.js'
import { makeApi, makeDb } from './api.js'
import { fromBlob } from './browser-image.js'
import { openCamera, takePhoto, StillnessDetector, grayscaleSample } from './camera.js'

const TYPE_AR = { hole: 'خرم', snag: 'سحبة', stain: 'بقعة', loose_thread: 'خيط طالع', stitching: 'درزة', puckering: 'تكرمش', unfinished_edge: 'حافة مش مخلّصة', asymmetry: 'فرق بين الجهتين', length: 'طول مختلف', print: 'طباعة', missing_part: 'قطعة ناقصة', other: 'شي تاني' }
const DEC_AR = { pass: 'سليمة', repair: 'تصليح', reject: 'مرفوضة' }
const DEC_EMOJI = { pass: '✅', repair: '🔧', reject: '❌' }
const SIDE_AR = { front: 'وجه', back: 'ضهر' }
const PILL = { idle: 'جاهزة', moving: 'في حركة', settling: 'ثابتة…', still: '📸 لقطة!', cooldown: 'جاهزة', same: 'نفس القطعة' }
const SAMPLE_W = 64, SAMPLE_H = 48           // detector sample size (matches StillnessDetector defaults)
const SVG_NS = 'http://www.w3.org/2000/svg'
const BIG_PHOTO = 12 * 1024 * 1024           // above this the original is re-encoded at q0.85 before upload

// ── state ────────────────────────────────────────────────────────────────────
const S = {
  cfg: null, api: null, db: null,
  orders: [], workers: [], order: null, side: 'front', inspector: '',
  view: 'camera',                              // camera | inspect | history
  cam: null, facing: 'environment', det: null, sampleCanvas: null, loop: null, autoCapture: true, pillHold: 0, capturing: false,
  running: false, controller: null, runStarted: 0, timer: null, warns: [], tilesDone: 0,
  img: null, blob: null, res: null, findings: [], decision: null,
  job: null,                                   // the save job of the current inspection (resumable on retry)
  pending: null,                               // tap point waiting for a type in the picker
  history: [],
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n }
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }
const opt = (v, t) => { const o = el('option', null, t); o.value = v; return o }
const msg = (e) => String((e && e.message) || e || 'خطأ غير معروف')
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
function banner(text) { const b = $('banner'); b.appendChild(el('div', null, text)); b.hidden = false }

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  buildPicker(); wire()
  S.inspector = lsGet('vqc_inspector') || ''; $('inspector').value = S.inspector
  try { S.cfg = (await import('./config.js')).default } catch (e) { banner('ملف الإعدادات station/config.js مش موجود — انسخ config.example.js وعبّيه') }
  if (S.cfg) {
    try { S.api = makeApi(S.cfg) } catch (e) { banner('ما قدرت جهّز الاتصال بالموديل: ' + msg(e)) }
    try { S.db = makeDb(S.cfg) } catch (e) { banner('ما قدرت جهّز الاتصال بالقاعدة: ' + msg(e)) }
  }
  renderCards()
  // DB loads run in parallel with the camera start; each failure is shown and the page stays usable
  if (S.db) {
    S.db.listOrders().then(renderOrders, (e) => banner('ما قدرت جيب الطلبيات: ' + msg(e)))
    S.db.listWorkers().then((w) => { S.workers = w || [] }, (e) => banner('ما قدرت جيب العمال: ' + msg(e)))
    refreshStats(); loadHistory()
  }
  startCamera()
}

function wire() {
  $('orderSel').addEventListener('change', () => { S.order = S.orders[+$('orderSel').value] || null; if (S.order) lsSet('vqc_order', S.order.order_number) })
  $('sideFront').addEventListener('click', () => setSide('front'))
  $('sideBack').addEventListener('click', () => setSide('back'))
  $('inspector').addEventListener('input', () => { S.inspector = $('inspector').value.trim(); lsSet('vqc_inspector', S.inspector) })
  $('autoCap').addEventListener('change', () => { S.autoCapture = $('autoCap').checked })
  $('btnShoot').addEventListener('click', () => captureFromCamera('يدوي'))
  $('btnFile').addEventListener('click', () => $('fileInput').click())
  $('fileInput').addEventListener('change', () => { const f = $('fileInput').files && $('fileInput').files[0]; $('fileInput').value = ''; if (f) runInspection(f, 'ملف') })
  $('btnFlip').addEventListener('click', () => { S.facing = S.facing === 'environment' ? 'user' : 'environment'; startCamera() })
  $('btnCancel').addEventListener('click', () => { if (S.controller) S.controller.abort() })
  $('overlay').addEventListener('click', onOverlayTap)
  $('btnPickerCancel').addEventListener('click', closePicker)
  document.querySelectorAll('.btn.dec').forEach((b) => b.addEventListener('click', () => setDecision(b.dataset.dec)))
  $('btnSave').addEventListener('click', saveInspection)
  $('btnRetry').addEventListener('click', saveInspection)
  $('btnNew').addEventListener('click', newPiece)
  $('btnBack').addEventListener('click', newPiece)
  // overlay alignment needs no JS on resize: the svg is positioned on the same box as the <img> (see style.css .photoWrap)
}

function setSide(side) { S.side = side; $('sideFront').classList.toggle('active', side === 'front'); $('sideBack').classList.toggle('active', side === 'back') }

function renderOrders(list) {
  S.orders = list || []; const sel = $('orderSel'); clear(sel)
  if (!S.orders.length) { sel.appendChild(opt('', 'ما في طلبيات')); return }
  S.orders.forEach((o, i) => sel.appendChild(opt(String(i), [o.order_number, o.product, o.color, o.line].filter(Boolean).join(' · '))))
  const last = lsGet('vqc_order'); const idx = Math.max(0, S.orders.findIndex((o) => o.order_number === last))
  sel.value = String(idx); S.order = S.orders[idx]
}

async function refreshStats() {
  if (!S.db) return
  try { const s = await S.db.todayStats(); $('stats').textContent = `اليوم: ${s.inspections || 0} فحص · ${s.red || 0} أحمر · ${s.confirmed || 0} مؤكد` } catch (e) { $('stats').textContent = '' }
}

// ── camera + stillness loop ──────────────────────────────────────────────────
function stopCamera() {
  clearInterval(S.loop); S.loop = null
  if (S.cam) { try { S.cam.stop() } catch (e) { /* ignore */ } }
  S.cam = null; S.det = null
}

async function startCamera() {
  stopCamera()
  const video = $('video')
  try {
    S.cam = await openCamera(video, { facing: S.facing })
  } catch (e) {
    // desktop / no permission: hide the pill, keep the file button usable
    S.cam = null; $('pill').hidden = true; $('btnShoot').disabled = true; $('btnFlip').disabled = true
    const m = $('camMsg'); m.textContent = 'الكاميرا ما اشتغلت على هالجهاز — استعمل «📁 صورة من الجهاز». (' + msg(e) + ')'; m.hidden = false
    return
  }
  $('pill').hidden = false; $('btnShoot').disabled = false; $('btnFlip').disabled = false; $('camMsg').hidden = true
  S.det = new StillnessDetector()
  S.det.onStill = () => { if (S.autoCapture && S.view === 'camera' && !S.running && !S.capturing) captureFromCamera('تلقائي') }
  S.sampleCanvas = S.sampleCanvas || document.createElement('canvas')
  setPill('idle')
  S.loop = setInterval(sampleTick, 125)        // ~8 fps is plenty for a hands-left-the-frame detector
}

function sampleTick() {
  const video = $('video')
  if (!S.cam || !S.det || video.readyState < 2) return
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
  if (S.running || S.capturing) { toast('في فحص شغّال — استنّي يخلص'); return }
  if (!S.cam) { toast('ما في كاميرا — استعمل «صورة من الجهاز»'); return }
  S.capturing = true
  try {
    const blob = await takePhoto(S.cam, $('video'))
    await runInspection(blob, label)
  } catch (e) { toast('ما قدرت آخد الصورة: ' + msg(e)) } finally { S.capturing = false }
}

// ── inspection run ───────────────────────────────────────────────────────────
function setView(v) {
  S.view = v
  $('cameraPanel').hidden = v !== 'camera'
  $('inspectPanel').hidden = v === 'camera'
  $('viewHead').hidden = v !== 'history'
  $('tapHint').hidden = v !== 'inspect'
  if (v !== 'inspect') { $('progress').hidden = true; $('runError').hidden = true; $('costLine').textContent = '' }
  if (v !== 'inspect') $('decisionBar').hidden = true
}

async function runInspection(blob, sourceLabel) {
  if (S.running) { toast('في فحص شغّال — استنّي يخلص'); return }
  if (!blob || !blob.size) { toast('الصورة فاضية'); return }
  S.running = true
  resetInspection(); setView('inspect'); renderCards()           // placeholder «عم فحص…» while the run is in progress
  S.blob = blob; S.source = sourceLabel
  const controller = new AbortController(); S.controller = controller
  const order = S.order
  S.warns = []; S.tilesDone = 0; S.progL = ''; S.progG = ''; $('progressWarn').textContent = ''; $('progressWarn').title = ''
  $('progress').hidden = false; $('btnCancel').hidden = false; $('runError').hidden = true; $('costLine').textContent = ''
  setProgress('عم جهّز الصورة…'); startTimer()
  try {
    const img = await fromBlob(blob); S.img = img
    await showPhoto(await img.previewUrl(1600), img.width, img.height)
    if (!S.api) throw new Error('ما في إعدادات (config.js) — ما فيني كلّم الموديل')
    // the pipeline passes request bodies through untouched, so the AbortSignal rides along in each body (api.js strips it)
    const wrappedApi = { responses: (b) => S.api.responses({ ...b, signal: controller.signal }) }
    // signal goes to the pipeline too: it stops starting new tiles/stages and rejects with AbortError right away
    const res = await inspect(img, { api: wrappedApi, samParser, garment: (order && order.garment) || 'garment', onProgress, concurrency: 6, signal: controller.signal })
    if (S.img !== img) return                   // the inspector moved on while we were running
    // the pipeline turns aborted calls into stage warnings and resolves with an empty result — report the cancel, not «no defects»
    if (controller.signal.aborted) { setProgress('انلغى الفحص'); return }
    S.res = res
    S.findings = (res.findings || []).map((f) => ({ ...f, verdict: null, worker_name: null, stage: null }))
    renderAll(); showCost(res)
    setProgress(S.findings.length ? `خلص — ${S.findings.length} نقطة للمراجعة` : 'خلص — ما لقيت شي مشبوه')
  } catch (e) {
    if (controller.signal.aborted) setProgress('انلغى الفحص')
    else { setProgress('وقف الفحص'); $('runErrorText').textContent = msg(e) + (e && e.stack && !String(e.stack).startsWith(msg(e)) ? '\n' + e.stack : ''); $('runError').hidden = false }
  } finally {
    stopTimer(); S.running = false; S.controller = null; $('btnCancel').hidden = true
    // cards are refreshed here (after running=false) so a cancel / error shows «ما في نتيجة…» instead of a stale «عم فحص…»
    if (S.view === 'inspect' && S.img) { renderCards(); $('decisionBar').hidden = false; updateSaveEnabled() }
  }
}

function showPhoto(url, w, h) {
  const photo = $('photo'), svg = $('overlay'); clear(svg)
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
    case 'garment': S.progL = 'عم دوّر عالقطعة…'; S.progG = ''; two(); break
    case 'tiles': S.progL = `عم فحص ${info.count} بلاطة…`; two(); break
    case 'tile': S.tilesDone++; S.progL = `بلاطة ${S.tilesDone}/${info.n}`; two(); break          // tiles finish out of order → count completions
    case 'verify': S.progL = info.count ? `عم أكد ${info.count} نقطة…` : 'ما في نقاط مشبوهة بالبلاطات'; two(); break
    case 'parts': S.progG = 'عم قارن اليمين بالشمال…'; two(); break
    case 'global': S.progG = 'نظرة عامة…'; two(); break
    case 'stage_done':
      if (info.stage === 'verify') S.progL = 'النقاط المحلية خلصت ✓'
      if (info.stage === 'global') S.progG = ''
      two(); break
    case 'warn': S.warns.push(info); $('progressWarn').textContent = `⚠ ${S.warns.length}`; $('progressWarn').title = S.warns.map((w) => `${w.stage}: ${w.error}`).join('\n'); break
  }
}
function setProgress(t) { $('progressText').textContent = t }
function startTimer() { S.runStarted = Date.now(); stopTimer(); S.timer = setInterval(tickTimer, 200); tickTimer() }
function tickTimer() { $('progressTimer').textContent = ((Date.now() - S.runStarted) / 1000).toFixed(1) + ' ث' }
function stopTimer() { clearInterval(S.timer); S.timer = null; tickTimer() }

function showCost(res) {
  const u = res.usage || {}, t = res.timings || {}
  const usd = ((u.input_tokens || 0) * 1.25 + (u.output_tokens || 0) * 4.25) / 1e6 + 0.0025 * (u.sam_calls || 0)
  $('costLine').textContent = `~$${usd.toFixed(3)} · ${((t.total || 0) / 1000).toFixed(1)} s · ${u.calls || 0} Spark · ${u.sam_calls || 0} SAM · ${res.tiles || 0} tiles · ${(u.input_tokens || 0)}/${(u.output_tokens || 0)} tok`
}

// ── overlay (circles) ────────────────────────────────────────────────────────
// Color: red level → red; global kind (silhouette / mirror / global) below red → blue, dashed; everything else amber.
const colorClass = (f) => f.level === 'red' ? 'red' : f.kind === 'global' ? 'blue' : 'amber'
const ringR = (W, H) => Math.max(40, 0.02 * Math.max(W, H))

function renderOverlay() {
  const svg = $('overlay'); clear(svg)
  if (!S.img) return
  const W = S.img.width, H = S.img.height, r = ringR(W, H)
  const gb = S.res && S.res.garmentBox
  if (gb) svg.appendChild(svgEl('rect', { x: gb.x, y: gb.y, width: gb.w, height: gb.h, class: 'gbox', 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': `${r * 0.3} ${r * 0.2}` }))
  S.findings.forEach((f, i) => svg.appendChild(markGroup(f, i, r)))
}

function markGroup(f, i, r) {
  const g = svgEl('g', { class: 'mark ' + colorClass(f) + (f.verdict ? ' v-' + f.verdict : '') })
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
  if (S.view !== 'inspect' || !S.img) return
  if (S.running) { toast('استنّي يخلص الفحص'); return }
  if (S.job && S.job.done) { toast('انحفظ هالفحص — افحص قطعة جديدة لتعدّل'); return }
  const svg = $('overlay'); let pt
  try { const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; const q = p.matrixTransform(svg.getScreenCTM().inverse()); pt = { x: Math.round(q.x), y: Math.round(q.y) } }
  catch (e) { const b = svg.getBoundingClientRect(); pt = { x: Math.round((ev.clientX - b.left) / b.width * S.img.width), y: Math.round((ev.clientY - b.top) / b.height * S.img.height) } }
  pt.x = Math.max(0, Math.min(pt.x, S.img.width - 1)); pt.y = Math.max(0, Math.min(pt.y, S.img.height - 1))
  S.pending = pt
  const r = ringR(S.img.width, S.img.height)
  const g = svgEl('g', { class: 'mark pending', id: 'pendingMark' }); g.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r, class: 'ring', 'vector-effect': 'non-scaling-stroke' })); svg.appendChild(g)
  $('picker').hidden = false
}
function buildPicker() { const grid = $('pickerGrid'); for (const k in TYPE_AR) { const b = el('button', 'btn', TYPE_AR[k]); b.type = 'button'; b.addEventListener('click', () => pickType(k)); grid.appendChild(b) } }
function closePicker() { $('picker').hidden = true; S.pending = null; const g = $('pendingMark'); if (g) g.remove() }
function pickType(type) {
  const pt = S.pending; closePicker(); if (!pt || !S.img) return
  S.findings.push({ kind: 'local', source: 'inspector', type, x: pt.x, y: pt.y, confidence: 1, level: 'red', severity: 'major', why: 'علّمتها المفتشة', verdict: 'added', verdict_at: new Date().toISOString(), worker_name: null, stage: null })
  renderAll(); focusCard(S.findings.length - 1)
}

// ── cards ────────────────────────────────────────────────────────────────────
function renderAll() { renderOverlay(); renderCards(); updateSaveEnabled() }

function renderCards() {
  const box = $('findings'); clear(box); box.classList.toggle('locked', !!(S.job && S.job.done))
  $('findingsCount').textContent = S.findings.length ? String(S.findings.length) : ''
  if (S.view === 'camera') { box.appendChild(el('div', 'empty', 'حطّ القطعة تحت الكاميرا وشيل إيديك — أو اختار صورة من الجهاز')); return }
  if (S.view === 'history') return
  if (!S.findings.length) { box.appendChild(el('div', 'empty', S.res ? 'ما لقيت شي مشبوه 👍 — كبس عالصورة إذا شفت عيب' : (S.running ? 'عم فحص…' : 'ما في نتيجة — كبس عالصورة إذا شفت عيب، أو افحص قطعة جديدة'))); return }
  S.findings.forEach((f, i) => box.appendChild(buildCard(f, i)))
}

function cardHead(f, i) {
  const head = el('div', 'cardHead')
  head.appendChild(el('span', 'num', String(i + 1)))
  head.appendChild(el('span', 'type', TYPE_AR[f.type] || f.type || 'شي تاني'))
  head.appendChild(el('span', 'conf', Math.round((+f.confidence || 0) * 100) + '%'))
  if (f.kind === 'global') head.appendChild(el('span', 'tag', f.source === 'silhouette' ? 'قياس' : f.source === 'mirror' ? 'مقارنة' : 'عام'))
  if (f.unsure) head.appendChild(el('span', 'tag unsure', 'مش متأكد'))
  if (f.severity === 'major' && f.source !== 'inspector') head.appendChild(el('span', 'tag unsure', 'كبير'))
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
    foot.appendChild(el('span', 'chip added', '➕ علّمتها المفتشة'))
    const rm = el('button', 'btn', '✗ شيلها'); rm.type = 'button'
    rm.addEventListener('click', () => { S.findings.splice(i, 1); renderAll() }); foot.appendChild(rm)
  } else {
    const yes = el('button', 'btn yes' + (f.verdict === 'confirmed' ? ' active' : ''), '✓ عيب'); yes.type = 'button'
    const no = el('button', 'btn no' + (f.verdict === 'rejected' ? ' active' : ''), '✗ مش عيب'); no.type = 'button'
    yes.addEventListener('click', () => setVerdict(f, 'confirmed')); no.addEventListener('click', () => setVerdict(f, 'rejected'))
    foot.appendChild(yes); foot.appendChild(no)
  }
  if (f.verdict === 'confirmed' || f.verdict === 'added') foot.appendChild(workerSelect(f))
  card.appendChild(foot)
  return card
}

function setVerdict(f, v) {
  f.verdict = f.verdict === v ? null : v                        // tapping the active button clears it
  f.verdict_at = f.verdict ? new Date().toISOString() : null
  if (!f.verdict) { f.worker_name = null; f.stage = null; f._workerId = '' }
  renderAll()
}

function workerSelect(f) {
  const sel = el('select', 'worker'); sel.appendChild(opt('', '— مين خيّطها؟ —'))
  const line = S.order && S.order.line
  let ws = S.workers.filter((w) => !line || w.line === line); if (!ws.length) ws = S.workers
  ws.forEach((w) => sel.appendChild(opt(String(w.id), [w.name, w.stage].filter(Boolean).join(' · '))))
  sel.value = f._workerId || ''
  sel.addEventListener('change', () => { const w = S.workers.find((x) => String(x.id) === sel.value); f._workerId = sel.value; f.worker_name = w ? w.name : null; f.stage = w ? (w.stage || null) : null })
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
function cropUrl(f, img) { return cropBlob(f, img).then((b) => { if (!b) return null; if (!f._cropUrl) f._cropUrl = URL.createObjectURL(b); return f._cropUrl }) }

// ── decision + save ──────────────────────────────────────────────────────────
function setDecision(dec) {
  if (S.job && S.job.done) { toast('انحفظ هالفحص — افحص قطعة جديدة'); return }
  S.decision = dec
  document.querySelectorAll('.btn.dec').forEach((b) => b.classList.toggle('active', b.dataset.dec === dec))
  updateSaveEnabled()
}
function updateSaveEnabled() {
  const b = $('btnSave'), done = S.job && S.job.done, busy = S.job && S.job.busy
  b.disabled = !S.decision || !S.img || !S.db || !!done || !!busy
  b.textContent = done ? '✓ انحفظ' : busy ? 'عم يحفظ…' : '💾 حفظ'
  b.classList.toggle('busy', !!busy)
  if (!S.db && S.img) $('saveStatus').textContent = 'ما في اتصال بالقاعدة (config.js) — الحفظ معطّل'
}
function saveStatus(t, cls) { const s = $('saveStatus'); s.textContent = t; s.className = 'status' + (cls ? ' ' + cls : '') }

function saveInspection() {
  if (!S.decision || !S.img || !S.db) return
  if (S.job && (S.job.busy || S.job.done)) return
  if (!S.job) S.job = { busy: false, done: false, img: S.img, blob: S.blob, res: S.res, findings: S.findings, order: S.order, side: S.side, inspector: S.inspector, id: null, date: null, paths: {}, crops: {}, prep: null, patched: false, findingIds: null, examples: false, closeAfter: false }
  S.job.decision = S.decision                                   // the decision may change between a failed attempt and a retry
  runSave(S.job)
}

// Resumable: every step is skipped once it succeeded, so «🔁 حاول الحفظ مرة تانية» continues where it stopped. Nothing here blocks the UI.
async function runSave(job) {
  job.busy = true; updateSaveEnabled(); $('btnRetry').hidden = true
  const db = S.db, n = job.findings.length
  try {
    if (!job.prep) { saveStatus('عم جهّز الصور…'); job.prep = await prepareBlobs(job) }
    if (!job.id) {
      saveStatus('عم سجّل الفحص…')
      const r0 = await db.insertInspection(inspectionRow(job)); const r = Array.isArray(r0) ? r0[0] : r0
      if (!r || r.id == null) throw new Error('القاعدة ما رجّعت رقم الفحص')
      job.id = r.id; job.date = ymd(r.created_at ? new Date(r.created_at) : new Date())
    }
    const base = `${job.date}/${job.id}/`
    if (!job.paths.photo) { saveStatus('عم رفع الصورة…'); await db.uploadPhoto(base + 'photo.jpg', job.prep.photo); job.paths.photo = base + 'photo.jpg' }
    if (!job.paths.annotated && job.prep.annotated) { saveStatus('عم رفع الصورة المعلّمة…'); await db.uploadPhoto(base + 'annotated.jpg', job.prep.annotated); job.paths.annotated = base + 'annotated.jpg' }
    for (let i = 0; i < n; i++) {
      if (job.crops[i] || !job.prep.crops[i]) continue
      saveStatus(`عم رفع القصّات ${i + 1}/${n}…`)
      const p = base + `crop-${i + 1}.jpg`; await db.uploadPhoto(p, job.prep.crops[i]); job.crops[i] = p
    }
    if (!job.patched) { await db.updateInspection(job.id, { photo_path: job.paths.photo, annotated_path: job.paths.annotated || null, decision: job.decision }); job.patched = true }
    if (!job.findingIds) {
      saveStatus('عم سجّل النقاط…')
      const rows = job.findings.map((f, i) => findingRow(job, f, i))
      const ins = rows.length ? await db.insertFindings(rows) : []
      job.findingIds = (Array.isArray(ins) ? ins : []).map((r) => r.id)
    }
    if (!job.examples) {
      saveStatus('عم سجّل الأمثلة…')
      const ex = []
      job.findings.forEach((f, i) => {
        if (!f.verdict || !job.crops[i]) return                 // vision_examples.crop_path is NOT NULL
        ex.push({ finding_id: job.findingIds[i] == null ? null : job.findingIds[i], model_code: job.order ? job.order.model_code : null, type: f.type || 'other', label: f.verdict === 'rejected' ? 'not_defect' : 'defect', crop_path: job.crops[i], note: f.why || null })
      })
      if (ex.length) await db.insertExamples(ex)
      job.examples = true
    }
    job.done = true; saveStatus('✓ انحفظ', 'ok')
    if (S.job === job) { renderCards(); updateSaveEnabled() }
    refreshStats(); loadHistory()
  } catch (e) {
    saveStatus('ما انحفظ: ' + msg(e), 'bad')
    if (S.job === job) $('btnRetry').hidden = false
  } finally {
    job.busy = false
    if (S.job === job) updateSaveEnabled()
    if (job.closeAfter) safeClose(job.img)                     // the inspector already moved to a new piece
  }
}

// everything that needs the image adapter is made up-front, so «📷 قطعة جديدة» can free the bitmap while uploads continue
async function prepareBlobs(job) {
  const { img, blob } = job
  const full = { x: 0, y: 0, w: img.width, h: img.height }
  const photo = (blob.size > BIG_PHOTO) ? await img.blob({ ...full, quality: 0.85 }) : (blob.type && blob.type !== 'image/jpeg') ? await img.blob({ ...full, quality: 0.92 }) : blob
  let annotated = null
  try { annotated = await renderAnnotated(job) } catch (e) { /* optional */ }
  const crops = []
  for (let i = 0; i < job.findings.length; i++) crops.push(await cropBlob(job.findings[i], img))
  return { photo, annotated, crops }
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
    width: job.img.width, height: job.img.height, garment_box: (res && res.garmentBox) || null, result: res || null,
    n_red: job.findings.filter((f) => f.level === 'red').length, n_amber: job.findings.filter((f) => f.level === 'amber').length,
    decision: job.decision, duration_ms: t.total == null ? null : Math.round(t.total), input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
  }
}
function findingRow(job, f, i) {
  return {
    inspection_id: job.id, kind: f.kind || 'local', source: f.source || 'tiles', type: f.type || 'other', x: Math.round(f.x), y: Math.round(f.y),
    confidence: Math.round((+f.confidence || 0) * 1000) / 1000, level: f.level || null, severity: f.severity || null, why: f.why || null,
    crop_path: job.crops[i] || null, verdict: f.verdict || null, verdict_by: f.verdict ? (job.inspector || null) : null,
    verdict_at: f.verdict ? (f.verdict_at || new Date().toISOString()) : null, worker_name: f.worker_name || null, stage: f.stage || null,
  }
}

// ── new piece / reset ────────────────────────────────────────────────────────
function resetInspection() {
  closePicker()
  S.findings.forEach((f) => { if (f._cropUrl) { try { URL.revokeObjectURL(f._cropUrl) } catch (e) { /* ignore */ } f._cropUrl = null } })
  if (S.job && S.job.busy) S.job.closeAfter = true; else safeClose(S.img)      // uploads in flight already hold their blobs
  S.img = null; S.blob = null; S.res = null; S.findings = []; S.decision = null; S.job = null; S.warns = []
  $('photo').removeAttribute('src'); clear($('overlay'))
  document.querySelectorAll('.btn.dec').forEach((b) => b.classList.remove('active'))
  saveStatus(''); $('btnRetry').hidden = true; $('runError').hidden = true; $('costLine').textContent = ''
  $('findings').classList.remove('locked'); updateSaveEnabled()
}
function newPiece() {
  if (S.running) { toast('في فحص شغّال — استنّي يخلص أو ألغيه'); return }
  if (S.img && S.view === 'inspect' && !(S.job && (S.job.done || S.job.busy)) && !confirm('هالفحص ما انحفظ — تتركو؟')) return
  resetInspection(); setView('camera'); renderCards()
  if (S.det) S.det.reset()
}

// ── history strip + read-only view ───────────────────────────────────────────
async function loadHistory() {
  if (!S.db) return
  try { S.history = (await S.db.recentInspections(12)) || [] } catch (e) { banner('ما قدرت جيب آخر الفحوصات: ' + msg(e)); return }
  const strip = $('historyStrip'); clear(strip)
  if (!S.history.length) { strip.appendChild(el('div', 'empty', 'بعد ما في فحوصات')); return }
  S.history.forEach((h) => {
    const b = el('button', 'hist'); b.type = 'button'
    const im = el('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'
    // the 1600 px annotated copy is far lighter than the full-res photo; photo_path is the fallback
    const p = h.annotated_path || h.photo_path; if (p) im.src = S.db.publicUrl(p)
    b.appendChild(im)
    b.appendChild(el('span', 'hdec', DEC_EMOJI[h.decision] || '·'))
    b.appendChild(el('span', 'hord', h.order_number || h.model_code || ''))
    b.appendChild(el('span', 'htime', `${hhmm(h.created_at)} · ${SIDE_AR[h.side] || ''}`))
    b.addEventListener('click', () => openHistory(h))
    strip.appendChild(b)
  })
}

async function openHistory(h) {
  if (S.running) { toast('في فحص شغّال — استنّي يخلص'); return }
  if (S.img && S.view === 'inspect' && !(S.job && (S.job.done || S.job.busy)) && !confirm('هالفحص ما انحفظ — تتركو؟')) return
  resetInspection(); setView('history')
  $('viewTitle').textContent = `فحص #${h.id} · ${h.order_number || ''} · ${SIDE_AR[h.side] || ''} · ${DEC_EMOJI[h.decision] || ''} ${DEC_AR[h.decision] || 'بلا قرار'} · ${h.inspector || ''} · ${hhmm(h.created_at)}`
  const p = h.annotated_path || h.photo_path
  clear($('overlay')); $('photo').src = p ? S.db.publicUrl(p) : ''
  const box = $('findings'); clear(box); box.appendChild(el('div', 'empty', 'عم جيب النقاط…'))
  let rows = []
  try { rows = (await S.db.findingsFor(h.id)) || [] } catch (e) { clear(box); box.appendChild(el('div', 'empty', 'ما قدرت جيب النقاط: ' + msg(e))); return }
  if (S.view !== 'history') return
  clear(box); $('findingsCount').textContent = rows.length ? String(rows.length) : ''
  if (!rows.length) { box.appendChild(el('div', 'empty', 'ما كان في نقاط')); return }
  rows.forEach((f, i) => {
    const card = el('div', 'card ' + colorClass(f) + (f.verdict ? ' v-' + f.verdict : '')); card.appendChild(cardHead(f, i))
    const body = el('div', 'cardBody'); const thumb = el('img', 'thumb'); thumb.alt = ''; thumb.loading = 'lazy'
    if (f.crop_path) thumb.src = S.db.publicUrl(f.crop_path); body.appendChild(thumb); body.appendChild(el('div', 'why', f.why || '')); card.appendChild(body)
    const foot = el('div', 'cardFoot')
    const chipText = { confirmed: '✓ عيب', rejected: '✗ مش عيب', added: '➕ علّمتها المفتشة' }[f.verdict] || 'بلا قرار'
    foot.appendChild(el('span', 'chip ' + (f.verdict || ''), chipText))
    if (f.worker_name) foot.appendChild(el('span', 'chip', [f.worker_name, f.stage].filter(Boolean).join(' · ')))
    card.appendChild(foot); box.appendChild(card)
  })
}

init()
