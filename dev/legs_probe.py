# -*- coding: utf-8 -*-
# (أ) قصاصات 2x للمرشحين الجدد عالزهر 1284 + الخرم الحقيقي بالرمادي حتى نشوف شو شاف الموديل
# (ب) SAM «pant leg» / «sleeve» → صندوقين → فرق أسفل الرجلين بالبكسل (قياس طول الرجل بلا Spark)
import json, urllib.request, base64, time, re, os
from PIL import Image
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
OUT = r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\dev\out"
BOX = re.compile(r'<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>')
def crop2x(n, x, y, tag):
    im = Image.open(os.path.join(P, n + '.jpg')); W, H = im.size
    c = im.crop((max(0, x - 250), max(0, y - 250), min(W, x + 250), min(H, y + 250))).resize((1000, 1000), Image.LANCZOS)
    c.save(os.path.join(OUT, f'{n}_{tag}_{x}_{y}.jpg'), quality=88)
for n, x, y in [('IMG_1284', 1591, 2453), ('IMG_1284', 1711, 2825), ('IMG_1284', 2471, 2828), ('IMG_1288', 1748, 2513), ('IMG_1290', 2642, 3887)]:
    crop2x(n, x, y, 'chk')
print('crops ok')
def sam(n, concept, maxside=1600):
    im = Image.open(os.path.join(P, n + '.jpg')); W, H = im.size; s = min(1, maxside / max(W, H))
    sm = im.resize((round(W * s), round(H * s)), Image.LANCZOS); import io; buf = io.BytesIO(); sm.save(buf, 'JPEG', quality=88)
    b64 = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    body = {'model': 'sam-3.1', 'input': [{'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': concept}, {'type': 'input_image', 'image_url': b64}]}], 'metadata': {'include_confidence': 'true', 'mask_encoding': 'one_bit'}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    txt = ''.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    boxes = [dict(x1=int(m[0]) / s, y1=int(m[1]) / s, x2=int(m[2]) / s, y2=int(m[3]) / s, c=float(m[6]) if m[6] else None) for m in BOX.findall(txt)]
    return boxes, round(time.time() - t, 1)
for n, concept in [('IMG_1284', 'pant leg'), ('IMG_1289', 'pant leg'), ('IMG_1290', 'pant leg'), ('IMG_1286', 'sleeve'), ('IMG_1284', 'trouser leg')]:
    boxes, dt = sam(n, concept)
    boxes = [b for b in boxes if (b['c'] or 1) >= 0.4]
    print(f"{n} «{concept}» {dt}s → {len(boxes)}: " + '; '.join(f"x{int(b['x1'])}-{int(b['x2'])} y{int(b['y1'])}-{int(b['y2'])} c={b['c'] and round(b['c'],2)}" for b in boxes[:4]))
    if len(boxes) >= 2 and 'leg' in concept:
        bb = sorted(boxes, key=lambda b: b['x1'])[:2]; d = bb[0]['y2'] - bb[1]['y2']
        print(f"   leg bottoms: left y2={int(bb[0]['y2'])} right y2={int(bb[1]['y2'])} → diff {int(d)} px ≈ {abs(d)/48:.1f} cm (48px/cm at 90cm)")
