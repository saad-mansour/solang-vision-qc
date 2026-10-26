# SOLANG Vision QC — station contracts (read before touching any station file)

Built during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Vanilla HTML/JS **ES modules, no build step, no framework**.
The station page runs on a phone/tablet mounted above the final-QC table in a children's clothing factory. The inspector keeps working as usual;
the page watches the live camera, and when the garment is lying still and the hands leave the frame it takes a FULL-RESOLUTION photo,
runs the inspection pipeline (SAM 3.1 + Muse Spark through a proxy) and shows the suspected spots as circles. The inspector confirms / rejects /
adds spots, picks a decision, and everything is saved to a throwaway demo Supabase project. **Human in the loop: the page suggests, the inspector decides.**

Repo layout (relative to repo root):

```
shared/pipeline.js            core inspection (already written, see its header for the injected adapters) — DO NOT change its exports' signatures
station/index.html            the page (RTL Arabic)            ← owner: UI agent
station/style.css                                             ← owner: UI agent
station/app.js                UI controller                    ← owner: UI agent
station/camera.js             camera + stillness detector      ← owner: media agent
station/browser-image.js      image adapter for the pipeline   ← owner: media agent
station/api.js                proxy client + Supabase client   ← owner: backend agent
station/config.js             per-deployment values (gitignored for now) — shape in config.example.js
station/config.example.js
station/vendor/meta-sam-parser/   @meta-sam/parser 0.1.0 dist, vendored as-is (ESM, browser-safe). import from './vendor/meta-sam-parser/index.js'
dev/serve.mjs                 local dev server: static files from repo root + /v1/* proxy to api.meta.ai (key from meta_key.txt) ← owner: backend agent
dev/run_pipeline.mjs          Node harness (sharp) — already works
dev/tests/*.mjs               plain Node tests (node dev/tests/x.mjs, exit code != 0 on failure). No test framework.
worker/src/index.js           Cloudflare Worker proxy (production) — already written
sql/demo-schema.sql, sql/storage-policies.sql   demo DB (already applied to the demo project)
```

Rules for every agent
- Plain JS (ES2022), modules, `'use strict'` semantics. No TypeScript, no bundler, no npm deps in `station/`.
- Never put model output or DB text into `innerHTML`. Build DOM with `textContent` / `createElement` (XSS: the model returns free text).
- Never log or embed secrets. `meta_key.txt` and `supabase_demo.txt` are local only. `station/config.js` holds only the **publishable** Supabase key + station token.
- Arabic UI, `dir="rtl"`, Levantine wording, short labels. Numbers in Western digits. Font: system (`system-ui, "Segoe UI", Tahoma`), no web fonts.
- Everything must work on Chrome/Android and Safari/iOS tablets; also on desktop Chrome with a file picker instead of the camera.
- Do not touch files you do not own (the table above). If you need something from another module, code against the contract below and
  write a note at the end of your report.

---

## 1. `station/config.example.js` (copied by hand to `config.js`)

```js
export default {
  PROXY_URL: '',                       // '' = same origin (dev server proxies /v1/*). Production: 'https://<worker>.workers.dev'
  STATION_TOKEN: '',                   // sent as X-Station-Token (the Worker checks it; dev server ignores it)
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_KEY: 'sb_publishable_xxx',  // publishable (anon) key of the DEMO project only
  STATION: 'final-qc-1',               // station name saved with each inspection
  BUCKET: 'vision-photos',
}
```

## 2. `station/api.js` (backend agent)

```js
export function makeApi(cfg)            // → { responses(body) }
```
- `responses(body)` → `POST ${cfg.PROXY_URL}/v1/responses`, headers `Content-Type: application/json`, `X-Station-Token: cfg.STATION_TOKEN` (omit header when empty).
  Returns parsed JSON. On HTTP error throws `Error` with `.status` and message `HTTP <status> <first 200 chars>`.
  Retry **once** after 1.5 s on 429 / 502 / 503 / 504 / network error. Accept `body.signal` (an AbortSignal) — strip it from the JSON and pass it to fetch.

