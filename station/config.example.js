// SOLANG Vision QC — per-deployment settings. Copy to config.js and fill in (config.js is gitignored).
export default {
  PROXY_URL: '',                       // '' = same origin (dev server proxies /v1/*). Production: 'https://<worker>.workers.dev'
  STATION_TOKEN: '',                   // sent as X-Station-Token (the Worker checks it; the dev server ignores it)
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_KEY: 'sb_publishable_xxx',  // publishable (anon) key of the DEMO project only — never a service key
  STATION: 'final-qc-1',
  BUCKET: 'vision-photos',
}
