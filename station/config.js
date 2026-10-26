// SOLANG Vision QC — settings of the public DEMO deployment (publishable values only: no secret lives here).
// PROXY_URL is empty because the proxy runs on the same origin (_worker.js on Cloudflare Pages, dev/serve.mjs locally).
export default {
  PROXY_URL: '',                       // '' = same origin (dev server proxies /v1/*). Production: 'https://<worker>.workers.dev'
  STATION_TOKEN: '',                   // sent as X-Station-Token (the Worker checks it; the dev server ignores it)
  SUPABASE_URL: 'https://iyiipsmxugprzmpizjur.supabase.co',
  SUPABASE_KEY: 'sb_publishable_A7ohrdTDhHaF7oFHRTk6zg_RMP1CQSq',  // publishable (anon) key of the DEMO project only — never a service key
  STATION: 'final-qc-1',
  BUCKET: 'vision-photos',
}
