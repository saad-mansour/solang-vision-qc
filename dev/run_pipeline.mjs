// Node harness: run the full pipeline on local photos with the Meta API directly (dev key from meta_key.txt — never committed)
// usage: node run_pipeline.mjs <photo.jpg> [--garment sweatshirt] [--ref reference.jpg] [--out dir] [--conc 6] [--bg empty-table.jpg] [--no-focus] [--no-require]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { inspect } from '../shared/pipeline.js'
import { foregroundGrid } from '../shared/focus.js'
const require = createRequire(import.meta.url)
const sharp = require('./node/node_modules/sharp')
const samParser = await import('./node/node_modules/@meta-sam/parser/dist/index.js')

const KEY = fs.readFileSync(path.resolve('../meta_key.txt'), 'utf8').replace(/^﻿/, '').trim()
const api = {
  async responses(body) {
    const r = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200))
    return r.json()
  },
}
async function adapter(file) {
  const buf = await sharp(file).rotate().jpeg({ quality: 95 }).toBuffer()   // normalized (EXIF applied) full-res
  const m2 = await sharp(buf).metadata()
  return {
    width: m2.width, height: m2.height, buffer: buf,
    async jpeg({ x, y, w, h, resize, mirror, keep, fill, quality }) {
      let s = sharp(buf).extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
      if (resize) s = s.resize(Math.round(resize.w), Math.round(resize.h), { kernel: 'lanczos3' })
      if (mirror) s = s.flop()
      if (typeof keep === 'function') {                                   // same contract as the browser adapter: pixels not kept → flat fill
        const { data, info } = await s.raw().toBuffer({ resolveWithObject: true })
        const f = Array.isArray(fill) ? fill : [128, 128, 128], sx = w / info.width, sy = h / info.height, ch = info.channels
        for (let py = 0; py < info.height; py++) {
          const Y = y + (py + 0.5) * sy
          for (let px = 0; px < info.width; px++) {
            const X = x + ((mirror ? info.width - 1 - px : px) + 0.5) * sx
            if (!keep(X, Y)) { const i = (py * info.width + px) * ch; data[i] = f[0]; data[i + 1] = f[1]; data[i + 2] = f[2] }
          }
        }
        return (await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).jpeg({ quality: Math.round((quality ?? 0.9) * 100) }).toBuffer()).toString('base64')
      }
      return (await s.jpeg({ quality: Math.round((quality ?? 0.9) * 100) }).toBuffer()).toString('base64')
    },
  }
}
function arg(name, def) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def }
const file = process.argv[2]
if (!file) { console.error('usage: node run_pipeline.mjs <photo> [--garment x] [--ref y] [--out dir]'); process.exit(1) }
const outDir = arg('--out', './out/annotated'); fs.mkdirSync(outDir, { recursive: true })
const img = await adapter(file)
const ref = arg('--ref', null) ? await adapter(arg('--ref')) : null
// --bg: a photo of the same table empty → foreground grid (only feeds the «clutter» warning)
let fg = null
if (arg('--bg', null)) {
  const gray = async (f) => { const { data, info } = await sharp(f).rotate().resize(256).greyscale().raw().toBuffer({ resolveWithObject: true }); return { data: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), w: info.width, h: info.height } }
  const [c, b] = await Promise.all([gray(file), gray(arg('--bg'))])
  if (c.w === b.w && c.h === b.h) fg = foregroundGrid(c.data, b.data, c.w, c.h, { W: img.width, H: img.height })
  else console.log('  ! --bg ignored: different frame size than the photo')
}
const t0 = Date.now()
const res = await inspect(img, { api, samParser, garment: arg('--garment', 'garment'), reference: ref, concurrency: +arg('--conc', 6) || 6, foreground: fg, tileSize: +arg('--tile', 1200) || 1200, overlap: +arg('--overlap', 200) || 200, tileEffort: arg('--tile-effort', 'low'), tilePrompt: process.argv.includes('--strict') ? 'strict' : 'recall', tilePasses: +arg('--passes', 1) || 1, decor: !process.argv.includes('--no-decor'), focus: process.argv.includes('--no-focus') ? 'off' : 'paint', requireGarment: !process.argv.includes('--no-require'), onProgress: (st, info) => { if (st === 'warn') console.log('  ! warn', JSON.stringify(info)) } })
const name = path.basename(file).replace(/\.[^.]+$/, '')
fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(res, null, 1))
// annotate: downscale to 1600 and draw circles (red ≥0.8, amber ≥0.5, blue = global/measurement)
const S = Math.min(1, 1600 / Math.max(img.width, img.height))
const ow = Math.round(img.width * S), oh = Math.round(img.height * S)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const circ = (x, y, color, label) => `<circle cx="${x * S}" cy="${y * S}" r="${Math.max(18, 80 * S)}" fill="none" stroke="${color}" stroke-width="5"/><text x="${x * S + 30}" y="${y * S - 20}" font-size="26" font-family="Arial" fill="${color}" stroke="#000" stroke-width="0.8">${esc(label)}</text>`
let svg = `<svg width="${ow}" height="${oh}" xmlns="http://www.w3.org/2000/svg">`
if (res.garmentBox) svg += `<rect x="${res.garmentBox.x * S}" y="${res.garmentBox.y * S}" width="${res.garmentBox.w * S}" height="${res.garmentBox.h * S}" fill="none" stroke="#00e5ff" stroke-width="3" stroke-dasharray="12,8"/>`
res.findings.forEach((f, i) => { svg += circ(f.x, f.y, f.kind === 'global' ? '#2d7bff' : (f.level === 'red' ? '#ff2d2d' : '#ffb300'), `${i + 1} ${f.type} ${Math.round(f.confidence * 100)}%`) })
svg += '</svg>'
await sharp(img.buffer).resize(ow, oh).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toFile(path.join(outDir, name + '_annotated.jpg'))
const cost = (res.usage.input_tokens * 1.25 + res.usage.output_tokens * 4.25) / 1e6 + 0.0025 * res.usage.sam_calls
console.log(`\n${name}: ${res.tiles} tiles · ${res.candidates.length} candidates → ${res.findings.length} findings · ${(Date.now() - t0) / 1000}s · tokens in ${res.usage.input_tokens} out ${res.usage.output_tokens} · ~$${cost.toFixed(3)}`)
console.log('  timings:', ['garment', 'tiles', 'verify', 'parts', 'global', 'total'].map(k => `${k} ${((res.timings[k] || 0) / 1000).toFixed(1)}s`).join(' | '))   // stages overlap after garment; total = wall-clock
console.log('  garment:', res.garmentBox ? `${res.garmentBox.concept} c=${res.garmentBox.c && res.garmentBox.c.toFixed(2)} box ${res.garmentBox.w}x${res.garmentBox.h} mask=${res.hasMask}` : (res.noGarment ? 'NOT FOUND — run stopped (noGarment)' : 'not found (whole image)'))
console.log('  focus:', res.focus ? `${res.focus.sent}/${res.focus.tiles} tiles sent (${res.focus.skipped} table tiles skipped) · ${res.focus.droppedOutside} candidates outside the garment dropped · painted=${res.focus.painted} · margin ${res.focus.marginPx} px` : 'off (no mask)', '· framing:', JSON.stringify(res.framing))
res.findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.level}] ${f.source}/${f.type} ${Math.round(f.confidence * 100)}% at (${f.x},${f.y})${f.hits ? ' hits=' + f.hits : ''}${f.unsure ? ' (unsure)' : ''} — ${f.why}`))
if (res.parts) console.log('  parts:', JSON.stringify({ part: res.parts.part, silhouette: res.parts.silhouette, mirror: res.parts.mirror && { different: res.parts.mirror.different, c: res.parts.mirror.confidence, votes: res.parts.mirror.votes } }))
if (res.decor) console.log('  decor:', JSON.stringify(res.decor))
console.log('  rejected:', res.verified.filter(v => ['lint', 'texture'].includes(v.verdict)).map(v => `${v.type}@(${v.x},${v.y}) ${v.verdict}${v.second ? '+' + v.second.verdict : ''}`).join(' | ') || 'none')
