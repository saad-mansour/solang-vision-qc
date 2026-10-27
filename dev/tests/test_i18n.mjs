// UI language layer (station/i18n.js): t() semantics, and the source files stay in sync with the dictionary —
// every Arabic key used in the code / index.html has an English value, no Arabic literal is left outside t(), no dead keys.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { t, EN, LANG } from '../../station/i18n.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
let fails = 0
const ok = (cond, what) => { if (!cond) { fails++; console.log('FAIL', what) } else console.log('ok  ', what) }

// 1. t() in Node (no window): Arabic, placeholders filled, plural picks, unknown placeholder left alone
ok(LANG === 'ar', 'default language is ar without a browser')
ok(t('خلص — {n} نقطة للمراجعة', { n: 3 }) === 'خلص — 3 نقطة للمراجعة', 't() fills {n}')
ok(EN['خلص — {n} نقطة للمراجعة'].includes('{n|spot|spots}'), 'English value carries a plural form')
const plural = (s, vars) => s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, k, one, many) => (Number(vars[k]) === 1 ? one : many)).replace(/\{(\w+)\}/g, (m, k) => String(vars[k]))
ok(plural(EN['خلص — {n} نقطة للمراجعة'], { n: 1 }) === 'Done — 1 spot to review' && plural(EN['خلص — {n} نقطة للمراجعة'], { n: 2 }) === 'Done — 2 spots to review', 'plural form resolves (1 / many)')
ok(t('x {a} {b}', { a: 1 }) === 'x 1 {b}', 'missing placeholder stays visible')

// 2. tokenizer over the station sources: Arabic literals must be inside t(...); collect the keys used
const AR = /[؀-ۿ]/
function scan(src) {
  const keys = [], bare = []; let i = 0, line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (src.startsWith('//', i)) { let j = src.indexOf('\n', i); if (j < 0) j = n; i = j; continue }
    if (src.startsWith('/*', i)) { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; line += (src.slice(i, j).match(/\n/g) || []).length; i = j; continue }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      const lit = src.slice(i, j + 1), inner = lit.slice(1, -1)
      if (AR.test(inner)) {
        const before = src.slice(Math.max(0, i - 3), i)
        if (c !== '`' && /(^|[^\w$.])t\($/.test(before)) keys.push(inner.replace(/\\'/g, '\''))
        else bare.push({ line, lit: lit.slice(0, 60) })
      }
      line += (lit.match(/\n/g) || []).length; i = j + 1; continue
    }
    if (c === '/' && /[=(,:!&|?{;}\s]\s*$/.test(src.slice(Math.max(0, i - 3), i) || ' ')) {
      const m = /^\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/.exec(src.slice(i, i + 300))
      if (m) { i += m[0].length; continue }                      // regexes may contain Arabic (the «unsure» test)
    }
    i++
  }
  return { keys, bare }
}
const used = new Set()
for (const f of ['station/app.js', 'station/live.js', 'station/camera.js']) {
  const { keys, bare } = scan(read(f))
  keys.forEach((k) => used.add(k))
  ok(bare.length === 0, `${f}: no Arabic literal outside t() ${bare.length ? JSON.stringify(bare.slice(0, 5)) : ''}`)
}
const missing = [...used].filter((k) => !(k in EN))
ok(missing.length === 0, `every t() key has an English value ${missing.length ? JSON.stringify(missing.slice(0, 8)) : ''}`)

// 3. index.html: Arabic text nodes and placeholder / aria-label / title attributes are keys
const html = read('station/index.html')
const texts = [...html.matchAll(/>([^<>]*)</g)].map((m) => m[1].trim()).filter((s) => s && AR.test(s))
const attrs = [...html.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)].map((m) => m[1]).filter((s) => AR.test(s))
const htmlMissing = [...new Set([...texts, ...attrs])].filter((k) => !(k in EN))
ok(htmlMissing.length === 0, `index.html Arabic text is translatable ${htmlMissing.length ? JSON.stringify(htmlMissing) : ''}`)
texts.forEach((k) => used.add(k)); attrs.forEach((k) => used.add(k)); used.add('English')

// 4. no dead keys, placeholders of the English value exist in the key
const dead = Object.keys(EN).filter((k) => !used.has(k))
ok(dead.length === 0, `no unused dictionary keys ${dead.length ? JSON.stringify(dead.slice(0, 8)) : ''}`)
const badPh = Object.entries(EN).filter(([k, v]) => [...v.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].some((m) => !k.includes('{' + m[1] + '}')))
ok(badPh.length === 0, `English placeholders match the key ${badPh.length ? JSON.stringify(badPh.slice(0, 5)) : ''}`)
const arabicValues = Object.entries(EN).filter(([k, v]) => k !== 'English' && AR.test(v))
ok(arabicValues.length === 0, `English values contain no Arabic ${arabicValues.length ? JSON.stringify(arabicValues.slice(0, 5)) : ''}`)

// 5. the pipeline writes its own «why» text in the requested language
const pipe = read('shared/pipeline.js')
ok(/const WT = WHY\[opts && opts\.lang === 'en'/.test(pipe) && /WT\.unsure/.test(pipe) && /WT\.approx/.test(pipe), 'pipeline why-text follows opts.lang')
const appSrc = read('station/app.js')
ok(/lang: LANG/.test(appSrc), 'the station passes its language to the pipeline')
ok(/\^Not sure\|two tiles/.test(appSrc), 'the review screen recognises English «unsure» reasons')

console.log(fails ? `\n${fails} failing` : '\nall i18n checks passed')
process.exit(fails ? 1 : 0)
