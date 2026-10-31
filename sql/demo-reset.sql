-- SOLANG Vision QC — wipe the DEMO inspections to start clean (run in the Supabase SQL editor of the demo project only).
-- Removes every inspection, its findings and the learning examples (the inspector's verdict crops). Orders, workers and the
-- schema stay. Ids keep counting (photo folders are named by id, so old folders in the bucket can never be reused). There is no undo.
--
-- The photos in the vision-photos bucket are NOT deleted here: Supabase refuses direct deletes on storage.objects
-- («Direct deletion from storage tables is not allowed. Use the Storage API instead», storage.protect_delete). Delete them
-- from the dashboard instead: Storage → vision-photos → select the date folders (and references/) → Delete. Leaving them is
-- harmless (orphaned files, some storage space).

truncate table vision_findings, vision_examples, vision_inspections cascade;

-- check: all three counts must be 0
select (select count(*) from vision_inspections) as inspections,
       (select count(*) from vision_findings)    as findings,
       (select count(*) from vision_examples)    as examples;
