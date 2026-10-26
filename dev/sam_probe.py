# -*- coding: utf-8 -*-
# اختبار SAM 3.1: هل بيلاقي القطعة؟ وهل بيأشّر على الخرم/الخيط بكلمة؟ (صناديق بس، بلا أقنعة)
import json, urllib.request, base64, time, re, os
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
def b64(p): return 'data:image/jpeg;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
BOX = re.compile(r'<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>')
def sam(img, concept):
    body = {'model': 'sam-3.1', 'input': [{'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': concept}, {'type': 'input_image', 'image_url': b64(img)}]}], 'metadata': {'include_confidence': 'true', 'mask_encoding': 'one_bit'}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    except urllib.error.HTTPError as e:
        return None, e.read().decode('utf-8', 'replace')[:400], round(time.time() - t, 1)
    txt = ''.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    boxes = []
    for m in BOX.findall(txt):
        x1, y1, x2, y2, w, h, c = m
        boxes.append((int(x1), int(y1), int(x2), int(y2), int(w), int(h), float(c) if c else None))
    return boxes, len(txt), round(time.time() - t, 1)
tests = [
  ('IMG_1286_crop.jpg', 'sweatshirt'), ('IMG_1286_crop.jpg', 'hole'), ('IMG_1286_crop.jpg', 'hole in fabric'), ('IMG_1286_crop.jpg', 'stain'),
  ('IMG_1290_crop.jpg', 'loose thread'), ('IMG_1290_crop.jpg', 'white thread'), ('IMG_1290_crop.jpg', 'pants'),
  ('IMG_1292_crop.jpg', 'stain'), ('IMG_1292_crop.jpg', 'bow'),
]
print('expected: orange hole ~ (1182,281) · black thread ~ (762,1177)')
for img, concept in tests:
    boxes, n, dt = sam(os.path.join(P, img), concept)
    if boxes is None: print(img, '|', concept, '| ERROR', n); continue
    print(f"{img:18} | {concept:16} | {dt:5}s | {len(boxes)} match(es) | " + '; '.join(f"({b[0]},{b[1]})-({b[2]},{b[3]}) c={b[6]}" for b in boxes[:6]))
