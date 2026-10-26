# دليل النشر — SOLANG Vision QC (خطوة خطوة)

هالدليل مكتوب لحدا مش مبرمج. الكلمات يلي بين «» هي أسماء الأزرار متل ما بتطلع عالشاشة بالإنكليزي
(لوحات Cloudflare وSupabase بتغيّر شكلها بين فترة وفترة، فإذا زر غيّر اسمو شوي دوّر عالأقرب إلو).

**شو بدك قبل ما تبلّش**
- حساب Cloudflare (الخطة المجانية بتكفي).
- حساب GitHub فيه الريبو `solang-vision-qc` مرفوع.
- مفتاح Meta API (عندك بملف `meta_key.txt` — ما تحطو بأي مكان غير يلي مكتوب هون).
- رابط مشروع Supabase التجريبي ومفتاحو العام (publishable).

**الصورة الكبيرة (3 قطع):**

| القطعة | شو بتعمل |
|---|---|
| **Cloudflare Worker** | الوسيط. صفحة المحطة بتحكي معو، وهو بيحكي مع Meta بالمفتاح السري. المفتاح ما بيوصل عالتابلت أبداً. |
| **Cloudflare Pages** | بتستضيف صفحة المحطة نفسها (ملفات ثابتة من GitHub، بلا سيرفر). |
| **Supabase** | القاعدة التجريبية يلي بتنحفظ فيها الفحوصات والصور. جاهزة من قبل. |

---

## الخطوة 1 — Cloudflare Worker (الوسيط)

1. افتح <https://dash.cloudflare.com> وسجّل دخول.
2. من القائمة عاليسار اكبس «Workers & Pages» ← زر «Create» ← خلّيك بتبويب «Workers» ← «Start with Hello World!» (بنسخ أقدم اسمو «Create Worker»).
3. بخانة الاسم اكتب: `solang-vision-qc-proxy` ← «Deploy».
4. اكبس «Edit code». بيفتح محرر فيه ملف `worker.js` وفيه كود صغير اسمو Hello World.
5. **امسح كل** يلي بالملف، وافتح ملف `worker/src/index.js` من الريبو، انسخ محتواه كامل ولصقو مكانو ← «Deploy» (فوق عاليمين). إذا سأل «Save and deploy» اكبسها.
6. ارجع لصفحة الـWorker (السهم «←» فوق) ← تبويب «Settings» ← قسم «Variables and Secrets» ← «Add». ضيف الأربعة هدول واحد واحد، وبكل مرة اكبس «Deploy» أو «Save»:

   | Type | Variable name | Value |
   |---|---|---|
   | **Secret** | `META_API_KEY` | مفتاح Meta من ملف `meta_key.txt` (انسخو بلا فراغات قبل أو بعد) |
   | **Secret** | `STATION_TOKEN` | كلمة سر طويلة بتخترعها هلق (أحرف وأرقام، 20 حرف أو أكتر). **احفظها** لأنك رح تحطها بـ`config.js` بالخطوة 3 |
   | **Text** | `ALLOWED_ORIGINS` | `*` (نجمة) هلق. بالخطوة 2 بنبدّلها برابط الصفحة |
   | **Text** | `DAILY_LIMIT` | `400` (أقصى عدد طلبات من نفس الجهاز باليوم — حماية الرصيد) |

   (اختياري) `MAX_BODY_MB` = `25` — إذا ما ضفتها بياخد 25 لحالو.

7. **الفحص:** رابط الـWorker بيكون بهالشكل: `https://solang-vision-qc-proxy.<اسم-حسابك>.workers.dev` (بتلاقيه بصفحة الـWorker تحت «Preview» أو «Visit»).
   افتح بالمتصفح الرابط وضيف عليه `/health`، يعني:
   `https://solang-vision-qc-proxy.<اسم-حسابك>.workers.dev/health`
   لازم تشوف: `{"ok":true,"service":"solang-vision-qc proxy"}`
   - إذا طلع `META_API_KEY not configured` ← السر ما انحفظ، رجاع للنقطة 6.
   - إذا الصفحة ما فتحت أبداً ← الكود ما انعمل لو Deploy، رجاع للنقطة 5.

---

## الخطوة 2 — Cloudflare Pages (استضافة الصفحة من GitHub)

