-- SOLANG Vision QC — demo storage: bucket + access policies
-- Run in the Supabase SQL editor AFTER demo-schema.sql (safe to re-run).
-- The station page uploads full-res inspection photos and defect crops with the
-- publishable (anon) key, so storage.objects needs policies scoped to this bucket only.

-- 1) bucket (idempotent — if you already created it from the dashboard this just makes sure it is public)
insert into storage.buckets (id, name, public)
values ('vision-photos', 'vision-photos', true)
on conflict (id) do update set public = true;

-- 2) policies on storage.objects (RLS is already on for this table) — ONLY for bucket vision-photos
drop policy if exists "vision-photos read"   on storage.objects;
drop policy if exists "vision-photos insert" on storage.objects;
drop policy if exists "vision-photos update" on storage.objects;

create policy "vision-photos read"   on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'vision-photos');

create policy "vision-photos insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'vision-photos');

create policy "vision-photos update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'vision-photos')
  with check (bucket_id = 'vision-photos');

-- No DELETE policy on purpose: the public key can add evidence photos but never erase them.
