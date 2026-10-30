// SOLANG Vision QC — station/api.js
// Two tiny zero-dependency clients (browser and Node 24 share the global fetch):
//   makeApi(cfg) → { responses(body) }   Meta Model API through the proxy (dev server or Cloudflare Worker)
//   makeDb(cfg)  → Supabase REST + Storage for the DEMO project (publishable key only; the key can never DELETE storage)
// Contract: station/CONTRACTS.md §2. Config shape: station/config.example.js.

const RETRY_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAY_MS = 1500

function isSignal(s) { return typeof AbortSignal !== 'undefined' && s instanceof AbortSignal }

function abortError(signal) {
  if (signal && signal.reason) return signal.reason
  return new DOMException('The operation was aborted.', 'AbortError')
}

// setTimeout that wakes up early when the caller cancels (so a cancel during the retry pause is instant)
function sleep(ms, signal) {
  if (signal && signal.aborted) return Promise.resolve()      // already cancelled: do not wait at all
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve() }
    const t = setTimeout(done, ms)
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Meta Model API client (via proxy)
// ---------------------------------------------------------------------------------------------------------------
export function makeApi(cfg) {
  const base = String(cfg.PROXY_URL || '').replace(/\/+$/, '')   // '' → same origin ('/v1/responses')
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.STATION_TOKEN) headers['X-Station-Token'] = cfg.STATION_TOKEN

  async function once(json, signal) {
    let r
    try {
      r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: json, signal })
    } catch (e) {
      if (signal && signal.aborted) throw e                 // cancelled by the caller: never retried
      const err = new Error('network error: ' + ((e && e.message) || e))
      err.network = true; err.status = 0; err.cause = e
      throw err
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      const err = new Error('HTTP ' + r.status + ' ' + text.slice(0, 200))
      err.status = r.status
      throw err
    }
    return r.json()
  }

  return {
    // body = the /v1/responses JSON; body.signal (AbortSignal) is stripped from the JSON and handed to fetch.
    // Retries ONCE after 1.5 s on 429 / 502 / 503 / 504 / network error; any other error is thrown as-is.
    async responses(body) {
      const { signal: rawSignal, ...payload } = body || {}
      const signal = isSignal(rawSignal) ? rawSignal : undefined
      const json = JSON.stringify(payload)
      try {
        return await once(json, signal)
      } catch (e) {
        if (!(e.network || RETRY_STATUS.has(e.status))) throw e
        if (e.status === 429 && /daily limit/i.test(e.message || '')) throw e   // the proxy's per-day cap: a retry only re-sends megabytes for the same answer
        await sleep(RETRY_DELAY_MS, signal)
        if (signal && signal.aborted) throw abortError(signal)
        return once(json, signal)
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Supabase client (REST + Storage) — every method is async and throws Error('<what> HTTP <status> <body>') on failure
// (network failures use status 0). Errors also carry `.status`.
// ---------------------------------------------------------------------------------------------------------------
export function makeDb(cfg) {
  const base = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '')
  const key = cfg.SUPABASE_KEY
  const bucket = cfg.BUCKET || 'vision-photos'
  const auth = { apikey: key, Authorization: 'Bearer ' + key }

  const encPath = p => String(p).split('/').map(encodeURIComponent).join('/')
  // URLSearchParams percent-encodes ',' ':' '=' — PostgREST decodes the query string, so filters like
  // `created_at=gte.2026-10-26T00:00:00.000Z` and `select=a,b` arrive intact.
  const restUrl = (table, params) => {
    const qs = params ? new URLSearchParams(params).toString() : ''
    return `${base}/rest/v1/${table}${qs ? '?' + qs : ''}`
  }
  const first = rows => (Array.isArray(rows) ? (rows[0] || null) : rows)
  const needId = (what, id) => { if (id === undefined || id === null || id === '') throw new Error(what + ': id is required') }

  // one round-trip. json=true → body is JSON-encoded; json=false → body sent raw (Blob upload)
  async function call(what, method, url, { body, prefer, headers, json = true } = {}) {
    const h = { ...auth, ...(headers || {}) }
    if (json) h['Content-Type'] = 'application/json'
    if (prefer) h.Prefer = prefer
    let r
    try {
      r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : (json ? JSON.stringify(body) : body) })
    } catch (e) {
      const err = new Error(`${what} HTTP 0 ${(e && e.message) || e}`)
      err.status = 0; err.cause = e
      throw err
    }
    const text = await r.text()
    if (!r.ok) {
      const err = new Error(`${what} HTTP ${r.status} ${text.slice(0, 300)}`)
      err.status = r.status
      throw err
    }
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  const db = {
    // reference_back_url arrived on Oct 29 (sql/reference-back.sql): until that column exists the list is read without it (front reference only)
    listOrders: async () => {
      const url = (back) => restUrl('demo_orders', { select: 'order_number,model_code,product,garment,color,line,reference_url' + (back ? ',reference_back_url' : ''), order: 'order_number.asc' })
      try { return await call('listOrders', 'GET', url(true)) }
      catch (e) { if (e.status === 400 && /reference_back_url/.test(e.message)) return call('listOrders', 'GET', url(false)); throw e }
    },

    // «➕ موديل جديد…» on the station: a demo order typed on the spot (the real list comes from the factory system)
    insertOrder: (row) => call('insertOrder', 'POST', restUrl('demo_orders'), { body: row, prefer: 'return=minimal' }),

    listWorkers: () => call('listWorkers', 'GET', restUrl('demo_workers', { select: 'id,name,line,stage', order: 'line.asc,id.asc' })),

    // → the inserted row (with id)
    insertInspection: async row => first(await call('insertInspection', 'POST', restUrl('vision_inspections'), {
      body: row, prefer: 'return=representation',
    })),

    // → the updated row, or null when no row has that id
    // the known-good reference photo of a product, one per side: demo_orders.reference_url (front) / reference_back_url (back) on every order
    // of that model_code (null clears it)
    setReference: async (modelCode, url, side = 'front') => {
      if (!modelCode) throw new Error('setReference: model_code required')
      const col = side === 'back' ? 'reference_back_url' : 'reference_url'
      return call('setReference', 'PATCH', restUrl('demo_orders', { model_code: 'eq.' + modelCode }), { body: { [col]: url || null }, prefer: 'return=minimal' })
    },
    updateInspection: async (id, patch) => {
      needId('updateInspection', id)
      return first(await call('updateInspection', 'PATCH', restUrl('vision_inspections', { id: 'eq.' + id }), {
        body: patch, prefer: 'return=representation',
      }))
    },

    // → inserted rows with ids, same order as given (Postgres returns VALUES rows in insert order). [] → [] without a request.
    insertFindings: async rows => (rows && rows.length
      ? call('insertFindings', 'POST', restUrl('vision_findings'), { body: rows, prefer: 'return=representation' })
      : []),

    updateFinding: async (id, patch) => {
      needId('updateFinding', id)
      return first(await call('updateFinding', 'PATCH', restUrl('vision_findings', { id: 'eq.' + id }), {
        body: patch, prefer: 'return=representation',
      }))
    },

    insertExamples: async rows => (rows && rows.length
      ? call('insertExamples', 'POST', restUrl('vision_examples'), { body: rows, prefer: 'return=representation' })
      : []),

    recentInspections: (limit = 12) => call('recentInspections', 'GET', restUrl('vision_inspections', {
      select: 'id,created_at,order_number,model_code,side,photo_path,annotated_path,n_red,n_amber,decision,inspector,width,height,garment_box,incomplete:result->incomplete,framing:result->framing,summary:result->summary',   // width/height/garment_box: the review screen draws the circles on the preview
      order: 'created_at.desc', limit: String(limit),
    })),

    findingsFor: inspectionId => {
      needId('findingsFor', inspectionId)
      return call('findingsFor', 'GET', restUrl('vision_findings', { select: '*', inspection_id: 'eq.' + inspectionId, order: 'id.asc' }))
    },

    examplesFor: (modelCode, limit = 12) => call('examplesFor', 'GET', restUrl('vision_examples', {
      select: '*', model_code: 'eq.' + modelCode, order: 'created_at.desc', limit: String(limit),
    })),

    // Counts since LOCAL midnight, 2 requests (contract allows ≤3):
    //   inspections = today's inspection rows · red = Σ n_red (red spots the camera flagged today)
    //   confirmed   = today's findings the inspector marked as a defect (verdict confirmed or added)
    //   rejected    = today's findings the inspector marked «مش عيب» (verdict rejected)
    //   decisions   = bonus {pass, repair, reject} per garment decision
    // Rows are fetched and counted in JS; PostgREST's default max-rows (1000) is far above one demo day.
    async todayStats() {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
      const since = 'gte.' + midnight.toISOString()
      const [insp, finds] = await Promise.all([
        call('todayStats', 'GET', restUrl('vision_inspections', { select: 'decision,n_red', created_at: since })),
        call('todayStats', 'GET', restUrl('vision_findings', { select: 'verdict', created_at: since, verdict: 'not.is.null' })),
      ])
      const out = { inspections: insp.length, red: 0, confirmed: 0, rejected: 0, decisions: { pass: 0, repair: 0, reject: 0 } }
      for (const r of insp) {
        out.red += Number(r.n_red) || 0
        if (Object.prototype.hasOwnProperty.call(out.decisions, r.decision)) out.decisions[r.decision]++
      }
      for (const f of finds) {
        if (f.verdict === 'confirmed' || f.verdict === 'added') out.confirmed++
        else if (f.verdict === 'rejected') out.rejected++
      }
      return out
    },

    // POST /storage/v1/object/<bucket>/<path> with x-upsert (re-saving the same path overwrites) → public URL.
    // Paths are URL-safe ASCII by contract (YYYY-MM-DD/<id>/photo.jpg); segments are encoded anyway.
    async uploadPhoto(path, blob, contentType = 'image/jpeg') {
      // no upsert: evidence photos are never overwritten (the bucket has no UPDATE policy). A 409 means this exact path
      // was already stored by an earlier attempt whose answer got lost — that is a success for the resumable save job.
      try {
        await call('uploadPhoto', 'POST', `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`, { body: blob, json: false, headers: { 'Content-Type': contentType } })
      } catch (e) { if (!(e.status === 409 || /KeyAlreadyExists|already exists|Duplicate/i.test(e.message || ''))) throw e }   // storage answers HTTP 400 with an inner 409
      return db.publicUrl(path)
    },

    publicUrl: path => `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encPath(path)}`,
  }
  return db
}
