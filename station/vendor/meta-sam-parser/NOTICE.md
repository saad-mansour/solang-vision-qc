# NOTICE — vendored `@meta-sam/parser`

This folder contains the published `dist/` JavaScript of the npm package **`@meta-sam/parser` version 0.1.0**
("Streaming SAM 3 segmentation parser for Responses API events"), copied **unmodified** from the npm registry
on **2026-10-26**, together with the package's `README.md` and `LICENSE`.

- Upstream repository: <https://github.com/meta-models/meta-sam> (package directory `typescript/packages/parser`)
- What was copied: every `dist/*.js` file, byte-for-byte (`coco-rle.js`, `errors.js`, `index.js`, `mask-codec.js`,
  `mask-conversion.js`, `object-prompt.js`, `segmentation.js`, `stream.js`, `svg-path.js`, `types.js`).
  The TypeScript declaration files (`*.d.ts`) were not copied because the station is plain JavaScript.
- Why it is vendored: the station page is plain ES modules with no bundler and no `npm install`, so the browser
  imports `./vendor/meta-sam-parser/index.js` directly.
- What it is used for: parsing SAM 3.1 responses (`parseImageStream`, `recordsOfKind`) and decoding the
  `one_bit` masks (`decodeMaskToRaster`) inside `shared/pipeline.js` (garment mask → silhouette measurement).

## License

The files in this folder are distributed under Meta's **SAM License**, reproduced in full in the
[`LICENSE`](./LICENSE) file next to this notice. They are **not** covered by the MIT license that applies to the
rest of this repository (see the repository root `LICENSE`).
