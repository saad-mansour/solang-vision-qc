// Pure Node test of StillnessDetector (station/camera.js) with synthetic 64×48 frames. No DOM, no deps.
// run: node dev/tests/test_stillness.mjs   (exit code 1 on any failure)
import { StillnessDetector } from '../../station/camera.js'

const W = 64, H = 48, STEP = 100   // 10 fps synthetic sampling (the station samples at ~8 fps)
let seed = 12345
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }   // deterministic LCG
const noise = () => Math.floor(rnd() * 3) - 1                                                   // −1, 0, +1 per pixel

const sceneA = (x, y) => 40 + x * 2 + y      // a garment lying on the table (gentle gradient, 40–213)
const sceneB = (x, y) => 200 - x * 2 - y     // a different garment / position (27–200)
const BAR = 12                               // a bright "hand" bar 12 px wide
function frame(scene, barX = -1) {
  const g = new Uint8ClampedArray(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = barX >= 0 && x >= barX && x < barX + BAR ? 255 : scene(x, y) + noise()
  return g
}
const burstFrame = scene => i => frame(scene, (i * BAR) % (W - BAR))   // bar jumps one width per frame

const det = new StillnessDetector()   // contract defaults
const stills = []
det.onStill = info => stills.push({ ...info, stateInCallback: det.state })
let t = 0
function run(n, mk) { const states = []; for (let i = 0; i < n; i++) { t += STEP; states.push(det.feed(mk(i), W, H, t).state) } return states }
const tally = st => JSON.stringify(st.reduce((m, v) => (m[v] = (m[v] || 0) + 1, m), {}))
const nOf = (st, v) => st.filter(s => s === v).length

let failed = 0
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${ok ? '' : '   [' + detail + ']'}`); if (!ok) failed++ }

// 1. a static scene (noise ±1) never triggers anything
let st = run(10, () => frame(sceneA))
check('1  static scene: no capture, stays idle', stills.length === 0 && st.every(s => s === 'idle'), tally(st))

// 2. 600 ms moving bar, then still for 1300 ms → exactly one 'still'
const burst = run(6, burstFrame(sceneA))
st = run(13, () => frame(sceneA))
check('2a burst of motion is seen as moving', burst.includes('moving') && !burst.includes('still'), tally(burst))
check('2b exactly one onStill within 1.3 s of stillness', stills.length === 1 && nOf(st, 'still') === 1, `onStill=${stills.length} ${tally(st)}`)
check('2c moving → settling → still → cooldown in that order',
  st.indexOf('settling') >= 0 && st.indexOf('settling') < st.indexOf('still') && st.indexOf('still') < st.length - 1 ? st[st.indexOf('still') + 1] === 'cooldown' : st[st.length - 1] === 'still', st.join(','))
const f0 = stills[0]
check('2d frameInfo: gray copy w×h, score, time, state still inside callback',
  !!f0 && f0.w === W && f0.h === H && f0.gray instanceof Uint8ClampedArray && f0.gray.length === W * H && f0.score < 2.5 && f0.at === t && f0.stateInCallback === 'still',
  f0 ? JSON.stringify({ w: f0.w, h: f0.h, len: f0.gray && f0.gray.length, score: f0.score, at: f0.at, t }) : 'no frameInfo')

// 3. 10 s more of the same still scene → nothing new; cooldown runs out → idle
st = run(100, () => frame(sceneA))
check('3a ten more seconds still: no second capture, no same', stills.length === 1 && !st.includes('still') && !st.includes('same'), `onStill=${stills.length} ${tally(st)}`)
check('3b cooldown first, then idle', st[0] === 'cooldown' && st.includes('idle') && det.state === 'idle', `first=${st[0]} last=${det.state}`)

// 4. a new burst, then still with a DIFFERENT scene → second capture
run(6, burstFrame(sceneB))
st = run(13, () => frame(sceneB))
check('4  different garment after a burst: second capture', stills.length === 2 && nOf(st, 'still') === 1, `onStill=${stills.length} ${tally(st)}`)
run(40, () => frame(sceneB))   // let the 4 s cooldown run out

// 5. a third burst, then still with the SAME scene as capture 2 → state 'same', no capture
run(6, burstFrame(sceneB))
st = run(13, () => frame(sceneB))
check('5a same garment re-settles: state same exactly once, no onStill', stills.length === 2 && nOf(st, 'same') === 1 && !st.includes('still'), `onStill=${stills.length} ${tally(st)}`)
check('5b same is followed by cooldown', st[st.indexOf('same') + 1] === 'cooldown' || st.indexOf('same') === st.length - 1, st.join(','))

// 6. the garment is swapped between two samples (no hand seen) → counts as motion → capture
run(40, () => frame(sceneB))
st = run(14, () => frame(sceneA))
check('6  sudden scene swap counts as a burst: third capture', stills.length === 3 && nOf(st, 'still') === 1, `onStill=${stills.length} ${tally(st)}`)

// 7. reset() clears everything; markScene() blocks the next auto-capture of that scene
det.reset()
check('7a reset: idle, lastScore 0', det.state === 'idle' && det.lastScore === 0, `${det.state} ${det.lastScore}`)
st = run(5, () => frame(sceneB))
check('7b after reset static frames stay idle', stills.length === 3 && st.every(s => s === 'idle'), tally(st))
det.markScene(frame(sceneB))
run(6, burstFrame(sceneB)); st = run(13, () => frame(sceneB))
check('7c markScene: hand-photographed scene is not auto-captured', stills.length === 3 && nOf(st, 'same') === 1, `onStill=${stills.length} ${tally(st)}`)

// 8. score reporting and tolerance to a sample-size change
const r = det.feed(frame(sceneB, 0), W, H, (t += STEP))
check('8a score > moveThreshold on a bar frame, lastScore mirrors it, state moving', r.score > 8 && det.lastScore === r.score && r.state === 'moving', JSON.stringify(r))
const r2 = det.feed(new Uint8ClampedArray(32 * 24), 32, 24, (t += STEP))
check('8b a different sample size does not throw and scores 0', r2.score === 0, JSON.stringify(r2))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
