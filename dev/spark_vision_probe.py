# -*- coding: utf-8 -*-
# اختبار رؤية: صورة خرم الأورنج (قصاصة مكبّرة) + القطعة كاملة — بجهد تفكير منخفض لقياس السرعة والكلفة
import json, urllib.request, base64, time, sys
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
def b64(p): return 'data:image/jpeg;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
def ask(model, text, imgs, effort='low'):
    content = [{'type': 'input_text', 'text': text}] + [{'type': 'input_image', 'image_url': b64(p)} for p in imgs]
    body = {'model': model, 'input': [{'role': 'user', 'content': content}], 'reasoning': {'effort': effort}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    except urllib.error.HTTPError as e:
        return None, e.read().decode('utf-8', 'replace')[:600], round(time.time() - t, 1)
    txt = ' '.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    return j.get('usage'), txt, round(time.time() - t, 1)
Q1 = "You are a garment quality inspector. This is a zoomed crop of a children's sweatshirt. Is there any defect (hole, snag, stain, loose thread, broken seam)? Answer in JSON: {\"defect\": true/false, \"type\": \"...\", \"location\": \"...\", \"confidence\": 0-1, \"reason\": \"...\"}"
u, txt, dt = ask('muse-spark-1.3', Q1, [P + r"\IMG_1286_zoomS.jpg"])
print('== zoom crop (hole) ==', dt, 's', u and {k: u[k] for k in ('input_tokens', 'output_tokens')}, u and u.get('output_tokens_details'))
print(txt[:700])
Q2 = "You are a garment quality inspector. Full top-down photo of a children's sweatshirt on a table. List every visible defect (hole, snag, stain, loose thread, broken or double seam, asymmetry). For each give an approximate location as a percentage of image width/height (x%, y%). Answer in JSON list; if none, []."
u, txt, dt = ask('muse-spark-1.3', Q2, [P + r"\IMG_1286_crop.jpg"])
print('\n== full garment (orange) ==', dt, 's', u and {k: u[k] for k in ('input_tokens', 'output_tokens')})
print(txt[:900])
