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

create policy "vision-photos insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'vision-photos');

-- No SELECT policy (since Oct 29): the bucket is public, so a photo is read by its direct URL without any policy, and a SELECT
-- policy would let anyone with the publishable key LIST every file in the bucket (the dashboard flagged exactly that).
-- No UPDATE and no DELETE policy on purpose: the public key can add evidence photos but never overwrite, list or erase them.
-- (Earlier versions of this file created "read" and "update" policies; the drops above remove them when you re-run the file.)