1. لازم الريبو يكون مرفوع عـGitHub (عام أو خاص، التنين ماشيين).
2. **مهم قبل الرفع:** ملف `station/config.js` (بنعبّيه بالخطوة 3) لازم يكون **موجود جوّا الريبو** عـGitHub، لأنو Pages بتنشر بس يلي موجود بـGitHub.
   هلق هالملف اسمو مكتوب بملف `.gitignore` يعني Git بيتجاهلو. إلك خيارين:
   - افتح `.gitignore` وامسح السطر `station/config.js` وبعدين اعمل commit عادي، **أو**
   - اتركو بـ`.gitignore` وضيفو بالقوة: `git add -f station/config.js`.

   القيم يلي بـ`config.js` كلها «عامة» (أي حدا بيفتح الصفحة بيقدر يشوفها من المتصفح على كل حال)، فمافي خطر برفعها.
   **بس** ما تحط فيه أبداً مفتاح Meta ولا مفتاح Supabase السري (`service_role`).
3. بـCloudflare: «Workers & Pages» ← «Create» ← تبويب «Pages» ← «Connect to Git» ← «GitHub» ← اسمح لـCloudflare يوصل عالريبو (بيفتح نافذة GitHub، اختار الريبو `solang-vision-qc` ← «Install & Authorize») ← اختار الريبو من القائمة ← «Begin setup».
4. الإعدادات:

   | الخانة | القيمة |
   |---|---|
   | Project name | `solang-vision-qc` (هاد بيصير جزء من الرابط) |
   | Production branch | `main` (أو اسم الفرع عندك) |
   | Framework preset | «None» |
   | Build command | **فاضي** — ما تكتب شي |
   | Build output directory | `/` (شرطة مايلة وحدة = جذر الريبو). إذا ما قبلها جرّب `.` |
   | Root directory (Advanced) | اتركو فاضي |

5. «Save and Deploy». بياخد دقيقة تقريباً. بالآخر بيعطيك الرابط: `https://solang-vision-qc.pages.dev`
   **صفحة المحطة:** `https://solang-vision-qc.pages.dev/station/` (مع الشرطة بالآخر).
6. من هلق ورايح، كل مرة بتعمل push عـGitHub بتنعاد النشرة لحالها.
7. ارجع عالـWorker ← «Settings» ← «Variables and Secrets» ← عدّل `ALLOWED_ORIGINS` وحط بدل النجمة:
   `https://solang-vision-qc.pages.dev` (بلا شرطة بالآخر) ← «Deploy».
   هيك ما حدا غير صفحتك بيقدر يستعمل الوسيط من متصفح.

---

## الخطوة 3 — ملف `station/config.js`

انسخ `station/config.example.js` لملف جديد اسمو `station/config.js` وعبّي القيم:

```js
export default {
  PROXY_URL: 'https://solang-vision-qc-proxy.<اسم-حسابك>.workers.dev', // رابط الـWorker من الخطوة 1 — بلا / بالآخر
  STATION_TOKEN: 'نفس-كلمة-السر-يلي-حطيتها-بالـWorker',                 // لازم تكون مطابقة حرف بحرف
  SUPABASE_URL: 'https://xxxx.supabase.co',   // Supabase ← Project Settings ← API ← Project URL
  SUPABASE_KEY: 'sb_publishable_xxx',         // Supabase ← Project Settings ← API Keys ← المفتاح العام (publishable / anon) بس
  STATION: 'final-qc-1',                      // اسم المحطة (بينحفظ مع كل فحص)
  BUCKET: 'vision-photos',
}
```

- `PROXY_URL` فاضي `''` = التشغيل المحلي بس (`node dev/serve.mjs` عالكمبيوتر). **عالموقع المنشور لازم يكون رابط الـWorker.**
- **ليش لازم يكون الملف موجود عالموقع:** الصفحة أول ما تفتح بتعمل `import './config.js'`. إذا الملف مش موجود عالسيرفر، الصفحة بتوقف فوراً (خطأ 404 بالاستيراد) وما بيطلع شي. لهيك بالخطوة 2 شدّدنا إنو يكون مرفوع مع الريبو.
- إذا غيّرت `STATION_TOKEN` بالـWorker لازم تغيّرو هون كمان وتعمل push.

---

## الخطوة 4 — Supabase (جاهز — للعلم بس)

المشروع التجريبي معمول وشغّال من قبل. يلي فيه:

| الملف / الشي | شو بيعمل |
|---|---|
| `sql/demo-schema.sql` | الجداول: `demo_orders` و`demo_workers` (بيانات وهمية: 5 أوامر و9 عمال)، `vision_inspections` (كل فحص)، `vision_findings` (كل نقطة مشبوهة وقرار المفتشة)، `vision_examples` (القصاصات المؤكدة = تعلّم لاحقاً) |
| `sql/storage-policies.sql` | البكت `vision-photos` (عام للقراءة) + صلاحيات إضافة وتحديث **بلا حذف** |
| البكت `vision-photos` | فيه صورة كل فحص: الأصلية، المعلّمة بالدواير، وقصاصة كل نقطة |

