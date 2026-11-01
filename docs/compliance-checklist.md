# Compliance checklist — against the Official Rules (waiver page) and the organizers' Discord answers (Oct 26 – Nov 1)

Checked Nov 2, 2026. ✓ = verified; ☐ = to do on submission day.

## Eligibility and timing
- ✓ Approved participant, Indie Developer track; solo; team name on the form: «Saad Mansour · SOLANG».
- ✓ Building started after the kickoff ended (Oct 26, 12:24 PM ET): first commit Oct 26, 21:58 Cairo (14:58 ET). Git history proves it.
- ✓ No prior codebase; nothing pre-hackathon was copied in. Pre-existing = the factory and its paper QC sheet (stated in the video's first caption and in the README).
- ☐ Submit before Nov 4, 9:00 PM ET (Nov 5, 4:00 AM Cairo). Plan: Tue Nov 3.
- ☐ No pushes to the repo after the deadline (the repo as it stands at the deadline is what is judged).

## Models
- ✓ Every model called at runtime is a Meta model: SAM 3.1 and Muse Spark 1.3 via the Meta Model API. No other model, hosted or local. Verified by grep over the station, shared pipeline and Worker.
- ✓ Open-source dependencies labelled in the README: `@meta-sam/parser` (Meta, vendored unmodified), supabase-js; dev-only: sharp, imageio-ffmpeg.
- ✓ Meta's models do real work (every inspection: ~7 SAM calls, 20–40 Spark calls).

## Video
- ✓ Under 3:00 (2:41). Edited footage, waiting sped up, no mocked results.
- ✓ Opens with one line on what existed before and what was built this week.
- ✓ Understandable in English: English captions throughout; the spoken Arabic is subtitled sentence by sentence.
- ✓ Shows the working end-to-end flow with the live model calls visible (the tablet's status line changes during the run; the «N Spark · M SAM» line after it) and, briefly, where each Meta model is used (the nine-step card).
- ✓ Mostly real screen footage of the product running; one 10-second explanatory card.
- ✓ No faces (hands only), no worker names on screen, no licensed characters or third-party brands on the garments (SOLANG's own designs), no money amounts (a goal percentage only).
- ✓ A human presents: the co-founder's own voice at the start, during the verdicts and the tape measurement, and at the end.
- ☐ Upload as YouTube **Unlisted**; open the link from another phone before submitting.

## Repository
- ✓ Public on GitHub. License: all rights reserved, judging permitted (no license is required by the rules).
- ✓ README states which Meta models are used and where each runs; setup instructions for running locally and for deploying; `.dev.vars.example` and `station/config.example.js` show how to add a key; no key committed (`meta_key.txt`, `.dev.vars`, `supabase_demo.txt` are git-ignored; the Worker holds the key as a secret).
- ✓ Judges can run it without a key through the hosted demo (the Worker carries the key, per-IP daily cap, 90 s per call); recorded sample runs are in `dev/out/annotated/`.
- ✓ A fresh clone was tested on Nov 2: station served, proxy reaches the Meta API with a key, secrets answer 404.
- ✓ Results are from the database and reproducible: `node dev/accuracy.mjs` → `docs/accuracy-2026-11-02.md`.

## Submission form
- ☐ Project name, team name, track, theme, tagline, short and long descriptions: `docs/submission.md`.
- ☐ Links: live station, repo, video (Unlisted). Check all three open in a private browser window.
- ☐ «Tools used» answered honestly if asked (Meta Model API, Cloudflare, Supabase, Claude Code as the engineering assistant).
- ☐ X post link: optional (Most Viral bonus only); leave empty unless a post is made.
- ☐ Credits: the $150 Meta API credit claim form (Discord «unknown» channel, ask @CV) if not yet claimed.

## Privacy and conduct
- ✓ No personal data in the repo or the video (inspector names in the demo database are first names typed by the co-founder; the public demo database holds factory photos of garments only).
- ✓ Rules allow the organizers to use the submission in marketing; no confidentiality is expected (acknowledged).
- ☐ After Nov 9: make the repository private; later rotate the Meta key and the Supabase key.
