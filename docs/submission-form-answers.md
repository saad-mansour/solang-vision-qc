# Submission form — ready to paste, field by field (Nov 2, 2026)

Form: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit — deadline Nov 4, 9:00 PM ET (Nov 5, 4:00 AM Cairo).
Copy each block exactly. The survey answers at the end are suggestions; they are Saad's opinion to confirm or change.

---

## 1 · Team Name
```
Saad Mansour · SOLANG
```

## 2 · Team Members
Saad Mansour (already listed). Nothing to add.

## 3 · Which track are you submitting to?
**Indie Developer Track**

## 4 · Which problem statement did you build towards?
**Build for Your World**

## 5 · X post link (Most Viral)
Leave empty.

## 6 · Project Description
```
SOLANG Vision QC — a second pair of eyes on the final-inspection table of a children's-wear factory in Cairo.

The problem, firsthand: every garment passes a human final inspection before packing. After a few hours the eye gets tired, small defects slip through, and the order comes back from the customer with shipping paid both ways. Our own estimate is that roughly 15% of orders come back with a defect involved (no audited figure — our shop platform does not report returns); the goal is to bring that under 5%.

What it is: an ordinary phone on a stand above the inspection table and a tablet in front of the quality inspector — one link, nothing to install, in the inspector's own language (Arabic; English is one tap away). One tap on the tablet: the phone shoots at full resolution, SAM 3.1 finds the garment, Muse Spark inspects it tile by tile, re-checks every candidate magnified with the inspector's past verdicts as examples, looks at prints and cuffs up close, compares the two sleeves and the overall look against a reference piece. The inspector sees circles on the photo with a reason, confirms or rejects each one, marks what the camera missed, names who sewed it and decides pass / repair / reject. Her verdicts are stored as labelled crops and ride along in the next inspection of the same product — the system suggests, the inspector decides, and it learns from her.

Built from zero during the hackathon (Oct 26 – Nov 4). Pre-existing: only the factory and its paper QC sheet. Used on the real table from day four: 38 inspections, 70 spots shown to the inspector, 38 confirmed and 32 rejected (precision 54%), 10 misses she marked (recall 79%); loose threads are the strongest type (84%), stains the weakest (32%); about 70 s per piece on the factory Wi-Fi and about $0.18 per piece. Every number, every miss and the sleeve-length check next to tape measurements are in the README.

Live demo (no key needed, three bundled factory photos to try): https://solang-vision-qc.saadmansour.workers.dev/station/
```

## 7 · Public GitHub Repository
```
https://github.com/saad-mansour/solang-vision-qc
```

## 8 · 3-Minute Demo Video
```
https://youtu.be/8AhQ_bW44q0
```

## 9 · Describe your use of Meta products to build the submitted project
```
The only models called at runtime are Meta's, through the Meta Model API (Responses API): SAM 3.1 and Muse Spark 1.3. No other model, hosted or local, is in the loop; the rest is plain JavaScript on the phone and the tablet, a Cloudflare Worker holding the key, and Supabase for the records.

SAM 3.1 does five jobs on every piece: (1) the garment box and a one-bit mask at full resolution, so the table is never inspected and tiles that hold only table are skipped; (2) the two sleeves or legs, for a left-vs-right comparison; (3) the silhouette for the sleeve/leg length measurement — geometry on the mask, no model call; (4) the printed and embroidered designs; (5) the cuffs, collar and hem. Every close-up starts from a SAM box, never from a guess. We use the vendored @meta-sam/parser to decode the mask stream.

Muse Spark 1.3 is used as a cascade rather than one prompt: a high-recall pass over every garment tile, asked twice; a strict verification pass on a 2x then 3x magnified crop of each candidate, with up to six of the inspector's own confirmed / rejected crops of this product attached as labelled references; close-ups of each design and each edge; a left-vs-right comparison with two independent votes; and a whole-garment look against the reference piece of the right side. Reasons are written in the inspector's language. Reasoning effort is low for tiles and verification and medium for the mirror comparison — measured on our pieces, more effort did not buy accuracy on a one-minute budget.

Numbers per piece: about 7 SAM calls and 20–40 Spark calls, 25–70 s depending on the Wi-Fi, about $0.18. The confirmation threshold (0.70) was calibrated from the inspector's verdicts over 47 inspections, and the inspector's examples are what turned a missed seam thread into a catch on the next piece of the same product.
```

## 10 · Why are Meta's models important to your solution?
```
Three reasons, all practical.

SAM 3.1 gives us a pixel-accurate garment mask from a text concept on a 12–24 MP phone photo. That one capability makes the rest possible: inspecting only the garment at full resolution (fewer tiles, no table false alarms), measuring sleeve and leg length from geometry instead of asking a model to estimate it, and cutting designs and cuffs out of the photo at native resolution for the close-ups. We did not have to train a segmentation model for children's wear — the concept prompt was enough on hoodies, blouses and pants.

Muse Spark reads a magnified crop like an inspector would and explains why, in Arabic, and it accepts the inspector's own crops as labelled examples. That is how a factory with no ML team gets a learning loop: the quality inspector's taps become the training signal, with no fine-tuning step between her and the next piece. On our table that loop found on inspection #41 the seam thread it had missed on #40.

Cost and reach: the whole cascade is about $0.18 per piece, which is below the cost of one return of one garment, and the Meta Model API worked for us from Egypt with one key. Everything a judge sees in the video — the circles, the reasons, the length flag, the design and cuff close-ups — is the output of these two models on real garments, with a human deciding at the end.
```

## 11 · Feedback from your experience using partner technologies (Fireworks, Modal, Baseten)
```
We did not use Fireworks, Modal or Baseten in the submitted build (everything runs through the Meta Model API). We attended the Fireworks workshop on Oct 30; its reasoning-effort sweep matched what we measured on our garments and informed our choice of low effort for the tile and verification passes. Fine-tuning Muse Glimmer on the inspector's verdicts (Fireworks offers Glimmer training) is the next step on our roadmap once the verdicts are in the hundreds.
```

## 12 · How likely are you to build with Meta Model API?
**Very likely** — it is in daily use on our table now.

## 13 · Overall opinion of Meta Model API
**Very favorable** (or **Somewhat favorable** if you want to be stricter — your call).

## 14 · Permission checkbox
Tick it. The rules require it and the waiver already granted the same rights.

## 15 · Recommend the Meta Model API to another developer (0–5)
**4**

## 16 · Recommend Muse Code (0–5)
We did not use Muse Code. If the question is required, choose **3** (no opinion); if a "did not use" option appears, choose that.

## 17 · Biggest obstacle
**Something else (please specify)**:
```
Results vary between identical runs at low reasoning effort (a defect found in 2 of 3 runs of the same photo), so we built verification layers around the model; and on the factory Wi-Fi the uploads, not the models, set the time per piece.
```
(If no text box appears, choose **Slow responses**.)

## 18 · Compared with other AI models for the same kind of work
**We haven't used other models for this kind of work**

## 19 · When choosing an AI model or coding tool, what matters most?
**Quality of the answers and code**. Specify box (if shown):
```
Consistent answers on the same input, and a magnified-crop reading we can trust enough to put in front of a quality inspector.
```

## 20 · Hardest thing about switching
**Our product is tuned to our current model's behavior and prompts**

## 21 · What would most likely stop you from using Meta's models in production?
**Price or unpredictable costs** — at thousands of pieces a month, per-piece cost and a hard spending cap matter to a factory.

---
Before pressing Submit: open the video link and the repo link in a private browser window; make sure the track says Indie and the problem statement says Build for Your World. After Submit, screenshot the confirmation.
