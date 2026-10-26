# -*- coding: utf-8 -*-
# خطوة التأكيد: لكل مرشّح من البلاطات نقص نافذة 500px من الدقة الكاملة، نكبّرها 2x، ونسأل Spark يأكد/يرفض ويصنّف
# + تجربة reasoning effort أقل على بلاطة وحدة لقياس الوقت/التوكنات
import json, urllib.request, base64, time, os, io, concurrent.futures as cf
from PIL import Image
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
OUT = r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\dev\out"
REG = {'IMG_1286': (610, 2080, 3750, 4450), 'IMG_1290': (980, 1300, 3510, 5300), 'IMG_1289': (1225, 2120, 3265, 4980)}
def spark(img_bytes, prompt, effort='low'):
    body = {'model': 'muse-spark-1.3', 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}, {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(img_bytes).decode()}]}]}
    if effort: body['reasoning'] = {'effort': effort}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    except urllib.error.HTTPError as e:
        return 'HTTP ' + str(e.code) + ' ' + e.read().decode('utf-8', 'replace')[:200], {}, round(time.time() - t, 1)
    txt = ' '.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    return txt, j.get('usage', {}), round(time.time() - t, 1)
VPROMPT = ("You are a strict garment quality inspector. This is a 2x magnified crop (about 5x5 cm of fabric) around a spot that an automatic pass flagged as a possible defect, from a children's garment lying flat. "
           "Decide if there is a REAL manufacturing defect at or near the center. Real defects: hole, snag/pull, stain or discoloration, loose or hanging thread, broken/skipped/double stitching, puckering, unfinished edge. "
           "NOT defects: printed design, intended decoration, normal fabric texture or heather, wrinkles, shadows, lint-free clean fabric, tile edges. "
           "Answer ONLY JSON: {\"defect\": true|false, \"type\": \"hole|snag|stain|loose_thread|stitching|puckering|unfinished_edge|none\", \"confidence\": 0-1, \"severity\": \"minor|major\", \"why\": \"one sentence\"}")
cands = []
for n in REG:
    for t in json.load(open(os.path.join(OUT, n + '_tiles.json'), encoding='utf-8')):
        tw, th = t['size']
        for f in t['result'].get('defects', []):
            try: xp, yp = float(f.get('x_pct', 0)), float(f.get('y_pct', 0))
            except Exception: continue
            if not (0 <= xp <= 100 and 0 <= yp <= 100): continue
            cands.append((n, REG[n][0] + t['x'] + int(tw * xp / 100), REG[n][1] + t['y'] + int(th * yp / 100), f.get('type'), f.get('confidence')))
# دمج المرشحين القريبين (نفس العيب بين بلاطتين متداخلتين)
merged = []
for c in cands:
    for m in merged:
        if m[0] == c[0] and abs(m[1] - c[1]) < 120 and abs(m[2] - c[2]) < 120: m[5] += 1; break
    else: merged.append([c[0], c[1], c[2], c[3], c[4], 1])
print(f'{len(cands)} candidates -> {len(merged)} after merge')
def verify(m):
    n, x, y, typ, conf, k = m
    im = Image.open(os.path.join(P, n + '.jpg')); W, H = im.size
    x0, y0 = max(0, x - 250), max(0, y - 250); crop = im.crop((x0, y0, min(W, x + 250), min(H, y + 250))).resize((1000, 1000), Image.LANCZOS)
    buf = io.BytesIO(); crop.save(buf, 'JPEG', quality=92)
    crop.save(os.path.join(OUT, f'{n}_v_{x}_{y}.jpg'), quality=85)
    txt, u, dt = spark(buf.getvalue(), VPROMPT)
    s = txt[txt.find('{'): txt.rfind('}') + 1]
    try: d = json.loads(s)
    except Exception: d = {'raw': txt[:160]}
    return (n, x, y, typ, conf, k, d, u.get('input_tokens', 0), u.get('output_tokens', 0), dt)
t0 = time.time()
with cf.ThreadPoolExecutor(max_workers=8) as ex: res = list(ex.map(verify, merged))
print(f'verification wall {round(time.time() - t0, 1)}s · tokens in {sum(r[7] for r in res)} out {sum(r[8] for r in res)}')
for n, x, y, typ, conf, k, d, ti, to, dt in sorted(res):
    print(f"  {n} ({x},{y}) tiles={k} tile-said={typ}/{conf} -> verdict defect={d.get('defect')} type={d.get('type')} conf={d.get('confidence')} sev={d.get('severity')} {dt}s | {str(d.get('why', d.get('raw', '')))[:100]}")
# تجربة جهد التفكير على بلاطة وحدة (الأسود، البلاطة يلي فيها الخيط)
im = Image.open(os.path.join(P, 'IMG_1290.jpg')).crop((980 + 1000, 1300 + 2000, 980 + 2200, 1300 + 3200)); buf = io.BytesIO(); im.save(buf, 'JPEG', quality=90)
TP = "Garment QC tile. Report real manufacturing defects only (hole, snag, stain, loose thread, bad stitching). Ignore prints, texture, wrinkles, shadows, table. JSON only: {\"defects\":[{\"type\":\"...\",\"x\":0-1000,\"y\":0-1000,\"confidence\":0-1}]}"
for eff in ['minimal', 'low', 'medium']:
    txt, u, dt = spark(buf.getvalue(), TP, eff)
    print(f"effort={eff:8} {dt}s in={u.get('input_tokens')} out={u.get('output_tokens')} reasoning={(u.get('output_tokens_details') or {}).get('reasoning_tokens')} -> {txt[:140].replace(chr(10),' ')}")
