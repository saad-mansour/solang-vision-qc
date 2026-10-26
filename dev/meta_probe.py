# -*- coding: utf-8 -*-
# اختبار أول اتصال بـMeta Model API: قائمة الموديلات + سؤال نص قصير + صورة (المفتاح من meta_key.txt — ما بينطبع أبداً)
import json, urllib.request, base64, sys, time, os
KEY = open(r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\meta_key.txt", encoding='utf-8-sig').read().strip()
BASE = 'https://api.meta.ai/v1'
def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method or ('POST' if data else 'GET'), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.load(r), round(time.time() - t, 1)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:800], round(time.time() - t, 1)
st, models, dt = call('/models')
print('models', st, dt)
if st == 200:
    for m in models.get('data', []): print('  -', m.get('id'), '|', {k: v for k, v in m.items() if k not in ('id', 'object', 'created', 'owned_by')} or '')
else: print(models)
st, r, dt = call('/responses', {'model': 'muse-spark-1.3', 'input': 'Reply with exactly: OK'})
print('text test', st, dt, (r.get('output_text') or [c.get('text') for o in r.get('output', []) for c in o.get('content', []) if c.get('type') == 'output_text']) if isinstance(r, dict) else r, '| usage', r.get('usage') if isinstance(r, dict) else '')
