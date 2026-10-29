// The product reference per SIDE (Oct 29): opts.references = [{ image, side }] — the global pass sends every reference image and the prompt
// says which side each one is; a single side-less opts.reference still works. The model API is mocked (SAM finds nothing, requireGarment:false
// keeps the run over the whole frame; Spark answers «no findings»). Run: node dev/tests/test_references.mjs
import { inspect } from '../../shared/pipeline.js'

let fail = 0
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fail++ }

const img = { width: 2000, height: 1500, jpeg: async () => 'x'.repeat(400) }
const refImg = (tag) => ({ width: 1200, height: 1600, jpeg: async () => tag.repeat(100) })
function mockApi() {
  const globals = []
  const api = { responses: async (b) => {
    if (b.model === 'sam-3.1') return { output_text: '<0f>0' }
    const parts = (b.input[0] && b.input[0].content) || []
    const text = parts.filter(p => p.type === 'input_text').map(p => p.text).join(' ')
    if (text.includes('senior garment quality inspector. The garment may lie')) globals.push({ text, images: parts.filter(p => p.type === 'input_image').length })
    return { output_text: '{"findings":[],"defects":[],"different":false}' }
  } }
  return { api, globals }
}
const run = async (opts) => { const m = mockApi(); const res = await inspect(img, { api: m.api, samParser: null, garment: 'hoodie', requireGarment: false, onProgress: () => {}, ...opts }); return { res, g: m.globals[0] } }

// 1) front + back
{
  const { res, g } = await run({ references: [{ image: refImg('f'), side: 'front' }, { image: refImg('b'), side: 'back' }] })
  check(!!g && g.images === 3, `global pass sent the garment + both references (${g && g.images} images)`)
  check(!!g && g.text.includes('image 2 its FRONT side, image 3 its BACK side') && g.text.includes('compare it with the matching reference side only'), 'the prompt names each side and asks for the matching one')
  check(JSON.stringify(res.references) === '["front","back"]', `result.references = ${JSON.stringify(res.references)}`)
}
// 2) back only: the inspected piece may be the front — prints must not be compared across sides
{
  const { res, g } = await run({ references: [{ image: refImg('b'), side: 'back' }] })
  check(!!g && g.images === 2 && g.text.includes('showing its BACK side') && g.text.includes('do not compare prints or decorations'), 'a single back reference: the prompt says so and guards the other side')
  check(JSON.stringify(res.references) === '["back"]', 'result.references = ["back"]')
}
// 3) older callers: a bare side-less opts.reference
{
  const { res, g } = await run({ reference: refImg('r') })
  check(!!g && g.images === 2 && g.text.includes('Image 2 is a KNOWN GOOD reference piece of the same model. Compare them.'), 'a side-less reference keeps the old wording')
  check(JSON.stringify(res.references) === '["any"]', 'result.references = ["any"]')
}
// 4) none, and a broken entry (no image) is ignored
{
  const { res, g } = await run({ references: [{ image: null, side: 'front' }, null] })
  check(!!g && g.images === 1 && g.text.includes('The image is a garment lying flat, top-down.'), 'no usable reference → the single-image wording')
  check(Array.isArray(res.references) && res.references.length === 0, 'result.references = []')
}

console.log(fail ? `\n${fail} check(s) failed` : '\nall reference checks passed')
process.exit(fail ? 1 : 0)
