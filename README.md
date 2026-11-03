# VectorLab: Image to SVG Vectorizer

VectorLab converts PNG, JPG and WebP images into **genuine, editable SVG vector graphics** directly in the browser. It traces images with [VTracer](https://github.com/visioncortex/vtracer) compiled to WebAssembly, optimizes the result with [SVGO](https://github.com/svg/svgo), and validates every output before showing it.

The output is always made of real `<path>` geometry (lines and cubic Bézier curves). VectorLab never embeds the original bitmap, never renames a raster to `.svg`, and never fakes conversion with CSS or canvas drawing. Every image is processed locally: there is no backend, no upload, and no tracking.

## Features

- **Real raster-to-vector tracing** with VTracer 1.0.0-alpha.4 (Rust → WebAssembly), run in a Web Worker so the page stays responsive.
- **Upload**: drag and drop, file browser, or paste from the clipboard. Validates type (by file signature, not just extension), size, dimensions and corruption.
- **Presets**: Logo, Illustration, Photograph and Black & White, each mapped to concrete engine parameters (see [Conversion settings](#conversion-settings)).
- **Controls**: colour mode, colour count, detail level, gradient bands, B&W threshold (fixed or adaptive), noise reduction, path smoothing, background handling, curve-fitting mode, corner threshold, coordinate precision, colour precision, layering mode and processing size.
- **Preview workspace**: side-by-side view or a draggable comparison slider; synchronised zoom (wheel, pinch, buttons) and pan (drag, arrow keys); fit and 1:1; checkerboard, white or dark backgrounds; fullscreen. The SVG is re-rendered as vectors at every zoom level.
- **Validation**: well-formed XML, valid `viewBox`, real geometry present, no embedded raster data, no scripts or external references, and a check that the exact downloadable bytes reopen and render.
- **Statistics**: original and traced dimensions, SVG dimensions and viewBox, raw and optimized sizes, path count, fill colour count and conversion time.
- **Export**: download the optimized SVG (`my-logo.png` → `my-logo.svg`), download the unoptimized SVG (`my-logo-unoptimized.svg`), copy the SVG code, or view the source.
- **Status and errors**: real stage reporting (no fake percentages), cancellation, duplicate-job prevention, and readable error messages. Technical details are logged to the console.

## Technology stack

| Area | Technology |
| --- | --- |
| Build tool | Vite 8 |
| Application | Vanilla JavaScript (ES modules) |
| Styling | SCSS (Dart Sass, `@use` modules) |
| Vectorization | VTracer 1.0.0-alpha.4 via `wasm-bindgen` (`--target web`) |
| Optimization | SVGO 4 (`svgo/browser`) |
| Concurrency | Module Web Worker |
| Image decoding | `createImageBitmap` + Canvas 2D |

## Architecture

```
main thread                                         Web Worker
───────────                                         ──────────
image-loader      validate + decode (createImageBitmap)
image-preprocessor.rasterize   resize → RGBA pixels ──transfer──▶ vectorization-worker
                                                                   ├─ image-preprocessor.preprocess
                                                                   │   (background, grayscale, gradient bands,
                                                                   │    alpha handling, keying pad)
                                                                   ├─ VTracer WASM: vectorize_rgba()
                                                                   ├─ svg-optimizer.finalizeSvg (viewBox, size)
                                                                   └─ svg-optimizer.optimizeSvg (SVGO)
svg-validator     validate, sanitize, measure, reopen-check ◀──── raw SVG + optimized SVG
preview / comparison   render via <img src="blob:…svg">
download          blob downloads, clipboard
```

- The worker and the WASM engine load **lazily** on the first conversion.
- Cancelling, a worker crash or an engine error **terminates the worker**, so a corrupted WASM instance never serves another job. The next conversion starts a fresh one.
- SVGs are rendered through `<img>` with blob URLs. Browsers never execute scripts or load external resources in SVG images, and the validator also strips anything unsafe before display.

## Folder structure

```
image-to-svg/
├── index.html                  Page markup (semantic, accessible)
├── vite.config.js              Relative base, ES-module worker, WASM as asset
├── package.json
├── netlify.toml                Static build settings for Netlify
├── public/favicon.svg
├── samples/                    Synthetic test images (generated, safe to delete)
├── scripts/
│   ├── build-wasm.mjs          Rebuilds the VTracer WASM from official source
│   ├── generate-samples.mjs    Renders the test PNGs (no dependencies)
│   └── verify-engine.mjs       Proves the WASM build emits real vector paths
└── src/
    ├── wasm/vtracer/           Generated wasm-bindgen output (committed)
    │   ├── vtracer_wasm.js
    │   └── vtracer_wasm_bg.wasm
    ├── js/
    │   ├── main.js             App controller: state, UI wiring, workflow
    │   ├── image-loader.js     File validation and decoding
    │   ├── image-preprocessor.js  Resize/upscale, alpha, background, grayscale, bands
    │   ├── palette.js          Palette detection (CIELAB), blend-aware snapping, edge majority filter
    │   ├── settings.js         Defaults, presets, UI → engine option mapping
    │   ├── vectorizer.js       Worker lifecycle, jobs, cancel, error mapping
    │   ├── vectorization-worker.js  Preprocess → VTracer → SVGO
    │   ├── svg-optimizer.js    Root rewrite (viewBox) and SVGO config
    │   ├── svg-validator.js    Validation, sanitizing, statistics, reopen test
    │   ├── preview.js          Shared zoom/pan viewer
    │   ├── comparison.js       Side-by-side / slider modes
    │   ├── download.js         File naming, downloads, clipboard
    │   └── utils.js
    └── scss/                   _variables, _reset, _typography, _utilities,
                                _buttons, _header, _hero, _upload, _editor,
                                _comparison, _controls, _sections, main.scss
```

## Getting started (fresh clone)

Requirements: **Node.js 20.19+** (or 22.12+) and npm. The compiled WebAssembly engine is committed in `src/wasm/vtracer/`, so Rust is **not** needed to run or build the app.

```bash
git clone <your-repo-url> vectorlab
cd vectorlab
npm install
npm run dev
```

Open the URL Vite prints (normally http://localhost:5173).

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally (http://localhost:4173) |
| `npm run test:engine` | Trace the synthetic samples with the bundled WASM in Node and check for real paths |
| `node scripts/verify-engine.mjs photo.jpg` | Trace your own files with the engine (VTracer decodes them) |
| `npm run samples` | Regenerate the PNGs in `samples/` |
| `npm run build:wasm` | Rebuild the WASM engine from VTracer source (needs Rust, see below) |

## Vectorization engine

VectorLab uses the **official VTracer source** (`visioncortex/vtracer`, commit `e71343f`, crate version `1.0.0-alpha.4`).

How the browser integration works:

1. VTracer's repository has three web-related pieces. The legacy `webapp/` crate is tied to the DOM (it reads pixels from a `<canvas>` by element id and writes into an `<svg>` element), so it cannot run in a Worker. The npm package `@visioncortex/vtracer` is built with `wasm-pack --target nodejs`, which uses Node's `fs`/`require` loader and does not work in browsers.
2. That npm package is built from VTracer's `nodejs/` crate, a plain `wasm-bindgen` library with no Node or DOM APIs. It exports `vectorize_rgba(rgba, width, height, options)` and `vectorize_bytes(bytes, options)`, both returning an SVG string.
3. VectorLab compiles that same crate for `wasm32-unknown-unknown` and generates bindings with `wasm-bindgen --target web`. The result is an ES module whose `init()` fetches the `.wasm` file, so it runs in browsers and module Workers.
4. The worker imports the module plus `vtracer_wasm_bg.wasm?url`. Vite emits the WASM as a hashed asset in `dist/assets/` and rewrites the URL, so the same code works in dev and production with no hard-coded paths.

### Rebuilding the WASM (optional)

You only need this to upgrade VTracer. It requires:

- `git`
- Rust (stable) with the WASM target: `rustup target add wasm32-unknown-unknown`
- `wasm-bindgen-cli` **matching the crate's wasm-bindgen version** (0.2.130 at the pinned commit): `cargo install wasm-bindgen-cli --version 0.2.130 --locked`

```bash
npm run build:wasm
```

The script clones VTracer into `.vtracer-src/` (gitignored), checks out the pinned commit, builds `nodejs/` in release mode and writes the bindings to `src/wasm/vtracer/`. To upgrade, change `VTRACER_COMMIT` in `scripts/build-wasm.mjs`, then run `npm run test:engine`.

> **Windows note.** The default `x86_64-pc-windows-msvc` Rust host needs the Visual Studio C++ Build Tools for build scripts. Without them, use the GNU host (`rustup toolchain install stable-x86_64-pc-windows-gnu`) and run `VTRACER_TOOLCHAIN=stable-x86_64-pc-windows-gnu npm run build:wasm`. Building `wasm-bindgen-cli` itself on the GNU host also needs `dlltool` (MinGW binutils) and a C compiler for `ring`; with MSVC Build Tools installed, the plain `cargo install` works.

## Supported input

| | |
| --- | --- |
| Formats | PNG, JPG/JPEG, WebP (checked by file signature) |
| Max file size | 30 MB |
| Max dimensions | 12,000 px per side and 50 megapixels |
| Min dimensions | 8 px per side |

Images larger than the chosen **processing size** are scaled down before tracing. The SVG's `width`/`height` keep the original dimensions, and its `viewBox` uses traced-pixel coordinates, so the vector scales back exactly.

## Conversion settings

Every control changes the actual conversion. Settings marked *preprocessing* are pixel operations VectorLab performs before VTracer, because the engine has no equivalent option.

| Control | Implementation |
| --- | --- |
| Colour mode: Full colour | VTracer `clustering: "color-cluster"` |
| Colour mode: Grayscale | *preprocessing* (Rec. 709 luminance), then colour clustering |
| Colour mode: Black & white | VTracer `clustering: "bw"` + `binaryThreshold` / `adaptive` (Bradley–Roth) |
| Colour count | *preprocessing*: every pixel is snapped to a palette before tracing (`palette.js`). **Auto** detects the artwork's real colours and rejects anti-aliasing blends; 2–32 fixes the count; far left = unlimited (no snapping) |
| Detail level 1–10 | VTracer `layerDifference` 128 → 4 (colour gap between gradient layers) |
| Gradient bands | *preprocessing*: posterize to N levels per channel (see limitations) |
| Noise reduction | VTracer `filterSpeckle` (side length in px; area = square) |
| Path smoothing | VTracer `simplify` tolerance in px (spline mode only) |
| Curve fitting | VTracer `mode`: `spline` (Béziers), `polygon`, `pixel` |
| Corner threshold | VTracer `cornerThreshold` in degrees (spline mode only) |
| Coordinate precision | VTracer `pathPrecision` (decimal places); SVGO never rounds below it |
| Colour precision | VTracer `colorPrecision` (significant bits per channel) |
| Layering | VTracer `hierarchical`: `stacked` or `cutout` (gap-free mosaic) |
| Processing size | *preprocessing*: high-quality canvas downscale |
| Upscale small images | *preprocessing*: images under 2400 px are enlarged (up to 6×) so 1–3 px details survive; noise reduction is scaled with it so it still means original-image pixels |
| Edge refinement | *preprocessing* (needs a colour count or B&W): Off / Low / Medium / High. A Gaussian blur after palette detection irons out stair-steps and JPEG ripples, then a majority filter after snapping removes notches, bumps and stray pixels. Higher is smoother but rounds tiny points |
| Background: Keep | *preprocessing*: alpha snapped to 0/255, so VTracer's keying discards transparent pixels |
| Background: Remove | *preprocessing*: flood fill from the edges removes the dominant border colour (tolerance 42) |
| Background: White / Custom | *preprocessing*: alpha flattened onto the colour. In B&W mode a vector `<rect>` is added behind the shapes |

### Presets

| Preset | Key parameters |
| --- | --- |
| Logo | colour, **Auto palette**, **upscale on**, **edge refinement Low**, **cutout layering**, speckle 4, smoothing 2 px, 2048 px; output fills snapped to the exact palette colours |
| Illustration | colour, unlimited colours, detail 7, precision 7, 16 gradient bands, speckle 4, 2048 px |
| Photograph | VTracer's own photo preset: speckle 10, precision 8, layer difference 48, corner 180°, 1024 px |
| Black & White | binary clustering, threshold 128, speckle 4, smoothing 1 px, upscale on, edge refinement Low, 2048 px |

## Testing performed

All tests below were actually run during development.

**Engine (Node, `npm run test:engine`).** All 4 synthetic samples pass: real `<path>` elements and no raster data. A 3840 × 2400 photograph traced at full resolution gave 254 paths (1.0 MB) in about 47 s.

**Browser (Chrome-based, dev server, real worker + WASM + SVGO):**

| Test | Preset | Result |
| --- | --- | --- |
| B&W logo (480²) | Black & White | 2 paths, 1.3 KB → 1.1 KB optimized, ~0.4 s |
| Multicolour logo (600×400) | Logo | 7 paths, 7 colours, 2.1 KB → 1.8 KB |
| Transparent PNG icon (512²) | Logo | 5 paths, no background shape (transparency kept) |
| Detailed illustration with gradients (960×640) | Illustration | 211 paths, 105 colours, 102 KB → 55.5 KB (−45%) |
| Real photograph (3840×2400 JPEG, traced at 1024×640) | Photograph | 184 paths, 183 colours, 161 KB → 136 KB, ~2.5 s |
| WebP upload (browser-encoded) | Logo | converted; 129 paths (lossy-compression artefacts become small shapes) |
| Background remove / grayscale / B&W + white bg | — | white backdrop removed; grayscale palette; vector `<rect>` added |

Every result passed all validation checks: well-formed XML, valid viewBox, geometry present, no raster, no unsafe content, and the downloadable file reopens.

**Logo accuracy.** The SVG is rendered back to pixels at the original size and compared with the source. "Bad pixels" are those off by more than 40 levels per channel. The Logo preset was reworked (palette snapping, upscaling, cutout layering) after a real 367 px logo traced inaccurately:

| Image | Before | After |
| --- | --- | --- |
| Real logo, 367 px PNG | 2.03% bad, mean error 2.48 | **0.39%** bad, mean error **0.81** |
| Same logo at 184 px | 3.78% bad | **0.85%** bad |
| Same logo as JPEG (quality 60) | 1.82% bad, 657 paths | **0.42%** bad, 85 paths |
| Multicolour logo sample | 0.77% bad | **0.05%** bad |
| Transparent icon sample | 0.96% bad | **0.22%** bad |
| Real logo, 819 px JPEG (heavy compression) | ragged edges, 22 colours | clean edges, exactly 3 colours, 18 paths |

The reworked output opened in Illustrator with editable paths and 0 raster items.

**Error handling:** non-image data named `.png`, GIF, a truncated PNG, and an empty file each produced a clear message and kept the current image. Cancelling a full-resolution 4K trace stopped the worker immediately, and the next conversion worked.

**Vector editor:** the optimized and unoptimized SVGs for all four samples, plus the 4K photo, were opened in **Adobe Illustrator 2022 (26.0.3)** through its scripting interface. All opened with editable path items, **0 raster items**, **0 placed items**, and correct artboard sizes. Inkscape, Figma and CorelDRAW were not available and were **not** tested.

**Privacy:** the network log during conversions showed only `localhost` and local `blob:` requests.

## Performance notes

- Tracing time grows with pixel count *and* image complexity. Logos take milliseconds; a 1024 px photo takes about 2–3 s; full-resolution 4K photos can take close to a minute.
- Processing runs in a Worker, so the UI stays responsive. Cancel at any time.
- The decoded bitmap is kept once for re-conversions. Pixel buffers are transferred to the worker (not copied), and object URLs are revoked when replaced.
- SVGO uses multipass only for SVGs under 2 MB to keep optimization time bounded.

## Browser compatibility

Requires module Web Workers, WebAssembly, `createImageBitmap`, `<dialog>` and CSS `:has()`. Current Chrome/Edge, Firefox and Safari 16.4+ support these. Development testing used a Chromium-based browser only.

## Known limitations

- **Edge refinement vs. sharp points.** Refinement rounds features smaller than about one original pixel (e.g. the tips of a tiny zig-zag). Use Off for clean, pixel-perfect PNGs and Medium/High for blurry or JPEG sources.
- **Logo conversion time.** Upscaling and refinement make logo conversions take roughly 2–5 seconds.
- **Logo palette.** Auto palette (Logo preset) snaps to at most 16 detected colours, so gradients inside a logo become flat areas. Use the Illustration preset or set Colour count to unlimited for gradient artwork.
- **Smooth gradients.** SVG paths from VTracer have flat fills, and VTracer's clustering merges perfectly smooth gradients into one flat region. Use *Gradient bands* (on by default in the Illustration preset) to trace them as steps.
- **Photographs** become posterized, stylised artwork rather than photo-realistic vectors. Raising detail or processing size increases fidelity but can produce multi-megabyte SVGs that are slow in editors.
- **Lossy JPEG/WebP artefacts** become small extra shapes; raise *Noise reduction* to suppress them.
- **Semi-transparent pixels** are snapped to fully opaque or fully transparent, because VTracer's keying only understands binary alpha.
- **Background removal** handles uniform backgrounds connected to the image edges, not complex scenes.
- **Progress** shows real stages and elapsed time, not a percentage: the WASM entry point does not report incremental progress.
- Clipboard copy needs a secure context (`https://` or `localhost`).

## Future improvements

- Expose VTracer's incremental `Session` API for real percentage progress and re-tracing without re-segmenting.
- Watershed clustering mode (supported by the engine, not yet exposed).
- Per-colour layer list with toggles, and colour palette editing.
- Batch conversion and ZIP export.
- Optional PNG/PDF export of the vector result.

## Deploying (Netlify)

The app is a static site, and `dist/` contains everything, including the WASM asset.

1. Push the project to GitHub (`node_modules/` and `dist/` are gitignored):
   ```bash
   git init
   git add .
   git commit -m "VectorLab"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In Netlify, choose **Add new site → Import an existing project**, then select the repository.
3. Build settings are read from the included `netlify.toml`: build command `npm run build`, publish directory `dist`, Node 22. Vite 8 requires Node 20.19+.
4. Deploy. Hashed files in `/assets/` get long-term caching headers, and `.wasm` files are served as `application/wasm`.

## Licences

VectorLab code: ISC. VTracer: MIT OR Apache-2.0 (visioncortex). SVGO: MIT.
