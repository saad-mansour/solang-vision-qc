# -*- coding: utf-8 -*-
# تجربة البلاطات: نقسّم منطقة القطعة (بالدقة الكاملة) لبلاطات ~1200px متداخلة ونبعت كل وحدة لـSpark بالتوازي
# الهدف: هل بيلقط الخرم (أورنج) والخيط (أسود)؟ وكم إنذار كاذب عالزهر السليم؟ + الوقت والتوكنات
import json, urllib.request, base64, time, os, io, sys, concurrent.futures as cf
from PIL import Image
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
P = r"C:\Users\mrsaa\AppData\Local\Temp\claude\C--Users-mrsaa-OneDrive-Desktop-solang-factory-FINAL-v3-solang-factory-FINAL\fc16d0f7-253c-42bb-94bb-922acd81a3e1\scratchpad\hack\photos"
OUT = r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\dev\out"; os.makedirs(OUT, exist_ok=True)
# مناطق القطعة بالدقة الكاملة (من crops.py)
REG = {'IMG_1286': (610, 2080, 3750, 4450), 'IMG_1290': (980, 1300, 3510, 5300), 'IMG_1289': (1225, 2120, 3265, 4980)}
EXPECT = {'IMG_1286': 'hole/snag near right shoulder at full-res ~(2673,2570)', 'IMG_1290': 'white loose thread right leg ~(2673,3917) + white speck near right hem ~(3300,5100)', 'IMG_1289': 'CLEAN (no defect)'}
PROMPT = ("You are a strict garment quality inspector in a children's clothing factory. This is ONE TILE cut from a high-resolution top-down photo of a garment lying flat on a table. "
          "Look only at the fabric and seams. Report real manufacturing defects only: hole, snag/pull, stain or discoloration, loose or hanging thread, broken/skipped/double stitching, puckering, unfinished edge. "
          "Ignore: printed designs, intended decorations, fabric texture, wrinkles, shadows, the table, labels, and the tile edges. "
          "Answer ONLY JSON: {\"defects\":[{\"type\":\"...\",\"x_pct\":0-100,\"y_pct\":0-100,\"size\":\"tiny|small|medium|large\",\"confidence\":0-1,\"why\":\"...\"}]} . If nothing, {\"defects\":[]}.")
def spark(img_bytes, prompt, effort='low'):
    body = {'model': 'muse-spark-1.3', 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}, {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(img_bytes).decode()}]}], 'reasoning': {'effort': effort}}
    req = urllib.request.Request(BASE + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=180) as r: j = json.load(r)
    txt = ' '.join(c.get('text', '') for o in j.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text')
    return txt, j.get('usage', {}), round(time.time() - t, 1)
def tiles(im, size=1200, overlap=200):
    W, H = im.size; xs = list(range(0, max(1, W - size) + 1, size - overlap)); ys = list(range(0, max(1, H - size) + 1, size - overlap))
    if xs[-1] + size < W: xs.append(W - size)
    if ys[-1] + size < H: ys.append(H - size)
    out = []
    for y in ys:
        for x in xs:
            out.append((x, y, im.crop((x, y, min(x + size, W), min(y + size, H)))))
    return out
def run(name):
    im = Image.open(os.path.join(P, name + '.jpg')).crop(REG[name])
    ts = tiles(im)
    def one(t):
        x, y, tile = t; buf = io.BytesIO(); tile.save(buf, 'JPEG', quality=90)
        try:
            txt, u, dt = spark(buf.getvalue(), PROMPT)
            s = txt.strip(); s = s[s.find('{'): s.rfind('}') + 1]
            try: d = json.loads(s)
            except Exception: d = {'defects': [], 'raw': txt[:200]}
            return (x, y, tile.size, d, u.get('input_tokens', 0), u.get('output_tokens', 0), dt)
        except Exception as e:
            return (x, y, tile.size, {'defects': [], 'error': str(e)[:200]}, 0, 0, 0)
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=8) as ex: res = list(ex.map(one, ts))
    wall = round(time.time() - t0, 1)
    tin = sum(r[4] for r in res); tout = sum(r[5] for r in res)
    print(f"\n=== {name} · region {im.size} · {len(ts)} tiles · wall {wall}s · tokens in {tin} out {tout} · expect: {EXPECT[name]}")
    found = 0
    for x, y, (tw, th), d, ti, to, dt in res:
        for f in d.get('defects', []):
            found += 1
            fx = REG[name][0] + x + int(tw * float(f.get('x_pct', 0)) / 100); fy = REG[name][1] + y + int(th * float(f.get('y_pct', 0)) / 100)
            print(f"  tile({x},{y}) {dt}s -> {f.get('type')} conf={f.get('confidence')} size={f.get('size')} full-res~({fx},{fy}) | {str(f.get('why',''))[:90]}")
        if d.get('error'): print('  tile', x, y, 'ERROR', d['error'])
    if not found: print('  (no defects reported)')
    json.dump([{'x': r[0], 'y': r[1], 'size': r[2], 'result': r[3], 'in': r[4], 'out': r[5], 's': r[6]} for r in res], open(os.path.join(OUT, name + '_tiles.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for n in sys.argv[1:] or ['IMG_1286', 'IMG_1290', 'IMG_1289']: run(n)
