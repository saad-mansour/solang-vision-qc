# -*- coding: utf-8 -*-
# فحص مشروع Supabase التجريبي: الرابط والمفتاح من supabase_demo.txt (ما بينطبعوا) — الجداول والـbucket
# usage: python check_supabase.py            → GET فقط (جداول + وجود الـbucket)
#        python check_supabase.py --probe-upload → كمان بيجرّب رفع ملف نصي صغير  _probe/ok.txt  عالـbucket (كتابة بالمشروع التجريبي بس)
import io, json, sys, urllib.request, urllib.parse
P = r"C:\Users\mrsaa\OneDrive\Desktop\solang-vision-qc\supabase_demo.txt"
lines = [l.strip() for l in io.open(P, encoding='utf-8-sig').read().splitlines() if l.strip()]
url = next((l for l in lines if l.startswith('http')), None); key = next((l for l in lines if not l.startswith('http')), None)
print('url ok:', bool(url), '| key ok:', bool(key and len(key) > 20), '| key kind:', ('publishable' if key and key.startswith('sb_publishable_') else 'jwt-anon' if key and key.startswith('eyJ') else 'unknown'))
u = urllib.parse.urlparse(url); url = u.scheme + '://' + u.netloc          # tolerate a pasted REST url (…/rest/v1/)
if u.path.strip('/'): print('  note: URL line had a path (' + u.path + ') — using the project origin only')

def call(method, path, data=None, extra=None, auth=True):
    h = {'apikey': key, 'Authorization': 'Bearer ' + key} if auth else {}
    h.update(extra or {})
    req = urllib.request.Request(url + path, headers=h, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read().decode('utf-8', 'replace'), dict(r.headers)
    except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')[:300], {}
def code(body):
    try: return json.loads(body).get('code') or json.loads(body).get('error')
    except Exception: return body[:80]

for t in ['demo_orders', 'demo_workers', 'vision_inspections', 'vision_findings', 'vision_examples']:
    st, body, hdr = call('GET', '/rest/v1/' + t + '?select=*&limit=1', extra={'Prefer': 'count=exact'})
    rows = hdr.get('Content-Range', hdr.get('content-range', '?')).split('/')[-1]
    print(f"  table {t:20} HTTP {st}  rows={rows}" + ('' if st in (200, 206) else '  ' + body[:120]))

# bucket: metadata is hidden from the public key by RLS, so probe a public object URL instead
#   NoSuchKey    = bucket exists and is public (the file just is not there)   NoSuchBucket = bucket missing
st, body, _ = call('GET', '/storage/v1/object/public/vision-photos/__probe__.jpg', auth=False)
c = code(body)
print('  bucket vision-photos:', 'OK (exists, public)' if c == 'NoSuchKey' else 'MISSING — create it or run sql/storage-policies.sql' if c == 'NoSuchBucket' else f'HTTP {st} {c}')

if '--probe-upload' in sys.argv:
    st, body, _ = call('POST', '/storage/v1/object/vision-photos/_probe/ok.txt', b'ok', {'Content-Type': 'text/plain', 'x-upsert': 'true'})
    if st == 200:
        st2, _, _ = call('GET', '/storage/v1/object/public/vision-photos/_probe/ok.txt', auth=False)
        print('  upload probe: OK — the station can save photos | public read HTTP', st2)
    else:
        print('  upload probe: BLOCKED HTTP', st, code(body), '→ run sql/storage-policies.sql')
