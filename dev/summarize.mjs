// Print a compact summary of saved pipeline results (out/annotated/*.json) without calling the API again
import fs from 'node:fs'
import path from 'node:path'
const dir = process.argv[2] || './out/annotated'
const truth = {
  IMG_1286: 'orange: hole/snag near right shoulder (+ collar threads?)', IMG_1290: 'black: L/R seam asymmetry + white thread', IMG_1288: 'grey: tiny hole upper-left',
  IMG_1285: 'green: double seam at left hem corner', IMG_1292: 'cream: pink stain under the bow', IMG_1289: 'pink: CLEAN', IMG_1284: 'pink: left leg ~4cm longer',
}
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const n = f.replace('.json', '')
  const cost = (r.usage.input_tokens * 1.25 + r.usage.output_tokens * 4.25) / 1e6 + 0.0025 * (r.parts && r.parts.part ? 2 : 1)
  console.log(`\n${n} — truth: ${truth[n] || '?'}`)
  console.log(`  ${r.tiles} tiles · ${r.candidates.length} cand → ${r.findings.length} findings · ${(r.timings.total / 1000).toFixed(1)}s · in ${r.usage.input_tokens} out ${r.usage.output_tokens} · ~$${cost.toFixed(3)} · garment ${r.garmentBox ? r.garmentBox.concept + ' c=' + (r.garmentBox.c || 0).toFixed(2) : 'none'}`)
  r.findings.forEach((x, i) => console.log(`  ${i + 1}. [${x.level}] ${x.source}/${x.type} ${Math.round(x.confidence * 100)}% (${x.x},${x.y})${x.hits ? ' hits=' + x.hits : ''}${x.unsure ? ' unsure' : ''} — ${x.why}`))
  if (r.parts) console.log(`  parts: ${r.parts.part || '-'} boxes=${r.parts.boxes.length} lengthDiff=${r.parts.lengthDiffPct}% mirror=${r.parts.mirror ? (r.parts.mirror.different ? 'DIFFERENT ' : 'same ') + Math.round(r.parts.mirror.confidence * 100) + '%' : '-'}`)
  const rej = r.verified.filter(v => ['lint', 'texture'].includes(v.verdict))
  if (rej.length) console.log('  rejected: ' + rej.map(v => `${v.type}@(${v.x},${v.y}) ${v.verdict}`).join(' | '))
}
