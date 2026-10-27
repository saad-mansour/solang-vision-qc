// SOLANG Vision QC — first-visit card. Stage 'lang': the page is Arabic by default, pick a language (English / العربية).
// Stage 'how': three steps for trying the demo with a single phone, in the chosen language. Shown once (localStorage vqc_welcomed),
// again with ?welcome=1 or the «?» button in the top bar. showWelcome() resolves when the visitor taps Start; picking a different
// language reloads the page instead (station/i18n.js), so the caller never continues in the wrong language.
import { LANG, setLang } from './i18n.js'

const WELCOMED = 'vqc_welcomed'
const lsGet = (k) => { try { return localStorage.getItem(k) } catch (e) { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } }
export const welcomed = () => lsGet(WELCOMED) === '1'

const TEXT = {
  en: {
    intro: 'Live demo of an AI final-quality check for garments, built inside a children\'s-wear factory in Cairo. The page is in Arabic by default — pick a language:',
    howTitle: 'How to try it — one phone is enough',
    steps: [
      'Allow the camera when the browser asks. The back camera works best.',
      'Lay one garment flat on a plain table and fill the frame with it. Hold the phone still: it shoots by itself when the scene is steady (or tap «📸 Inspect now»). No camera? Use «📁 Photo from device».',
      'In 15–25 seconds you get numbered circles: red = likely defect, amber = worth a look, blue = overall (symmetry, length). Tap ✓ or ✗ on each card, pick a decision and save — your verdicts become reference examples for the next inspection of the same product.',
    ],
    notes: [
      'In the factory this runs on two devices: a phone fixed above the table and the inspector\'s tablet (see the README).',
      'Every inspection calls Meta\'s API on the developer\'s account — please keep tries reasonable.',
    ],
    start: 'Start', other: 'العربية بدلاً من ذلك', lang: 'Language',
  },
  ar: {
    intro: 'ديمو حي لفحص الجودة النهائي للملابس بالذكاء الاصطناعي، مبني جوّا مصنع ملابس أطفال بالقاهرة. الصفحة بالعربي افتراضياً — اختار اللغة:',
    howTitle: 'كيف تجرّب — موبايل واحد بيكفي',
    steps: [
      'اسمح للكاميرا لما يسألك المتصفح. الكاميرا الخلفية أفضل.',
      'افرد قطعة وحدة على طاولة سادة وعبّي الكادر فيها. ثبّت الموبايل: بيصوّر لحالو لما يهدا المشهد (أو اكبس «📸 افحص هلق»). ما في كاميرا؟ استعمل «📁 صورة من الجهاز».',
      'خلال 15–25 ثانية بتطلع دواير مرقّمة: أحمر = عيب مرجّح، برتقالي = بدها نظرة، أزرق = عام (تناظر، طول). اكبس ✓ أو ✗ على كل كرت، اختار القرار واحفظ — أحكامك بتصير أمثلة مرجعية للفحص الجاي من نفس الموديل.',
    ],
    notes: [
      'بالمصنع بيشتغل على جهازين: موبايل مثبّت فوق الطاولة وتابلت المفتشة (التفاصيل بالـREADME).',
      'كل فحص بيكلّم API تبع Meta على حساب المطوّر — خلّي التجارب معقولة.',
    ],
    start: 'يلا نبلّش', other: 'English instead', lang: 'اللغة',
  },
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const btn = (text, cls, fn) => { const b = el('button', 'btn ' + (cls || ''), text); b.type = 'button'; b.addEventListener('click', fn); return b }

// stage: 'lang' | 'how'. Resolves when the card is dismissed with Start (never when the language changes: the page reloads).
export function showWelcome(stage) {
  const root = document.getElementById('welcome'); if (!root) return Promise.resolve()
  return new Promise((resolve) => {
    const card = root.querySelector('.wcard'), body = root.querySelector('#wBody')
    const render = (st) => {
      while (body.firstChild) body.removeChild(body.firstChild)
      if (st === 'lang') {
        body.dir = 'ltr'
        body.appendChild(el('p', 'wtext', TEXT.en.intro))
        const arP = el('p', 'wtext'); arP.dir = 'rtl'; arP.textContent = TEXT.ar.intro; body.appendChild(arP)
        const row = el('div', 'wrow')
        row.appendChild(btn('English', 'primary big', () => choose('en')))
        const arB = btn('العربية', 'primary big', () => choose('ar')); arB.dir = 'rtl'; row.appendChild(arB)
        body.appendChild(row)
        return
      }
      const T = TEXT[LANG] || TEXT.ar
      body.dir = LANG === 'en' ? 'ltr' : 'rtl'
      body.appendChild(el('h2', 'wtitle', T.howTitle))
      const ol = el('ol', 'wsteps'); T.steps.forEach((s) => ol.appendChild(el('li', null, s))); body.appendChild(ol)
      T.notes.forEach((n) => body.appendChild(el('p', 'wnote', n)))
      const row = el('div', 'wrow')
      row.appendChild(btn(T.start, 'primary big', () => { lsSet(WELCOMED, '1'); root.hidden = true; resolve() }))
      row.appendChild(btn(T.other, 'small', () => choose(LANG === 'en' ? 'ar' : 'en')))
      body.appendChild(row)
    }
    const choose = (l) => { if (l === LANG) { try { localStorage.setItem('vqc_lang', l) } catch (e) { /* ignore */ } render('how'); card.scrollTop = 0 } else setLang(l) }   // same language: no reload needed
    render(stage === 'lang' ? 'lang' : 'how')
    root.hidden = false
  })
}
