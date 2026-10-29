// SOLANG Vision QC — UI language. The station is written in Arabic (the factory's language); this module adds English on top.
// Keys are the Arabic source strings themselves, so app.js stays readable and a missing translation falls back to Arabic.
//   LANG            'ar' | 'en' — ?lang=en|ar in the URL wins and is remembered (localStorage vqc_lang); otherwise the stored
//                   choice; otherwise 'ar'. Changing the language reloads the page (everything is rendered through t() once).
//   t(key, vars)    translation of an Arabic string; {name} placeholders are filled from vars, {name|one|many} picks by vars.name == 1
//   applyStatic()   translates the static text of index.html (text nodes, placeholder / aria-label / title) and sets <html lang dir>
//   langChosen()    true once a language was picked (first-visit card, station/welcome.js)
//   setLang(l)      stores the choice and reloads (without the ?lang parameter, so the stored choice rules from then on)
// Binding spec: station/CONTRACTS.md §6 (UI language).
const KEY = 'vqc_lang'
const hasWin = typeof window !== 'undefined' && typeof location !== 'undefined'
const lsGet = (k) => { try { return localStorage.getItem(k) } catch (e) { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } }
const urlLang = () => { if (!hasWin) return null; const p = new URLSearchParams(location.search).get('lang'); return p === 'en' || p === 'ar' ? p : null }
function pick() {
  const u = urlLang(); if (u) { lsSet(KEY, u); return u }
  return lsGet(KEY) === 'en' ? 'en' : 'ar'
}
export const LANG = pick()
export const isEn = () => LANG === 'en'
export const langChosen = () => !!urlLang() || lsGet(KEY) === 'en' || lsGet(KEY) === 'ar'
export function setLang(l) {
  if (l !== 'en' && l !== 'ar') return
  lsSet(KEY, l)
  if (!hasWin) return
  const url = new URL(location.href); url.searchParams.delete('lang'); location.replace(url.toString())
}

const missing = new Set()
export function t(key, vars) {
  let s = key
  if (LANG === 'en') {
    const e = EN[key]
    if (e == null) { if (!missing.has(key)) { missing.add(key); if (hasWin) console.warn('i18n: no English for', key) } } else s = e
  }
  if (vars) {
    s = s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, k, one, many) => (k in vars ? (Number(vars[k]) === 1 ? one : many) : m))
    s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  return s
}
export const missingKeys = () => [...missing]

// static text of index.html: exact (trimmed) matches only, whitespace around the text is kept
export function applyStatic(root) {
  if (!hasWin || typeof document === 'undefined') return
  document.documentElement.lang = LANG; document.documentElement.dir = LANG === 'en' ? 'ltr' : 'rtl'
  if (LANG !== 'en') return
  root = root || document.body
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []; let n
  while ((n = walker.nextNode())) nodes.push(n)
  for (const node of nodes) {
    const raw = node.nodeValue, key = raw.trim()
    if (!key || !(key in EN)) continue                                 // (the «English» button label is a key too)
    const lead = raw.slice(0, raw.indexOf(key)), tail = raw.slice(raw.indexOf(key) + key.length)
    node.nodeValue = lead + EN[key] + tail
  }
  for (const attr of ['placeholder', 'aria-label', 'title']) {
    root.querySelectorAll('[' + attr + ']').forEach((e) => { const v = e.getAttribute(attr); if (v && (v in EN)) e.setAttribute(attr, EN[v]) })
  }
}

