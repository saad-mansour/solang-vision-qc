# -*- coding: utf-8 -*-
# ثبات مقارنة المرآة: نفس الصور كم مرة، بجهد medium وhigh — الأسود (مختلف فعلاً) والزهر (متطابق)
import json, urllib.request, base64, time, io, os
from PIL import Image, ImageOps
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
LEGS = {'IMG_1290': ((913, 1513, 2195, 5230), (2159, 1513, 3495, 5237)), 'IMG_1289': ((1260, 2295, 2149, 4951), (2088, 2249, 3291, 4794))}
PROMPT = ("Image 1 is the LEFT pant leg of a children's garment lying flat (top-down). Image 2 is the RIGHT pant leg, flipped horizontally so it should look like a mirror image of the left one. "
          "Compare the construction: seam lines and their angles, panel shapes, pocket or decoration position, cuff/hem, stitching lines. Ignore wrinkles, lighting, shadows, how the fabric is laid, and small differences in where the crop was cut. "
          "Are there real construction differences a quality inspector would reject (seams in different positions or angles, missing or extra seam, different panel shape, decoration in a different place)? "
          "Answer ONLY JSON: {\"different\":true|false,\"confidence\":0-1,\"differences\":[\"short description with location\"],\"why\":\"one sentence\"}")
def spark(images, effort):
    content = [{'type': 'input_text', 'text': PROMPT}] + [{'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(b).decode()} for b in images]
    body = {'model': 'muse-spark-1.3', 'input': [{'role': 'user', 'content': content}], 'reasoning': {'effort': effort}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    txt = ' '.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    s = txt[txt.find('{'): txt.rfind('}') + 1]
    try: d = json.loads(s)
    except Exception: d = {'raw': txt[:100]}
    return d, round(time.time() - t, 1), j.get('usage', {}).get('output_tokens')
for n, (L, R) in LEGS.items():
    im = Image.open(os.path.join(P, n + '.jpg'))
    a = im.crop(L); b = ImageOps.mirror(im.crop(R))
    for c in (a, b): c.thumbnail((1200, 1200))
    bufs = []
    for c in (a, b):
        buf = io.BytesIO(); c.save(buf, 'JPEG', quality=88); bufs.append(buf.getvalue())
    for eff in ('medium', 'high'):
        for k in range(3):
            d, dt, ot = spark(bufs, eff)
            print(f"{n} {eff:6} #{k+1} {dt:5}s out={ot} → different={d.get('different')} c={d.get('confidence')} {str(d.get('differences', d.get('raw')))[:110]}")
