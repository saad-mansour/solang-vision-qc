# Submission text — SOLANG Vision QC (Indie Developer track)

Ready to paste into https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit on Tue Nov 3 / Wed Nov 4 (deadline Nov 4, 9:00 PM ET = Nov 5, 4:00 AM Cairo). Fill the two `{…}` placeholders (video link, form-specific answers) on the day. No faces, no worker names, no money amounts — percentages only.

## Project name
SOLANG Vision QC

## Team name (solo)
Saad Mansour · SOLANG

## Track
Indie Developer

## Theme
Build for Your World (a co-founder solving a problem on his own factory floor) — and it touches Push the Frontier: manufacturing, a vision system on a physical inspection table that learns from the inspector.

## Tagline (one line)
A second pair of eyes on the final-inspection table of a children's-wear factory: a phone above the table, SAM 3.1 and Muse Spark find the loose thread, the hole and the open seam, and the quality inspector decides.

## Short description (~150 words)
SOLANG is a children's-wear factory in Cairo. Every garment passes a human final inspection before packing; after a few hours the eye gets tired, small defects slip through, and the order comes back from the customer with shipping paid both ways. Vision QC puts an ordinary phone on a stand above the inspection table and a tablet in front of the inspector — one link, nothing to install, in the inspector's own language. One tap: the phone shoots at full resolution, SAM 3.1 finds the garment, Muse Spark inspects it tile by tile, re-checks every candidate magnified with the inspector's past verdicts as examples, looks at prints and cuffs up close, compares the two sleeves and the overall look against a reference. The inspector confirms or rejects each circle, marks what the camera missed, names who sewed it and decides; her verdicts teach the next inspection of the same product. Built and used on the real table during the hackathon: 38 inspections, 70 spots shown, 38 confirmed, 10 misses she marked — precision 54 %, recall 79 %.

## Long description (by judging criteria)

### Impact (30 %)
- Problem known firsthand: the builder is a co-founder of the factory. Final inspection is the last gate before the customer; most returns involve a small defect that a tired eye missed. The factory's own estimate is that roughly 15 % of orders come back with a defect involved (no audited figure — the shop platform does not report returns); the goal stated in the video is to bring that under 5 %.
- Who benefits: the inspector (a second eye that does not tire, and never overrules her), the factory (fewer returns, a photo-and-verdict record per piece tied to the order, the line and the worker), the customer.
- It is a workflow, not a slide: an iPhone and an iPad on the factory Wi-Fi, 38 inspections in the database with photo, findings, verdicts, timings and cost, done by the co-founder himself over four days on the table.

### Use of Meta AI tooling (25 %)
- The only models called at runtime are Meta's, through the Meta Model API: **SAM 3.1** and **Muse Spark 1.3**.
- **SAM 3.1** does five jobs: the garment box and mask (so the table is never inspected and the tiles that hold only table are skipped), the sleeve/leg boxes for the left-vs-right comparison, the silhouette for the length measurement (geometry on the mask, no model call), the printed and embroidered designs, and the cuffs, collar and hem for the seam close-ups — every close-up starts from a SAM box, never a guess.
- **Muse Spark** is a cascade, not one prompt: a high-recall pass over every tile, twice; a strict verification pass on a 2× then 3× magnified crop, with up to six of the inspector's own confirmed / rejected crops for this product as labelled references; close-ups of designs and edges; a left-vs-right comparison with two independent votes; a whole-garment look against the reference piece; reasons written in the inspector's language.
- Beyond a basic integration: the inspector's verdicts are read back into the model's judgement on the next piece (a missed seam thread on inspection #40, marked by the inspector, was found on #41 with her two examples); the confirmation threshold was calibrated from her verdicts (confirmations at 60–69 % were real 2 times in 10, so they are dropped now); SAM's mask gives a length measurement the model is not asked to estimate.

### Technical depth & execution (20 %)
- Vanilla JS, no build step; a Cloudflare Worker proxies the Meta API with the key held server-side, a per-IP daily cap and a 90-second cap per call; Supabase holds inspections, findings, examples and references — findings are append-only, a verdict never overwrites the model's output.
- Two devices talk over a realtime channel: the tablet drives the phone (shoot, empty-table photo, reference photos), with a pairing code and signed requests; WebRTC live view on the local network; a stillness detector so the phone shoots by itself when the piece lies still; guards for the things a factory day actually does — a black camera frame after the phone sat in the background, a slow upload, a garment cut off by the frame edge, a product the inspector rejected the mirror check on twice.
- Measured, not claimed: the README carries the results table from the database (precision by level and type, time per piece, cost per piece ≈ $0.18), the misses by name, and the sleeve-length check next to tape measurements on four pieces.
- Honest about limits: stains are the weak type (32 % precision); the length number is lay-dependent; the hood seam is not covered by the edge close-ups yet; factory Wi-Fi, not the models, sets the time per piece.

### Demo (25 %)
- Live station (no key needed): https://solang-vision-qc.saadmansour.workers.dev/station/ — pick a language, choose «One device», and either point a phone camera at a garment or press one of the three «🧪 Try a sample» buttons (factory photos with known defects) to watch a full inspection with the live model calls on screen.
- Video ({YouTube unlisted link}, 2:41): the real table, three pieces, the inspector's own words subtitled — an olive hoodie with two seam threads caught and judged, a pink blouse with a seeded 4 cm sleeve difference caught by the silhouette check and confirmed with the tape, and a clean printed hoodie that passes with zero spots.
- Repo: https://github.com/saad-mansour/solang-vision-qc — README with the nine steps, the results, the verification layers, run-locally and deploy instructions, and a day-by-day build log.

## What existed before the event / what was built during it
Everything in the repository was built from zero between Oct 26 (after the kickoff) and Nov 4. Pre-existing: the factory, its paper QC sheet, and the founder's knowledge of the defects. No prior codebase was used.

## Tools used (if the form asks)
Meta Model API (SAM 3.1, Muse Spark 1.3), the vendored `@meta-sam/parser`, Cloudflare Workers, Supabase. The coding was done with Claude Code as the engineering assistant, directed by the co-founder; every commit carries the co-author line. Video cut with ffmpeg.

## Links
- Live: https://solang-vision-qc.saadmansour.workers.dev/station/
- Repo: https://github.com/saad-mansour/solang-vision-qc
- Video: {YouTube unlisted link}
- Numbers: https://github.com/saad-mansour/solang-vision-qc/blob/main/docs/accuracy-2026-11-02.md
