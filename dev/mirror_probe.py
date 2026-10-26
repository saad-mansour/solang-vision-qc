# -*- coding: utf-8 -*-
# مقارنة الرجل الشمال بالرجل اليمين (معكوسة كمرآة) — الأسود (فيه اختلاف درز) مقابل الزهر النضيف (كنترول)
import json, urllib.request, base64, time, io, os
from PIL import Image, ImageOps
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
OUT = r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\dev\out"
LEGS = {'IMG_1290': ((913, 1513, 2195, 5230), (2159, 1513, 3495, 5237)), 'IMG_1289': ((1260, 2295, 2149, 4951), (2088, 2249, 3291, 4794)), 'IMG_1284': ((1131, 2227, 2138, 5030), (2113, 2256, 3113, 4826))}
PROMPT = ("Image 1 is the LEFT leg of a pair of children's trousers lying flat (top-down). Image 2 is the RIGHT leg, flipped horizontally so that it should look like a mirror image of the left leg. "
          "Compare the construction: decorative seam lines, panel shapes, pocket position, cuff/hem, stitching lines. Ignore wrinkles, lighting and how the fabric is laid. "
          "Are there real construction differences between the two legs that a quality inspector would reject (seams in different positions or angles, missing seam, different panel shape, different length by more than 2 cm)? "
          "Answer ONLY JSON: {\"different\": true|false, \"confidence\": 0-1, \"differences\": [\"short description with location\"], \"why\": \"one sentence\"}")
def spark(images, effort='medium'):
    content = [{'type': 'input_text', 'text': PROMPT}] + [{'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(b).decode()} for b in images]
    body = {'model': 'muse-spark-1.3', 'input': [{'role': 'user', 'content': content}], 'reasoning': {'effort': effort}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    txt = ' '.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    return txt, j.get('usage', {}), round(time.time() - t, 1)
for n, (L, R) in LEGS.items():
    im = Image.open(os.path.join(P, n + '.jpg'))
    a = im.crop(L); b = ImageOps.mirror(im.crop(R))
    for c in (a, b): c.thumbnail((1200, 1200))
    bufs = []
    for i, c in enumerate((a, b)):
        buf = io.BytesIO(); c.save(buf, 'JPEG', quality=88); bufs.append(buf.getvalue()); c.save(os.path.join(OUT, f'{n}_leg{i}.jpg'), quality=85)
    txt, u, dt = spark(bufs)
    print(f"{n}: {dt}s in={u.get('input_tokens')} out={u.get('output_tokens')} → {txt[:400]}")
