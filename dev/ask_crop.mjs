// Ask Muse Spark about ONE magnified crop of a photo — to learn whether a missed defect is visible at all when magnified (before deciding
// if a new close-up pass is worth it). usage (from dev/): node ask_crop.mjs <photo> <x> <y> <w> <h> [--up 3] [--prompt seam|tile] [--out file.jpg]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PROMPTS } from '../shared/pipeline.js'
const require = createRequire(import.meta.url)
const sharp = require('./node/node_modules/sharp')
const KEY = fs.readFileSync(path.resolve('../meta_key.txt'), 'utf8').replace(/^﻿/, '').trim()
const [file, x, y, w, h] = process.argv.slice(2)
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const up = +arg('--up', 3), which = arg('--prompt', 'seam'), out = arg('--out', null)
const buf = await sharp(file).rotate().extract({ left: +x, top: +y, width: +w, height: +h }).resize(Math.round(+w * up), Math.round(+h * up), { kernel: 'lanczos3' }).jpeg({ quality: 90 }).toBuffer()
if (out) fs.writeFileSync(out, buf)
const SEAM = 'You are a strict garment quality inspector. This is a magnified close-up of part of a children\'s garment lying flat (a cuff, hem, collar or seam area). ' +
  'Look only at the construction: is there an open or unstitched section of a seam, skipped or broken stitches, a seam that has come undone, a raw edge, a cuff or band not fully attached, or thread ends coming out of a seam? ' +
  'Ignore folds, wrinkles, shadows and the fabric texture. Answer ONLY JSON: {"defects":[{"type":"stitching|unfinished_edge|loose_thread|hole|other","x":0-1000,"y":0-1000,"confidence":0-1,"why":"one sentence"}]} with coordinates on a 0-1000 grid of this image; if nothing, {"defects":[]}.'
const text = which === 'tile' ? PROMPTS.tileRecall : SEAM
const body = { model: 'muse-spark-1.3', input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: 'data:image/jpeg;base64,' + buf.toString('base64') }] }], reasoning: { effort: arg('--effort', 'low') } }
const t0 = Date.now()
const r = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const j = await r.json()
const txt = typeof j.output_text === 'string' ? j.output_text : (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ')
console.log(`${Math.round((Date.now() - t0) / 1000)} s · crop ${w}×${h} ×${up} · prompt ${which}\n${txt}`)
