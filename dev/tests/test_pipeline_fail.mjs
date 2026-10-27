// The pipeline when the model API is down: every call rejects. The run must NOT read as «no garment» (that is a placement message
// for the operator) — it continues over the whole frame, emits 'garment' / 'tile' / 'global' warnings and returns zero findings,
// so the station flags the piece as incomplete and still hands it to the review screen. Run: node dev/tests/test_pipeline_fail.mjs
import { inspect } from '../../shared/pipeline.js'

let fail = 0
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fail++ }

const img = { width: 2000, height: 1500, jpeg: async () => 'x'.repeat(400) }
const api = { responses: async () => { throw Object.assign(new Error('HTTP 503 proxy down'), { status: 503 }) } }
const events = []
const res = await inspect(img, { api, samParser: null, garment: 'sweatshirt', concurrency: 4, onProgress: (st, info) => events.push([st, info]) })
const warns = events.filter(([s]) => s === 'warn').map(([, i]) => i.stage)
check(!res.noGarment, 'a failed SAM call is not reported as noGarment')
check(warns.includes('garment'), `a 'garment' warning was emitted (warn stages: ${[...new Set(warns)].join(', ')})`)
check(warns.includes('tile') && warns.includes('global'), 'the run went on: tile and global stages were attempted and warned')
check(res.findings.length === 0 && res.tiles > 0, `zero findings, ${res.tiles} tiles attempted over the whole frame`)
check(res.framing && res.framing.cut.length === 0 && res.framing.small === false, 'framing is neutral without a box')
check(res.focus === null, 'no focus grid without a mask')
check(typeof res.timings.total === 'number' && res.timings.total >= 0, 'timings are filled')

// and the genuine case: SAM answers but finds nothing → noGarment, no further calls
let calls = 0
const apiEmpty = { responses: async (b) => { calls++; if (b.model === 'sam-3.1') return { output_text: '<0f>0' }; throw new Error('Spark must not be called') } }
const r2 = await inspect(img, { api: apiEmpty, samParser: null, garment: 'sweatshirt', onProgress: () => {} })
check(r2.noGarment === true && r2.findings.length === 0, 'SAM finds nothing → noGarment')
check(calls <= 4, `only SAM calls were made (${calls})`)
const r3 = await inspect(img, { api: apiEmpty, samParser: null, garment: 'sweatshirt', requireGarment: false, onProgress: () => {} })
check(!r3.noGarment, 'requireGarment:false keeps the old whole-frame behaviour')

console.log(fail ? `\n${fail} check(s) failed` : '\nall pipeline-failure checks passed')
process.exit(fail ? 1 : 0)