```js
export function makeDb(cfg)             // → db object, all methods async, all throw Error('<what> HTTP <status> <body>') on failure
db.listOrders()                          // GET demo_orders order by order_number → [{order_number, model_code, product, garment, color, line, reference_url}]
db.listWorkers()                         // GET demo_workers order by line, id → [{id, name, line, stage}]
db.insertInspection(row)                 // POST vision_inspections, Prefer: return=representation → the inserted row (with id)
db.updateInspection(id, patch)           // PATCH vision_inspections?id=eq.<id>
db.insertFindings(rows)                  // POST vision_findings (array), return=representation → rows with ids (same order)
db.updateFinding(id, patch)              // PATCH vision_findings?id=eq.<id>
db.insertExamples(rows)                  // POST vision_examples (array) → rows
db.recentInspections(limit = 12)         // GET vision_inspections select=id,created_at,order_number,model_code,side,photo_path,annotated_path,n_red,n_amber,decision,inspector order=created_at.desc
db.findingsFor(inspectionId)             // GET vision_findings?inspection_id=eq.<id>&order=id
db.examplesFor(modelCode, limit = 12)    // GET vision_examples?model_code=eq.<code>&order=created_at.desc&limit
db.todayStats()                          // → {inspections, red, confirmed, rejected}  (counts since local midnight; use created_at=gte.<ISO> with Prefer: count=exact and HEAD/limit=1, or select then count — keep it to ≤3 requests)
db.uploadPhoto(path, blob, contentType = 'image/jpeg')   // POST /storage/v1/object/<BUCKET>/<path> with x-upsert: true → returns the public URL
db.publicUrl(path)                       // `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
```
- Headers for REST: `apikey: KEY`, `Authorization: Bearer KEY`, `Content-Type: application/json`, plus `Prefer` where stated.
- Storage upload: same `apikey`/`Authorization` + `Content-Type: <contentType>`, body = the Blob. No upsert: the bucket has no UPDATE policy; a 409 (path already stored by an earlier attempt) counts as success.
- Paths use URL-safe ASCII only: `YYYY-MM-DD/<inspectionId>/photo.jpg`, `.../annotated.jpg`, `.../crop-<n>.jpg` (the UI decides the names; `uploadPhoto` just uploads).
- The publishable key cannot DELETE storage objects (by policy) — do not implement delete.

## 3. `dev/serve.mjs` (backend agent)

`node dev/serve.mjs [--port 8787] [--host 127.0.0.1]` from ANY cwd (resolve paths from `import.meta.url`).
- Static files from the **repo root** with correct `Content-Type` (`.html .js .mjs .css .json .jpg .jpeg .png .svg .webp .txt .md .ico .map`), `Cache-Control: no-store`, directory → `index.html`. Deny `..` traversal and never serve `meta_key.txt`, `supabase_demo.txt`, `*.key`, `.env*`, `node_modules`.
- `GET /health` → `{ok:true, mode:'dev'}`.
- `/v1/*` (POST and GET) → forward to `https://api.meta.ai/v1/*` with `Authorization: Bearer <key from <root>/meta_key.txt, trimmed, BOM-stripped>`. Same model allow-list as the Worker (`muse-spark-1.3`, `muse-spark-1.2`, `sam-3.1`, `muse-voice-transcribe-1.0`), force `stream:false`, pass status + JSON body back, CORS `*` + `X-Station-Token` allowed. Body limit 25 MB.
- Log one line per request: `method path status ms` (never the body).
- Must handle 10+ concurrent proxy requests (the pipeline fires 6 at a time).

## 4. `station/browser-image.js` (media agent)

```js
export async function fromBlob(blob)     // → img adapter (below). Applies EXIF orientation: createImageBitmap(blob, {imageOrientation:'from-image'}) with fallback.
export async function fromVideoFrame(videoEl) // → img adapter from the current video frame (full video track resolution)
```
Adapter object (this is exactly what `shared/pipeline.js` expects, see its header):
```js
img.width, img.height                    // ints, after orientation
await img.jpeg({x, y, w, h, resize, mirror}) → base64 string WITHOUT the "data:image/jpeg;base64," prefix
   // crop rect in full-res pixels (clamp to the image); resize = {w,h} optional target size; mirror = true → flip horizontally
   // JPEG quality 0.9. Use OffscreenCanvas when available else a detached <canvas>. Never exceed 4096 px on a side for the output canvas.
await img.blob({x, y, w, h, resize, quality})   → Blob 'image/jpeg' (same semantics; used for uploads/crops; default quality 0.92)
await img.previewUrl(maxSide = 1600)      → object URL of a downscaled JPEG for display (cache it; revoke in close())
img.close()                              // free the bitmap and revoke URLs
```
- Must work with a 24 MP photo (e.g. 4284×5712) on a tablet: draw crops straight from the bitmap, never allocate a full-res RGBA copy besides the bitmap itself.
- Export also `export function fitWithin(w, h, maxSide)` → `{w, h, scale}`.

## 5. `station/camera.js` (media agent)

```js
export async function openCamera(videoEl, {facing = 'environment', idealWidth = 4096, idealHeight = 3072} = {})
   // → { stream, track, settings: track.getSettings(), capabilities, stop() }   — plays the stream in videoEl (muted, playsInline)
export async function takePhoto(cam, videoEl)
   // → Blob (image/jpeg). Prefer ImageCapture(track).takePhoto({imageWidth/Height = max of photo capabilities}); on any failure fall back to
   //   drawing the current video frame on a canvas (track resolution). Always returns a Blob; set blob.source = 'imagecapture' | 'frame'.
export class StillnessDetector
   constructor({ moveThreshold = 8, stillThreshold = 2.5, stillMs = 1200, cooldownMs = 4000, sameSceneThreshold = 1.5, sampleW = 64, sampleH = 48 } = {})
   feed(gray: Uint8ClampedArray, w, h, nowMs)   // one downscaled grayscale frame → returns { state, score }
   // state machine: 'idle' (nothing happened yet) → 'moving' (score > moveThreshold: hands/garment moving) → 'settling' (score < stillThreshold,
   //   waiting stillMs) → 'still' (emit once; onStill(frame) fires) → 'cooldown' (cooldownMs or until a new 'moving' burst) → 'moving' …
   // 'still' is NOT re-emitted for the same scene: compare the settled frame with the last captured frame (mean abs diff < sameSceneThreshold → skip, state 'same').
   onStill = null                              // callback(frameInfo) assigned by the app
   reset()
   lastScore, state
export function grayscaleSample(videoEl, canvas, w, h)   // draws the video frame downscaled into canvas and returns Uint8ClampedArray of w*h gray values (luma)
```
- The detector must be a **pure** class (no DOM) so `dev/tests/test_stillness.mjs` can drive it with synthetic frames: a burst of motion, then still frames for 1.3 s must yield exactly one 'still'; staying still for 10 s more yields none; a new burst then still yields a second one; same-scene check skips a re-capture when the settled frame equals the previous captured frame.
- Score = mean absolute difference between consecutive sampled frames (0–255 scale). Document the thresholds in a comment.

## 6. `station/index.html`, `style.css`, `app.js` (UI agent)

Layout (portrait tablet first, works landscape and desktop):
1. **Top bar**: logo text «SOLANG Vision QC», order `<select>` (label: `W26-101 · سويت شيرت أطفال · كاميل · خط 2`), side toggle «وجه / ضهر», inspector name input (persist in `localStorage['vqc_inspector']`), small stats «اليوم: N فحص · N أحمر · N مؤكد».
2. **Camera panel**: `<video>` live preview (object-fit: contain), a status pill bound to the detector state («جاهزة», «في حركة», «ثابتة…», «📸 لقطة!», «نفس القطعة»), auto-capture toggle (default ON), buttons: «📸 افحص هلق» (manual), «📁 صورة من الجهاز» (hidden `<input type=file accept=image/*>`), «🔄 كاميرا» (switch facing). Camera failures show a friendly Arabic message and leave the file button usable.
3. **Inspection panel** (replaces/overlays camera while running): the captured photo (preview URL) inside a container with an absolutely-positioned `<svg>` overlay that maps full-res coordinates to the displayed size (viewBox = `0 0 width height`). Progress line in Arabic per stage with a running timer: `garment` «عم دوّر عالقطعة…», `tiles` «عم فحص N بلاطة…», `tile` «بلاطة i/n», `verify` «عم أكد N نقطة…», `parts` «عم قارن اليمين بالشمال…», `global` «نظرة عامة…», `warn` (collect, show count). Cancel button → AbortController passed as `signal` in `api.responses` bodies (the pipeline passes bodies through; wrap `api.responses` in app.js to inject it).
4. **Findings**: numbered circles on the overlay (red ≥0.8, amber 0.5–0.8, blue for `kind==='global'` findings with source `global`/`mirror`/`silhouette` — use the finding's `level` for color and dashed stroke for global). Below: one card per finding: number, Arabic type, confidence %, `why`, a 2× crop thumbnail (make it with `img.blob(window || {x-250,y-250,500,500}, resize 400)`), buttons «✓ عيب» / «✗ مش عيب», and a worker `<select>` (workers of the order's line, with stage) shown once a finding is confirmed. Tap/click on the photo → «➕ عيب ما لقطتو» flow: a small type picker (Arabic types) → adds a finding `{kind:'local', source:'inspector', verdict:'added', confidence:1, level:'red'}` at that point.
5. **Decision bar** (sticky bottom): «✅ سليمة» / «🔧 تصليح» / «❌ مرفوضة» then «💾 حفظ» (disabled until a decision; shows a spinner and then «✓ انحفظ»), and «📷 قطعة جديدة» to return to the camera.
6. **History strip**: last 12 inspections (thumbnail from `photo_path` public URL, decision emoji, order, time). Click → read-only view of that inspection with its saved findings.

Saving (app.js):
- Insert the inspection first (station, inspector, order_number, model_code, garment, side, width, height, garment_box, result = the full pipeline result minus nothing, n_red, n_amber, decision, duration_ms, input_tokens, output_tokens) → id.
- Upload `YYYY-MM-DD/<id>/photo.jpg` (original blob as captured; if it is > 12 MB upload `img.blob({full, quality 0.85})`), `annotated.jpg` (render the preview + circles on a canvas, 1600 px), and `crop-<n>.jpg` per finding; then `updateInspection(id, {photo_path, annotated_path})`.
- Insert findings rows (kind, source, type, x, y, confidence, level, severity, why, crop_path, verdict confirmed|rejected|added|null, verdict_by = inspector, verdict_at, worker_name, stage).
- For every finding with a verdict insert a `vision_examples` row: label `defect` for confirmed/added, `not_defect` for rejected, with the crop path and model_code. (This is the learning loop; later inspections will read them.)
- Never block the UI on uploads; show per-step status; on failure keep the data in memory and offer «🔁 حاول الحفظ مرة تانية».

Type labels (Arabic): hole خرم · snag سحبة · stain بقعة · loose_thread خيط طالع · stitching درزة · puckering تكرمش · unfinished_edge حافة مش مخلّصة · asymmetry فرق بين الجهتين · length طول مختلف · print طباعة · missing_part قطعة ناقصة · other شي تاني.
Decision labels: pass سليمة · repair تصليح · reject مرفوضة.

Pipeline call (exact):
```js
import { inspect } from '../shared/pipeline.js'
import * as samParser from './vendor/meta-sam-parser/index.js'
const res = await inspect(img, { api: wrappedApi, samParser, garment: order.garment, onProgress, concurrency: 6, signal: controller.signal })
// After the garment is found the pipeline runs two branches concurrently (local: tiles → verify · global: silhouette → parts/mirror → global),
// so progress events interleave; onProgress('stage_done', {stage, ms}) fires after each stage. With `signal` aborted, inspect() rejects
// with an Error whose name is 'AbortError' (treat as cancel, not failure).
// res = { width, height, garmentBox, hasMask, tiles, candidates, verified, findings:[{kind, source, type, x, y, confidence, level, severity, why, window?, unsure?, hits?}], parts, usage:{input_tokens, output_tokens, calls, sam_calls}, timings:{garment, tiles, verify, silhouette, parts, global, total} }
```
Cost line to show after a run: `~$` = `(input_tokens*1.25 + output_tokens*4.25)/1e6 + 0.0025*sam_calls`, and `timings.total/1000` s.

Dev flow: `node dev/serve.mjs` → open `http://localhost:8787/station/`. Desktop testing uses the file button with `dev/photos/*.jpg` (gitignored) — the whole pipeline must run in the browser exactly as on the tablet.
