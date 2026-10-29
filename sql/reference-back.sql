-- SOLANG Vision QC — demo project only (NOT the factory database). Run once in the Supabase SQL editor.
-- 29 Oct: one reference photo per SIDE of the product — reference_url stays the FRONT, reference_back_url is the BACK.
-- Until this runs the station reads orders without the column (front reference only) and «📌 … ضهر» reports the missing column.
alter table demo_orders add column if not exists reference_back_url text;