// ── English ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const EN = {
  // defect types / decisions / sides / pill
  'خرم': 'hole', 'سحبة': 'snag', 'بقعة': 'stain', 'خيط طالع': 'loose thread', 'درزة': 'stitching', 'تكرمش': 'puckering',
  'حافة مش مخلّصة': 'unfinished edge', 'فرق بين الجهتين': 'left / right differ', 'طول مختلف': 'length differs', 'طباعة': 'print',
  'قطعة ناقصة': 'missing part', 'شي تاني': 'other',
  'سليمة': 'pass', 'تصليح': 'repair', 'مرفوضة': 'rejected',
  'وجه': 'Front', 'ضهر': 'Back',
  'جاهزة': 'Ready', 'في حركة': 'Moving', 'ثابتة…': 'Settling…', '📸 لقطة!': '📸 Shot!', 'نفس القطعة': 'Same piece',
  'خطأ غير معروف': 'unknown error',

  // static page (index.html)
  'الطلبية': 'Order', 'الجهة': 'Side', 'اسم المفتشة': 'Inspector name',
  'لقطة تلقائية': 'Auto shoot', '📸 افحص هلق': '📸 Inspect now', '📁 صورة من الجهاز': '📁 Photo from device', '🔄 كاميرا': '🔄 Flip camera',
  '🧹 صوّر الطاولة فاضية': '🧹 Photograph the empty table',
  '⬅ رجوع للكاميرا': '⬅ Back to camera', '⬅ رجوع للمراجعة': '⬅ Back to review',
  '🔌 عم وصل…': '🔌 Connecting…', '📸 افحص القطعة يلي تحت الكاميرا': '📸 Inspect the piece under the camera',
  '📡 عم وصل بث الكاميرا…': '📡 Connecting to the camera feed…',
  'إلغاء': 'Cancel', 'صار خطأ بالفحص': 'The inspection hit an error',
  'كبس عالصورة لتعلّم عيب ما لقطتو الكاميرا': 'Tap the photo to mark a defect the camera missed',
  'النقاط': 'Spots', '✅ سليمة': '✅ Pass', '🔧 تصليح': '🔧 Repair', '❌ مرفوضة': '❌ Reject',
  '💾 حفظ': '💾 Save', '📷 قطعة جديدة': '📷 New piece', '🔁 حاول الحفظ مرة تانية': '🔁 Retry the save',
  'آخر الفحوصات': 'Recent inspections', '➕ عيب ما لقطتو — شو نوعو؟': '➕ Missed defect — what kind?', 'رجوع': 'Back',
  'English': 'عربي', 'كيف أجرّب؟': 'How to try it',

  // init / top bar
  'اسم الجهاز (متل: كاميرا 1)': 'Device name (e.g. Camera 1)',
  'ملف الإعدادات station/config.js مش موجود — انسخ config.example.js وعبّيه': 'station/config.js is missing — copy config.example.js and fill it in',
  'ما قدرت جهّز الاتصال بالموديل: ': 'Could not set up the model connection: ',
  'ما قدرت جهّز الاتصال بالقاعدة: ': 'Could not set up the database connection: ',
  'ما قدرت جيب الطلبيات: ': 'Could not load the orders: ', 'ما قدرت جيب العمال: ': 'Could not load the workers: ',
  'يدوي': 'manual', 'ملف': 'file', 'تلقائي': 'auto', 'من شاشة المراجعة': 'from the review screen',
  'ما في طلبيات': 'No orders',
  'اليوم: {n} فحص · {r} أحمر · {c} مؤكد': 'Today: {n} {n|inspection|inspections} · {r} red · {c} confirmed',

  // camera
  'الكاميرا ما اشتغلت على هالجهاز — استعمل «📁 صورة من الجهاز». ({err})': 'The camera did not start on this device — use «📁 Photo from device». ({err})',
  'الكاميرا وقفت — ': 'The camera stopped — ', '🔄 عيد تشغيل الكاميرا': '🔄 Restart the camera',
  'الكاميرا وقفت — عيد تشغيلها': 'The camera stopped — restart it',
  'في فحص شغّال — استنّي يخلص': 'An inspection is running — wait for it to finish',
  'ما في كاميرا — استعمل «صورة من الجهاز»': 'No camera — use «Photo from device»',
  'ما قدرت آخد الصورة: ': 'Could not take the photo: ',

  // inspection run
  'الصورة فاضية': 'The image is empty', 'عم جهّز الصورة…': 'Preparing the photo…',
  'ما في إعدادات (config.js) — ما فيني كلّم الموديل': 'No settings (config.js) — cannot reach the model',
  'انلغى الفحص': 'Inspection cancelled', 'وقف الفحص': 'Inspection stopped',
  'الفحص ما كمل — {f}/{n} بلاطة ما انفحصت': 'Inspection incomplete — {f}/{n} tiles were not inspected',
  '{n} طلب للموديل فشل — ما تعتمد على «ما لقيت شي»:': '{n} model {n|call|calls} failed — do not trust «nothing found»:',
  'ما لقيت قطعة واضحة تحت الكاميرا — افردها بنص الكادر وجرّب': 'No clear garment under the camera — lay it flat in the middle of the frame and try again',
  'خلص — {n} نقطة للمراجعة': 'Done — {n} {n|spot|spots} to review', 'خلص — ما لقيت شي مشبوه': 'Done — nothing suspicious found',
  'ما لقيت قطعة بالكادر — ما انبعت شي للمراجعة': 'No garment in the frame — nothing was sent to review',
  'عم دوّر عالقطعة…': 'Finding the garment…',
  'عم فحص {n} بلاطة{skipped}…': 'Inspecting {n} {n|tile|tiles}{skipped}…', ' (تخطّى {k} برّا القطعة)': ' (skipped {k} outside the garment)',
  'بلاطة {i}/{n}': 'tile {i}/{n}',
  'عم أكد {n} نقطة{ex}…': 'Verifying {n} {n|spot|spots}{ex}…', ' مع {k} أمثلة من المفتشة': ' with {k} inspector {k|example|examples}',
  'ما في نقاط مشبوهة بالبلاطات': 'No suspicious spots in the tiles',
  'عم قارن اليمين بالشمال…': 'Comparing left and right…', 'نظرة عامة…': 'Overall look…', 'النقاط المحلية خلصت ✓': 'Local spots done ✓',
  'عم فحص {n} تطريز/طباعة عن قرب…': 'Checking {n} {n|design|designs} up close…', 'تطريز/طباعة': 'embroidery/print',
  'ما لقيت قطعة واضحة بالصورة': 'No clear garment in the photo', ' ث': ' s',
  ' · ركّز عالقطعة: {sent}/{tiles} بلاطة{dropped}': ' · garment focus: {sent}/{tiles} tiles{dropped}', ' · شال {k} نقطة برّا القطعة': ' · dropped {k} outside the garment',
  ' · 🧠 {k} أمثلة من المفتشة': ' · 🧠 {k} inspector {k|example|examples}',
  '🔎 البلاطات لقطت {n} مرشّح · التأكيد المكبّر أكّد {k} وشال {m}': '🔎 Tiles raised {n} {n|candidate|candidates} · the magnified check confirmed {k} and dropped {m}',
  ' · {u} مش متأكد (قرارك)': ' · {u} unsure (your call)', ' · التطريز عن قرب: {d}': ' · design close-ups: {d}', ' · النظرة العامة والمقارنة: {g}': ' · overall & mirror: {g}',

  // framing
  'فوق': 'top', 'تحت': 'bottom', 'شمال': 'left', 'يمين': 'right', ' و': ' and ',
  'القطعة طالعة برّا الكادر من {sides}': 'The garment is cut off at the {sides}',
  'القطعة صغيرة بالصورة ({p}٪) — قرّب الكاميرا': 'The garment is small in the frame ({p}%) — move the camera closer',
  'في شي غير القطعة عالطاولة (إيد / عصاية / غرض) — شيلو': 'Something other than the garment is on the table (hand / stick / object) — remove it',

  // empty table
  'ما في كاميرا — ما فيني صوّر الطاولة': 'No camera — cannot photograph the table',
  'التخزين المحلي رفض الحفظ': 'Local storage refused to save',
  '✓ انحفظت صورة الطاولة الفاضية — صار يعرف شو مش قطعة': '✓ Empty-table photo saved — it now knows what is not a garment',
  'ما قدرت صوّر الطاولة: ': 'Could not photograph the table: ', 'انمسحت صورة الطاولة الفاضية': 'Empty-table photo removed',
  'الطاولة الفاضية محفوظة ({date} {time})': 'Empty table saved ({date} {time})',
  'اختياري: صوّر الطاولة وهي فاضية مرة، فبيعرف شو مش قطعة (إيد، عصاية، غرض)': 'Optional: photograph the table once while empty, so it knows what is not a garment (hand, stick, object)',

  // overlay / picker / cards
  'استنّي يخلص الفحص': 'Wait for the inspection to finish',
  'انحفظ هالفحص — افحص قطعة جديدة لتعدّل': 'This inspection is saved — inspect a new piece to edit',
  'عم يحفظ — ما فيك تعدّل النقاط هلق': 'Saving — the spots cannot be edited right now',
  'انحفظت المراجعة — القطعة الجاية عم تنفتح': 'Review saved — the next piece is opening',
  'علّمتها المفتشة': 'marked by the inspector',
  'حطّ القطعة تحت الكاميرا وشيل إيديك — أو اختار صورة من الجهاز': 'Put the garment under the camera and take your hands away — or pick a photo from the device',
  'عم فحص…': 'Inspecting…',
  'ما لقيت قطعة واضحة بالصورة — افردها بنص الكادر وافحص من جديد': 'No clear garment in the photo — lay it flat in the middle of the frame and inspect again',
  'بانتظار قطعة من الكاميرا… أول ما تخلص بتطلع هون لحالها': 'Waiting for a piece from the camera… it will show up here by itself',
  'ما قدرت أفتح الصورة — افحص قطعة جديدة': 'Could not open the photo — inspect a new piece',
  'الفحص ما كمل — ما تعتمد على النتيجة، افحص القطعة من جديد': 'Inspection incomplete — do not trust the result, inspect the piece again',
  'ما لقيت شي مشبوه 👍 — كبس عالصورة إذا شفت عيب': 'Nothing suspicious found 👍 — tap the photo if you see a defect',
  'ما في نتيجة — كبس عالصورة إذا شفت عيب، أو افحص قطعة جديدة': 'No result — tap the photo if you see a defect, or inspect a new piece',
  'قياس': 'measure', 'مقارنة': 'mirror', 'عام': 'overall', 'مش متأكد': 'not sure', 'كبير': 'major',
  '➕ علّمتها المفتشة': '➕ marked by the inspector', '✗ شيلها': '✗ Remove', '✓ عيب': '✓ Defect', '✗ مش عيب': '✗ Not a defect',
  '— مين خيّطها؟ —': '— Who sewed it? —',

  // decision + save
  'انحفظ هالفحص — افحص قطعة جديدة': 'This inspection is saved — inspect a new piece',
  'عم يحفظ — القرار متثبّت': 'Saving — the decision is locked',
  '✓ انحفظ': '✓ Saved', 'عم يحفظ…': 'Saving…',
  'ما في اتصال بالقاعدة (config.js) — الحفظ معطّل': 'No database connection (config.js) — saving is disabled',
  'ما في قطعة بالصورة — ما في شي ينحفظ، افحص من جديد': 'No garment in the photo — nothing to save, inspect again',
  'عم جهّز الصور…': 'Preparing the images…', 'عم سجّل الفحص…': 'Recording the inspection…',
  'القاعدة ما رجّعت رقم الفحص': 'The database returned no inspection id',
  'عم رفع الصورة…': 'Uploading the photo…', 'عم رفع المعاينة…': 'Uploading the preview…', 'عم رفع الصورة المعلّمة…': 'Uploading the annotated photo…',
  'عم رفع القصّات {i}/{n}…': 'Uploading crops {i}/{n}…', 'عم سجّل النقاط…': 'Recording the spots…', 'عم سجّل الأمثلة…': 'Recording the examples…',
  '✓ انبعتت للمراجعة': '✓ Sent to review',
  '✓ انحفظ فحص القطعة السابقة{id}': '✓ The previous piece{id} was saved',
  'آخر قطعة #{id}: {what} — انبعتت للمراجعة': 'Last piece #{id}: {what} — sent to review', '{n} نقطة': '{n} {n|spot|spots}', ' ({r} أحمر)': ' ({r} red)', 'ما في نقاط': 'no spots',
  'ما انحفظ: ': 'Not saved: ', 'آخر قطعة ما انبعتت: ': 'Last piece was not sent: ',
  'فحص القطعة السابقة{id} ما خلص حفظو: {err}': 'The previous piece{id} did not finish saving: {err}', '🔁 حاول مرة تانية': '🔁 Try again',

  // two-device link
  'رمز الربط بين الموبايل والتابلت (نفسو عالجهازين؛ فاضي = بلا رمز):': 'Pairing code between the phone and the tablet (the same on both; empty = none):',
  '🔑 انحفظ رمز الربط': '🔑 Pairing code saved', 'انشال رمز الربط': 'Pairing code removed', 'كبسة: رمز الربط بين الجهازين': 'Tap: pairing code between the devices',
  'الفحص ما كمل عالموبايل — ': 'Inspection incomplete on the phone — ', 'ما لقيت قطعة بالكادر': 'No garment in the frame',
  '📷 الموبايل عم يصوّر…': '📷 The phone is shooting…', 'الموبايل ما صوّر: ': 'The phone did not shoot: ',
  'رمز الربط مش مطابق — كبسي على سطر الحالة لتكتبيه': 'Pairing code mismatch — tap the status line to enter it',
  'استنّي كم ثانية بين لقطة ولقطة': 'Wait a few seconds between shots',
  'الكاميرا مش شغّالة عالموبايل': 'The camera is not running on the phone',
  'ما في اتصال بالموبايل': 'No connection to the phone',
  'الموبايل ما ردّ — تأكدي إنو صفحة الكاميرا مفتوحة عليه': 'The phone did not answer — make sure the camera page is open on it',
  'رمز الربط مش مطابق': 'Pairing code mismatch',
  '📡 مباشر من الموبايل': '📡 Live from the phone', ' — كبسي للتكبير': ' — tap to enlarge',
  '📡 شوف الكاميرا': '📡 Show the camera', '⏹ سكّر البث': '⏹ Stop the feed',
  'في صورة مرجعية لهالموديل': 'This product has a reference photo', '📌 مرجع من صورة': '📌 Reference from a photo', '📌 شيل مرجع الموديل': '📌 Remove the product reference',
  '📌 اعتمدها مرجع للموديل': '📌 Use this piece as the product reference', '📌 انحفظ المرجع للموديل {m}': '📌 Reference saved for product {m}', 'انشال مرجع الموديل': 'Product reference removed',
  'ما في طلبية مختارة': 'No order selected', 'عم أحفظ المرجع…': 'Saving the reference…', 'ما في صورة لاعتمادها': 'No photo to use', 'ما قدرت أحفظ المرجع: ': 'Could not save the reference: ',
  'تعتمد هالقطعة صورة مرجعية صح للموديل {m}؟ (بتنبدّل القديمة إذا في)': 'Use this piece as the correct reference for product {m}? (replaces the old one, if any)',
  'تعتمد هالصورة مرجع صح للموديل {m}؟ (بتنبدّل القديمة إذا في)': 'Use this photo as the correct reference for product {m}? (replaces the old one, if any)',
  'تشيل الصورة المرجعية للموديل {m}؟': 'Remove the reference photo of product {m}?',
  'القرار تحت للقطعة كلها · النقاط: ✓ {c} عيب مؤكد · ✗ {r} مش عيب · {o} بلا حكم': 'The decision below is for the whole piece · spots: ✓ {c} confirmed · ✗ {r} not defects · {o} undecided',
  '🔌 عم وصل بشاشة المراجعة…': '🔌 Connecting to the review screen…',
  '🧐 شاشة المراجعة متصلة{by} — فيها تطلب الفحص من عندها': '🧐 Review screen connected{by} — it can trigger the inspection',
  '🧐 شاشة المراجعة مش مفتوحة — افتح الرابط عالتابلت واختار «تابلت المفتشة»': '🧐 Review screen not open — open the link on the tablet and choose «Inspector\'s tablet»',
  ' · 📡 البث شغّال': ' · 📡 streaming',
  'ما في اتصال بالموبايل (config.js)': 'No connection to the phone (config.js)',
  '📷 الموبايل مش متصل — افتحي رابط الكاميرا عليه': '📷 Phone not connected — open the camera link on it',
  '📨 بعتت للموبايل…': '📨 Sent to the phone…',
  '⏳ الموبايل عم يفحص{dev}{note}': '⏳ The phone is inspecting{dev}{note}',
  '📷 الموبايل عم يشغّل الكاميرا{dev}…': '📷 The phone is starting its camera{dev}…',
  '⏫ الموبايل عم يرفع القطعة السابقة{dev} — فيكي تصوّري التالية': '⏫ The phone is uploading the previous piece{dev} — you can shoot the next one',
  '📷 الموبايل متصل{dev} بس كاميرتو واقفة — الكبسة بتجرّب تشغيلها': '📷 Phone connected{dev} but its camera is off — the button will try to start it',
  '📷 الموبايل جاهز{dev} — حطّي القطعة واكبسي': '📷 Phone ready{dev} — place the piece and tap',
  ' · ⚠ آخر فحص: ': ' · ⚠ last inspection: ',
  ' · الموبايل بدو رمز ربط — كبسي هون لتكتبيه': ' · the phone wants a pairing code — tap here to enter it',

  // review screen
  'بانتظار قطعة من الكاميرا…': 'Waiting for a piece from the camera…',
  'وضع المراجعة بدو اتصال بالقاعدة (config.js)': 'Review mode needs a database connection (config.js)',
  'وصلت قطعة جديدة للمراجعة — «⬅ رجوع» لتفتحها': 'A new piece arrived for review — «⬅ Back» opens it',
  'وصلت قطعة جديدة — بتنفتح بعد ما تخلّصي هالقطعة': 'A new piece arrived — it opens after you finish this one',
  'بانتظار قطعة من الكاميرا… ({n} فحص محفوظ)': 'Waiting for a piece from the camera… ({n} saved {n|inspection|inspections})',
  'قطعة #{id} · {order} — عم نزّل الصورة…': 'Piece #{id} · {order} — loading the photo…',
  'الصورة مش موجودة بالمخزن ({status})': 'The photo is not in storage ({status})',
  'قطعة #{id} · {order} · {time} — {what}': 'Piece #{id} · {order} · {time} — {what}',
  '⚠ الفحص ما كمل عالموبايل — ما تعتمدي على «ما لقت شي»': '⚠ Inspection incomplete on the phone — do not trust «nothing found»',
  '{n} نقطة للمراجعة': '{n} {n|spot|spots} to review', 'الكاميرا ما لقت شي — قرّري': 'The camera found nothing — your call',
  'ما قدرت أفتح القطعة: ': 'Could not open the piece: ',
  'عم يحفظ المراجعة…': 'Saving the review…', 'عم نزّل الصورة الكاملة للقصّات…': 'Loading the full photo for the crops…',
  '✓ انحفظت المراجعة — القطعة الجاية عم تنفتح': '✓ Review saved — the next piece is opening',
  'ما انحفظت المراجعة: ': 'The review was not saved: ',

  // new piece / history
  'في فحص شغّال — استنّي يخلص أو ألغيه': 'An inspection is running — wait for it or cancel it',
  'المراجعة ما انحفظت — تتركها؟': 'The review is not saved — leave it?',
  'هالفحص ما انحفظ — تتركو؟': 'This inspection is not saved — leave it?',
  'ما قدرت جيب آخر الفحوصات: ': 'Could not load recent inspections: ', 'بعد ما في فحوصات': 'No inspections yet',
  'عم توصل من الكاميرا…': 'Arriving from the camera…', 'بانتظار المراجعة': 'Waiting for review',
  'لسا عم توصل من الكاميرا — ثواني': 'Still arriving from the camera — a few seconds',
  'المراجعة الحالية ما انحفظت — تتركها؟': 'The current review is not saved — leave it?',
  'فحص #{id} · {order} · {side} · {dec} · {by} · {time}': 'Inspection #{id} · {order} · {side} · {dec} · {by} · {time}', 'بلا قرار': 'no decision',
  'عم جيب النقاط…': 'Loading the spots…', 'ما قدرت جيب النقاط: ': 'Could not load the spots: ', 'ما كان في نقاط': 'There were no spots',

  // live.js (reasons travel from the phone to the tablet in the phone's language)
  'الموبايل ما بيدعم البث (WebRTC)': 'The phone does not support streaming (WebRTC)',
  'ما قدرت جهّز البث: ': 'Could not set up the stream: ',
  'البث ما وصل بعد — الجهازين لازم يكونوا على نفس الواي فاي': 'No stream yet — both devices must be on the same Wi-Fi',
  'الشبكة ما سمحت بالاتصال المباشر بين الجهازين (واي فاي منفصل أو عزل بين الأجهزة)': 'The network blocked the direct connection between the devices (separate Wi-Fi or client isolation)',
  'ما قدرت أفتح البث: ': 'Could not open the stream: ', 'الموبايل ما قدر يبعت البث': 'The phone could not send the stream',
  ' · {s} ث: ناطر عرض من الموبايل': ' · {s} s: waiting for the phone\'s offer', ' · {s} ث: العرض وصل، عم يتصل': ' · {s} s: offer received, connecting',
  ' · {s} ث: اتصل، ناطر أول صورة': ' · {s} s: connected, waiting for the first frame',

  // device setup, camera start, controls row, connection check (Oct 28)
  'إعدادات الجهاز': 'Device settings', 'فحص الجودة النهائي بالكاميرا': 'Final quality check by camera', 'هاد الجهاز شو دورو؟': 'What is this device?',
  'موبايل فوق الطاولة': 'Phone above the table', 'بيصوّر القطعة لحالو وبيبعتها للمفتشة': 'Shoots each piece by itself and sends it to the inspector',
  'تابلت المفتشة': 'Inspector\'s tablet', 'بيعرض النتيجة، بتأكد وبتقرّر': 'Shows the result; you confirm and decide',
  'جهاز واحد': 'One device', 'للتجربة والديمو: الكاميرا والمراجعة سوا': 'For trying and demos: camera and review together',
  'رمز الربط (نفسو عالجهازين، اختياري)': 'Pairing code (the same on both devices, optional)', 'الاسم (الجهاز أو المفتشة)': 'Name (device or inspector)',
  'متل: كاميرا 1': 'e.g. Camera 1', 'ابدأ': 'Start', 'اختار دور الجهاز أول': 'Choose the device role first',
  'شغّل الكاميرا': 'Start the camera', 'المتصفح رح يسألك تسمح للكاميرا — اختار «السماح».': 'The browser will ask for the camera — choose «Allow».',
  'ثبّت الموبايل فوق نص الطاولة · الطاولة فاضية وسادة · الضو ثابت · بعدين من «⋯» صوّر الطاولة فاضية مرة وحدة': 'Fix the phone above the middle of the table · plain, empty table · steady light · then photograph the empty table once from «⋯»',
  'حطّ القطعة جوّا الإطار وشيل إيديك': 'Put the garment inside the frame and take your hands away',
  'تلقائي': 'Auto', 'المزيد': 'More', 'اقلب': 'Flip', 'افحص': 'Inspect', 'خيارات': 'Options', '📶 فحص الاتصال': '📶 Connection check',
  'ما معك قطعة ولا كاميرا؟ جرّب صورة من المصنع:': 'No garment or camera at hand? Try a factory photo:',
  '🧪 سويت شيرت برتقالي (بقعة + خيوط)': '🧪 Orange sweatshirt (stain + threads)', '🧪 بنطلون زهري (خرم + بقعة)': '🧪 Pink pants (hole + stain)',
  '🧪 جرّب صورة جاهزة: سويت شيرت': '🧪 Try a sample: sweatshirt', '🧪 جرّب صورة جاهزة: بنطلون': '🧪 Try a sample: pants',
  'عم حمّل الصورة الجاهزة…': 'Loading the sample photo…', 'عينة': 'sample', 'ما قدرت حمّل الصورة الجاهزة: ': 'Could not load the sample photo: ',
  '📶 عم قيس سرعة الرفع…': '📶 Measuring upload speed…', 'ضعيف': 'weak', 'متوسط': 'medium', 'منيح': 'good',
  '📶 رفع {mbps} ميغابت/ث ({grade}) · ردّ {rtt} ms — الرفع لحالو حوالي {s} ث للقطعة': '📶 Upload {mbps} Mbit/s ({grade}) · round trip {rtt} ms — uploads alone take about {s} s per piece',
  '📶 ما قدرت قيس: ': '📶 Could not measure: ', '✓ انحفظ — عم رفع الصورة الكاملة…': '✓ Saved — uploading the full photo…',
  ' · ⚠ في {n} صفحات كاميرا على هالمحطة — سكّري الزيادة': ' · ⚠ {n} camera pages on this station — close the extra ones',
  '📸 هي اللقطة — الموبايل عم يفحصها…': '📸 This is the shot — the phone is inspecting it…',
  'للدقة الكاملة عالآيفون: صوّر القطعة بتطبيق الكاميرا (24 ميغابكسل) وبعدين اختارها من «📁». الكاميرا من جوّا المتصفح بتعطي 12 بس.': 'Full resolution on iPhone: shoot the piece with the Camera app (24 MP), then pick it with «📁». The camera inside the browser gives 12 MP only.',
  '⚠ في صفحة كاميرا تانية مفتوحة على نفس المحطة (تبويب قديم أو نسخة الشاشة الرئيسية) — سكّرها، وإلا التابلت بيلخبط بيناتهن': '⚠ Another camera page is open on this station (an old tab or the home-screen copy) — close it, or the tablet flips between the two',
}
