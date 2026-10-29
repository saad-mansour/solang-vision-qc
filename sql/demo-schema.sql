-- SOLANG Vision QC — demo database schema (Supabase / Postgres)
-- A SEPARATE throwaway Supabase project with FAKE data is used for the hackathon demo.
-- The production SOLANG database is never touched by this project.
-- Run this once in the demo project's SQL editor.

-- Demo master data (fake orders / lines / workers) so a finding can be attributed to who made it
create table if not exists demo_orders (
  order_number text primary key,
  model_code   text not null,
  product      text not null,           -- e.g. سويت شيرت / بنطلون
  garment      text not null default 'garment',   -- pipeline garment key: sweatshirt | pants | tshirt | hoodie ...
  color        text,
  line         text,                    -- sewing line
  reference_url text,                   -- known-good reference photo, FRONT side (storage URL)
  reference_back_url text,              -- the same for the BACK side (Oct 29) — a side-less older row keeps its front photo
  created_at   timestamptz default now()
);

create table if not exists demo_workers (
  id          bigserial primary key,
  name        text not null,
  line        text,
  stage       text                     -- the operation this worker does on the line
);

-- One inspection = one garment side placed under the camera
create table if not exists vision_inspections (
  id            bigserial primary key,
  created_at    timestamptz default now(),
  station       text default 'final-qc-1',
  inspector     text,
  order_number  text references demo_orders(order_number),
  model_code    text,
  garment       text,
  side          text default 'front',   -- front | back
  photo_path    text,                   -- storage path of the full-res photo
  annotated_path text,
  width         int,
  height        int,
  garment_box   jsonb,                  -- {x,y,w,h}
  result        jsonb,                  -- full pipeline result (findings, parts, timings, usage)
  n_red         int default 0,
  n_amber       int default 0,
  decision      text,                   -- pass | reject | repair (inspector's final call)
  duration_ms   int,
  input_tokens  int,
  output_tokens int
);

-- Each flagged spot, with the inspector's verdict
create table if not exists vision_findings (
  id             bigserial primary key,
  inspection_id  bigint references vision_inspections(id) on delete cascade,
  created_at     timestamptz default now(),
  kind           text,                  -- local | global
  source         text,                  -- tiles | parts | mirror | global | inspector
  type           text,                  -- hole | snag | stain | loose_thread | stitching | puckering | unfinished_edge | asymmetry | length | print | missing_part | other
  x              int,
  y              int,
  confidence     numeric(4,3),
  level          text,                  -- red | amber
  severity       text,                  -- minor | major
  why            text,
  crop_path      text,                  -- 2x crop around the spot (storage)
  verdict        text,                  -- confirmed | rejected | added  (added = inspector marked a spot the camera missed)
  verdict_by     text,
  verdict_at     timestamptz,
  worker_name    text,                  -- attribution (from the order's line / stage)
  stage          text
);

-- Confirmed crops become few-shot examples for later inspections (the station "learns" from the inspector)
create table if not exists vision_examples (
  id            bigserial primary key,
  created_at    timestamptz default now(),
  finding_id    bigint references vision_findings(id) on delete cascade,
  model_code    text,
  type          text not null,
  label         text not null,          -- defect | not_defect
  crop_path     text not null,
  note          text
);

create index if not exists vision_inspections_created_idx on vision_inspections (created_at desc);
create index if not exists vision_findings_inspection_idx on vision_findings (inspection_id);
create index if not exists vision_examples_type_idx on vision_examples (type, label);

-- Demo project only: open access for the public demo link (fake data, throwaway project, keys revoked after Nov 9)
alter table demo_orders        disable row level security;
alter table demo_workers       disable row level security;
alter table vision_inspections disable row level security;
alter table vision_findings    disable row level security;
alter table vision_examples    disable row level security;

-- Storage: create a PUBLIC bucket named  vision-photos  from the dashboard (Storage → New bucket → public)

-- Seed: a few fake orders and workers
insert into demo_orders (order_number, model_code, product, garment, color, line) values
  ('W26-101', 'SW-24-FASTFLIPS', 'سويت شيرت أطفال', 'sweatshirt', 'كاميل', 'خط 2'),
  ('W26-102', 'PT-24-BLACK-PANEL', 'بنطلون أطفال', 'pants', 'أسود', 'خط 1'),
  ('W26-103', 'PT-24-RIB-PINK', 'بنطلون ريب أطفال', 'pants', 'زهري', 'خط 3'),
  ('W26-104', 'SW-24-BOWS', 'سويت شيرت بيبي', 'sweatshirt', 'كريمي', 'خط 2'),
  ('W26-105', 'SW-24-GRAFFITI', 'سويت شيرت أطفال', 'sweatshirt', 'أخضر', 'خط 1')
on conflict (order_number) do nothing;

insert into demo_workers (name, line, stage) values
  ('هدى', 'خط 1', 'سدة جمبين'), ('مروة', 'خط 1', 'تركيب كمر'), ('أحمد', 'خط 1', 'عرض'),
  ('سلمى', 'خط 2', 'تركيب كم'), ('ياسمين', 'خط 2', 'تركيب كولة'), ('محمود', 'خط 2', 'عرض'),
  ('نور', 'خط 3', 'سدة جمبين'), ('إيمان', 'خط 3', 'كفة'), ('خالد', 'خط 3', 'عرض')
on conflict do nothing;
