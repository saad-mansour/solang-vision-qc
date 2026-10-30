// The numbers behind the demo, straight from the demo database (read-only): pieces, findings, the inspector's verdicts per layer and per
// type, timings and cost. Prints Markdown for the README. Keys come from station/config.js (the publishable key of the DEMO project).
// usage: node dev/accuracy.mjs [--since 2026-10-29] [--ids 1,2,4] [--station final-qc-1]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cfg = fs.readFileSync(path.join(here, '../station/config.js'), 'utf8')
const URL_ = (cfg.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1], KEY = (cfg.match(/SUPABASE_KEY:\s*'([^']+)'/) || [])[1]
if (!URL_ || !KEY) { console.error('station/config.js: SUPABASE_URL / SUPABASE_KEY not found'); process.exit(1) }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const since = arg('--since', null), ids = arg('--ids', null), station = arg('--station', null)

async function get(table, params) {
  const u = new URL(`${URL_}/rest/v1/${table}`); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
  const r = await fetch(u, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } })
  if (!r.ok) throw new Error(`${table} HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
const ip = { select: 'id,created_at,order_number,model_code,side,decision,n_red,n_amber,duration_ms,input_tokens,output_tokens,result->summary,result->references', order: 'id.asc' }
if (since) ip.created_at = 'gte.' + since
if (ids) ip.id = 'in.(' + ids + ')'
if (station) ip.station = 'eq.' + station
const insp = await get('vision_inspections', ip)
if (!insp.length) { console.log('no inspections match'); process.exit(0) }
const fnd = await get('vision_findings', { select: 'id,inspection_id,type,level,source,confidence,verdict,x,y', inspection_id: 'in.(' + insp.map(i => i.id).join(',') + ')', order: 'id.asc' })

const n = insp.length, byDec = {}, bySide = {}
insp.forEach(i => { byDec[i.decision || 'none'] = (byDec[i.decision || 'none'] || 0) + 1; bySide[i.side || '?'] = (bySide[i.side || '?'] || 0) + 1 })
const v = f => f.verdict === 'confirmed' ? 'confirmed' : f.verdict === 'rejected' ? 'rejected' : 'undecided'
const tally = (key) => { const m = {}; fnd.forEach(f => { const k = key(f); m[k] = m[k] || { confirmed: 0, rejected: 0, undecided: 0, total: 0 }; m[k][v(f)]++; m[k].total++ }); return m }
const byLayer = tally(f => f.source || '?'), byType = tally(f => f.type || '?'), byLevel = tally(f => f.level || '?')
const all = { confirmed: fnd.filter(f => v(f) === 'confirmed').length, rejected: fnd.filter(f => v(f) === 'rejected').length, undecided: fnd.filter(f => v(f) === 'undecided').length }
const sums = insp.reduce((a, i) => { const s = i.summary || {}; a.cand += s.candidates || 0; a.conf += s.confirmed || 0; a.uns += s.unsure || 0; a.drop += s.dropped || 0; a.decor += s.decor || 0; a.glob += s.global || 0; a.ms += i.duration_ms || 0; a.tin += i.input_tokens || 0; a.tout += i.output_tokens || 0; return a }, { cand: 0, conf: 0, uns: 0, drop: 0, decor: 0, glob: 0, ms: 0, tin: 0, tout: 0 })
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–'
const cost = (sums.tin * 1.25 + sums.tout * 4.25) / 1e6   // Spark tokens; SAM calls (~$0.0025 each) are not stored per row

const row = (k, o) => `| ${k} | ${o.total} | ${o.confirmed} | ${o.rejected} | ${o.undecided} | ${pct(o.confirmed, o.confirmed + o.rejected)} |`
const hdr = (first) => `| ${first} | findings | ✓ confirmed | ✗ rejected | undecided | precision* |\n|---|---|---|---|---|---|`
console.log(`## Inspections ${since ? 'since ' + since : ''}${ids ? ' ids ' + ids : ''}\n`)
console.log(`- Pieces inspected: **${n}** (${Object.entries(bySide).map(([k, c]) => `${k} ${c}`).join(', ')}) — decisions: ${Object.entries(byDec).map(([k, c]) => `${k} ${c}`).join(', ')}`)
console.log(`- Candidates raised by the tiles: **${sums.cand}** → confirmed by the magnified check **${sums.conf}**, flagged unsure ${sums.uns}, dropped **${sums.drop}** (${pct(sums.drop, sums.cand)}); design close-ups ${sums.decor}; global ${sums.glob}`)
console.log(`- Findings shown to the inspector: **${fnd.length}** — she confirmed **${all.confirmed}**, rejected **${all.rejected}**, left ${all.undecided} undecided → precision on judged spots **${pct(all.confirmed, all.confirmed + all.rejected)}**`)
console.log(`- Time per piece: mean **${Math.round(sums.ms / n / 1000)} s** (min ${Math.round(Math.min(...insp.map(i => i.duration_ms || 0)) / 1000)}, max ${Math.round(Math.max(...insp.map(i => i.duration_ms || 0)) / 1000)}) · Spark tokens in ${sums.tin} / out ${sums.tout} ≈ $${cost.toFixed(2)} (≈ $${(cost / n).toFixed(3)} per piece, SAM calls extra)\n`)
console.log(hdr('layer')); Object.entries(byLayer).forEach(([k, o]) => console.log(row(k, o))); console.log()
console.log(hdr('type')); Object.entries(byType).sort((a, b) => b[1].total - a[1].total).forEach(([k, o]) => console.log(row(k, o))); console.log()
console.log(hdr('level')); Object.entries(byLevel).forEach(([k, o]) => console.log(row(k, o))); console.log()
console.log('\\* precision = confirmed / (confirmed + rejected), on the spots the inspector judged.\n')
console.log('| # | order | side | decision | red | amber | s | candidates → confirmed / dropped | refs |\n|---|---|---|---|---|---|---|---|---|')
insp.forEach(i => { const s = i.summary || {}; console.log(`| ${i.id} | ${i.order_number || ''} | ${i.side || ''} | ${i.decision || ''} | ${i.n_red ?? ''} | ${i.n_amber ?? ''} | ${Math.round((i.duration_ms || 0) / 1000)} | ${s.candidates ?? '–'} → ${s.confirmed ?? '–'} / ${s.dropped ?? '–'} | ${(i.references || []).join('+') || '–'} |`) })
