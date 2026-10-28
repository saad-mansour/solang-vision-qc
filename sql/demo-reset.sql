-- SOLANG Vision QC — wipe the DEMO inspections to start clean (run in the Supabase SQL editor of the demo project only).
-- Removes every inspection, its findings, the learning examples (the inspector's verdict crops) and the photos in the
-- vision-photos bucket. Orders, workers and the schema stay. Ids restart at 1. There is no undo.
begin;

truncate table vision_findings, vision_examples, vision_inspections restart identity cascade;

-- the photos: storage rows go here; the files themselves are reaped by Supabase shortly after
delete from storage.objects where bucket_id = 'vision-photos';

commit;

-- check: all three counts must be 0
select (select count(*) from vision_inspections) as inspections,
       (select count(*) from vision_findings)    as findings,
       (select count(*) from vision_examples)    as examples,
       (select count(*) from storage.objects where bucket_id = 'vision-photos') as photos;