- إذا احتجت تعيد بناءو بمشروع Supabase جديد: Supabase ← «SQL Editor» ← «New query» ← الصق محتوى `sql/demo-schema.sql` ← «Run»، وبعدين نفس الشي لـ`sql/storage-policies.sql`.
- المفتاح يلي بينحط بـ`config.js` هو **Publishable key** (anon) بس. مفتاح `service_role` ما بيطلع من Supabase أبداً.
- هالمشروع كلو وهمي ومؤقت: بيانات مش حقيقية، وبينسكّر بعد التحكيم.

---

## الخطوة 5 — التابلت / الموبايل

1. افتح **Chrome** (أندرويد) أو **Safari** (آيفون / آيباد) واكتب رابط المحطة:
   `https://solang-vision-qc.pages.dev/station/`
2. أول مرة بيسأل «السماح باستخدام الكاميرا؟» ← «Allow» / «السماح».
   إذا انرفضت بالغلط: اكبس أيقونة القفل جنب الرابط ← «Permissions» ← «Camera» ← «Allow» ← أعد تحميل الصفحة.
3. **ضيفها عالشاشة الرئيسية** لتفتح متل تطبيق بشاشة كاملة:
   - Chrome: زر ⋮ (فوق عاليمين) ← «Add to Home screen» ← «Add».
   - Safari: زر المشاركة (المربع مع السهم) ← «Add to Home Screen» ← «Add».
4. **HTTPS ضروري:** الكاميرا بالمتصفح ما بتفتح إلا على رابط `https://` (رابط Pages https أوتوماتيكياً). رابط `http://` بيشتغل بس على `localhost` بالكمبيوتر.
5. ثبّت التابلت فوق طاولة الفحص، الكاميرا الخلفية لتحت، والقطعة كلها جوّا الكادر. بالصفحة فيه زر «🔄 كاميرا» إذا فتحت عالكاميرا الأمامية.
6. المسار: اختار الأمر من القائمة، اكتب اسم المفتشة، حط القطعة وشيل إيديك — الصفحة بتصوّر لحالها لما القطعة تثبت (أو اكبس «📸 افحص هلق»).

---

## إذا شي ما مشي

| الرسالة / العارض | السبب | الحل |
|---|---|---|
| `bad station token` (401) | التوكن بـ`config.js` مش مطابق ليلي بالـWorker | خلّيهن متطابقين وعمل push |
| `daily limit reached` (429) | نفس الجهاز تجاوز `DAILY_LIMIT` اليوم | ارفع الرقم بالـWorker أو استنى بكرا |
| خطأ CORS بالمتصفح | `ALLOWED_ORIGINS` ما فيها رابط الصفحة | حط رابط Pages بالضبط (بلا شرطة بالآخر) أو `*` للتجربة |
| الصفحة بيضا ما فيها شي | `station/config.js` مش موجود عالموقع | الخطوة 2 النقطة 2 |
| الكاميرا ما بتفتح | الرابط `http://` أو الإذن مرفوض | افتح الرابط بـ`https://` وأعطي الإذن |
| `model not allowed` | الطلب بيستعمل موديل مش بالقائمة المسموحة بالـWorker | ما بيصير مع الصفحة الأصلية؛ إذا صار بلّغ المطوّر |

---

## قائمة التأكد الأخيرة

- [ ] `/health` على رابط الـWorker بيرجع `"ok":true`
- [ ] السرّين `META_API_KEY` و`STATION_TOKEN` محفوظين بالـWorker (Type: Secret)
- [ ] `station/config.js` موجود بالريبو عـGitHub، وفيه رابط الـWorker ونفس `STATION_TOKEN`
- [ ] رابط Pages بيفتح، و`/station/` بتطلع الصفحة بلا أخطاء
- [ ] `ALLOWED_ORIGINS` صار رابط Pages (مش `*`)
- [ ] الكاميرا اشتغلت عالتابلت، وأول فحص انحفظ (Supabase ← «Table Editor» ← `vision_inspections`)
- [ ] الصفحة مضافة عالشاشة الرئيسية للتابلت
- [ ] **بعد التحكيم:** بدّل أو ألغي مفتاح Meta و`STATION_TOKEN`، وسكّر مشروع Supabase التجريبي
