# 3D Pixel Sensor / Particle Trajectory Simulator

An interactive browser application for visualizing a charged particle traveling toward and through a **48 × 192 silicon pixel sensor**. The project is based on the earlier custom single-file prototype and the reference sensor-geometry sketch included under `assets/`.

![2D view (default): the whole 48 × 192 array with surface, midplane and exit markers](assets/preview-2d.png)

![3D WebGL view](assets/preview-3d.png)

![Focus on the impact pixel](assets/preview-3d-focus.png)

> **Important:** The ray trajectory, plane crossings, volume entry/exit and per-pixel path lengths are **geometric** calculations of a straight line. The only pixel charge shown is **pixelAV simulated** output, loaded from converted events; the earlier illustrative Gaussian (v0.4.0) and geometric demo source were removed.
>
> The main view is rendered with **Three.js r187 (WebGL)**, vendored under `vendor/three/` (MIT). The original 2D-canvas projection is kept as an automatic fallback when WebGL is unavailable, or on request with `?renderer=2d`. The first screenshot of the old prototype is `assets/preview.png`.

## Get started

Prerequisite: **Node.js 20 or newer** and a WebGL-capable browser. There is **no `npm install`** and no build step: Three.js is vendored as plain ES modules in `vendor/three/` and loaded through an import map in `index.html`, so the app also works **offline** (handy for talks).

```bash
cd pixel-sensor-simulator
npm run dev
```

Open **http://127.0.0.1:5173/** in your browser.

Run the geometry tests:

```bash
npm test
```

Open `http://127.0.0.1:5173/?renderer=2d` to force the original 2D-canvas renderer.

The original offline prototype is preserved as [`legacy/original-single-file.html`](legacy/original-single-file.html), which can be opened directly without running a server. The modular app uses ES modules, so it **must** be served over HTTP by the dev server instead of opening `index.html` as a `file://` URL.

## pixelAV simulated events

The viewer can also show **real pixelAV simulated events**: the truth track plus collected charge per pixel, over 20 time slices. To use it:

1. Convert the Parquet dataset once into a compact sparse format: `npm run convert:pixelav -- <dataset dir>`. This needs Python with pyarrow, for example `conda activate pixelav-env`.
2. Run `npm run dev` and open the viewer: it loads the first event automatically.

The browser then fetches **one event per HTTP Range request** (about 4 KB) and never loads a whole file. pixelAV is the only data source; without converted data the viewer says so and shows no track. See **[docs/PIXELAV_DATA.md](docs/PIXELAV_DATA.md)** for the format, the memory strategy, the coordinate mapping, and the origin convention that still needs confirming.

![pixelAV simulated event](assets/preview-pixelav.png)

## What works today

**Layout.** The viewport header holds the view switch (**2D** | **3D**), the options of the view shown and **Save PNG**. The side panel goes from the model to the display: **Data** (pixelAV file, event, time slice), **Track** (the event's truth start point and angles), **Show** (what is drawn, in both views; only **Grid and central axes** is on by default: **Trajectory** outside or inside the sensor, **Crossing points** at the surface, midplane and exit, **Pixels** grid and those crossed by the track), then **3D scene** (midplane sheet, charge bars, text labels and camera) in the 3D view only. The surface, midplane and exit use the same names and colours in the toggles, legend, labels and readout.

**3D view (Three.js / WebGL; `?view=3d`)**

- Volumetric, translucent 2400 × 2400 × 100 µm silicon slab; top surface carries the 48 × 192 pixel pads (one texel per pixel) and grid lines, with major lines every 16 pixels. Backside plane at z = −100 µm and an optional dashed midplane at z = −50 µm.
- Orientation aids: a physical **+X / +Y / +Z** axis triad, `col 0 / col 47` and `row 0 / row 191` labels at the array edges, and dimension labels. These make an accidental X/Y transpose easy to spot.
- **Orbit** (drag), **pan** (right-drag or shift-drag), and **zoom** (wheel or pinch), with damping. Zoom goes down to single 50 × 12.5 µm pixels. The orbit and elevation sliders and the keyboard (arrow keys, `+`/`−`, space to play) stay in sync with the mouse. Elevation goes to −89°, so you can look at the exit from below.
- View presets: **Top**, **Side X–Z**, **Side Y–Z**, **Focus impact**, and **Reset camera**. The camera refits automatically when the trajectory changes, unless you have panned.
- Animated particle with glow and a trail. The part of the path inside silicon is drawn brighter. As the particle passes each plane, its marker and the pixel at that crossing appear:
  - **surface** (z = 0; cyan ring, cell outline, and a translucent 50 × 12.5 × 100 µm pixel column),
  - **midplane** (z = −50 µm; blue),
  - **exit** (z = −100 µm; orange).
  Crossings outside the sensor footprint are drawn grey and labelled “outside sensor”.
- **Pixels crossed by the track (geometric)**: the pixels that the in-silicon segment passes through, marked with a thin red border so the charge colour stays readable.
- Side entry/exit through the slab's side faces is marked and labelled separately. It is **never** counted as a top-surface HIT.
- Loop playback, timeline scrubbing, and **Save PNG** of the 3D scene (the HTML labels are not included in the PNG).

**2D view** (the default)

- A top view of all 48 × 192 pixels at true aspect: the 2.4 × 2.4 mm footprint fills a square plot, so each pixel appears 50 × 12.5 µm. Every pixel boundary is drawn, and the central axes (x = 0 and y = 0 µm) are highlighted. +x right, +y up, zero-based indices.
- **Axis units**: **µm** (origin at the sensor centre) or **pixels counted from the sensor centre** (x −24 to 24, y −96 to 96, ticks on pixel boundaries). Pixel addresses in labels and readouts stay zero-based (x 0–47, y 0–191). `?units=px` opens the map in pixel units.
- Optional markers, each toggled on its own, for the **top-surface impact (z = 0)**, the **midplane crossing (z = −50 µm)** and the **exit (z = −100 µm)**. Each marker is a crosshair at the crossing point plus an outline of its pixel and a label such as `surface · px (17, 99)`. Crossings outside the footprint are drawn hollow and labelled "outside sensor". During the animation each marker appears when the particle reaches its plane.
- The projected track (dashed above the surface, bright inside the silicon), the pixels it crosses and the pixel grid follow the same overlay toggles as the 3D view. Side entry and side exit points are marked separately.
- **Playback bar**: the **Particle** and **Charge** sliders sit together under the view, joined by a **chain** button. Closed (default): Play, Restart and either slider move particle and charge together, stepping the 20 time slices while the particle crosses the silicon, with no charge before impact. This is a display mapping, not a physical time axis. Open: they move independently, and **Charge vs time** plays the slices alone.
- **Threshold |q|**: pixels with |charge| at or below this value are not drawn, in 2D or 3D, for negative and positive charge alike. Σ q, net charge, max pixel and the colour scale are unchanged, and hovering a hidden pixel still shows its charge.
- Pixels are coloured by the pixelAV simulated charge of the selected time slice, including negative charge (present in time slices 0–10). The legend below the map shows the event's signed log scale in e⁻: rose for negative, viridis for positive.
- The area shown is the **Full sensor** (default) or **Zoom to track** (framing the crossings and the charged pixels). The **mouse wheel** zooms about the cursor, from the full sensor down to a single pixel width; either button returns to its framing. When zoomed in, **drag** to move the map; it stops at the sensor's edges. Hover over a pixel to see its index, its position and, in data mode, its charge. **Save PNG** exports the map.

**Readouts and panels**

- **Track crossings**: surface, midplane and exit, each with its position and zero-based `(x, y)` pixel; top-surface **HIT/MISS**; silicon volume entry face → exit face; the 3D chord length in µm and the count of pixel columns crossed.

## Physical geometry (µm)

| Property | Value |
|---|---:|
| Pixels across X | 48 |
| Pixels along Y | 192 |
| X pitch | 50 µm |
| Y pitch | 12.5 µm |
| Active width X | 2400 µm (2.4 mm) |
| Active width Y | 2400 µm (2.4 mm) |
| Thickness Z | 100 µm |
| Top, midplane, bottom | z = 0, −50, −100 µm |
| Pixel addressing | Zero-based X: 0–47, Y: 0–191 |

X and Y coordinates are measured relative to the **center of the sensor**: the sensitive footprint is `[-1200, 1200) × [-1200, 1200) µm²`. A particle starts above the sensor (`z0 > 0`) and moves downward toward negative Z.

Direction angles are **two independent slope angles**, not the usual spherical polar/azimuthal angles:

```text
x(z) = x0 + (z0 - z) * tan(thetaX)
y(z) = y0 + (z0 - z) * tan(thetaY)
```

The **Z exaggeration** slider affects the picture only, never the geometry or pixel address. In the 3D view it is applied in one place, `src/sceneTransform.js`, which maps physical µm to scene units as `(x, z·stretch, −y)·0.01`. That mapping is a proper rotation with no mirroring, and the tests check it.

**HIT** still means the ray crosses the **top surface** inside the footprint. A separate, tested slab-method function (`intersectVolume`) reports entry and exit through any face, including the sides. The UI shows that result in its own readout row and labels; it does not change HIT.

## Project layout

```text
pixel-sensor-simulator/
├── index.html                       Main UI (+ import map for vendored Three.js)
├── src/
│   ├── geometry.js                  SOURCE OF TRUTH: constants, ray math, pixel mapping, ROI windows,
│   │                                volume intersection, traversed pixels (pure JS, no DOM)
│   ├── sceneTransform.js            Display-only physical→scene mapping, camera angle helpers (pure JS)
│   ├── renderer3d.js                Three.js volumetric renderer (draws only what geometry.js returns)
│   ├── renderer.js                  Legacy 2D-canvas renderer (fallback / ?renderer=2d)
│   ├── pixelMap2d.js                2D top-view pixel map: layout, markers, drawing (pure layout, tested)
│   ├── pixelav.js                   pixelAV binary decoding + truth→viewer mapping (pure, tested)
│   ├── eventSource.js               Range-request event loader with LRU caches
│   ├── dataPanel.js                 Data-source UI: event browser, time slices, event readout
│   ├── chargeColors.js              Display-only log colour map for simulated charge
│   ├── presets.js                   Example trajectories used by the geometry tests
│   ├── main.js                      UI state, controls, animation, renderer selection
│   └── styles.css                   UI styling
├── tests/
│   ├── geometry.test.js             Original geometry regression tests
│   ├── volume-roi.test.js           ROI, animation, volume intersection, traversal, scene transform
│   ├── pixelav.test.js              Decoder, mapping and loader on real-event fixture
│   ├── devserver.test.js            Range parsing, path safety
│   ├── chargeColors.test.js         Colour map
│   ├── pixelMap2d.test.js           2D map layout, picking, markers, label placement
│   └── fixtures/pixelav/            6 real events written by the converter test
├── vendor/three/                    Three.js r187 (MIT), unmodified: core, OrbitControls, CSS2DRenderer
├── scripts/dev-server.mjs           Dependency-free streaming HTTP server (Range/206, /data/pixelav mount)
├── scripts/pixelav_convert.py       Parquet → sparse event converter (pyarrow, bounded memory)
├── scripts/test_pixelav_convert.py  Converter tests (+ bit-exact check vs real data)
├── scripts/qa-browser.mjs           Headless-Chrome UI check over DevTools (npm run qa:browser)
├── data/pixelav/                    Converted events (git-ignored; created by the converter)
├── assets/                          Reference drawing and screenshots
├── docs/                            PROJECT_SPEC.md, PIXELAV_DATA.md, HANDOVER_CLAUDE.md, CLAUDE_START_PROMPT.md (historical)
├── legacy/original-single-file.html Working offline original prototype
├── CLAUDE.md                        Instructions for Claude Code
└── package.json
```

### Upgrading Three.js

The vendored files are copied verbatim from the npm package (`npm pack three@<version>`): `build/three.module.js`, `build/three.core.js`, `examples/jsm/controls/OrbitControls.js` → `addons/controls/`, and `examples/jsm/renderers/CSS2DRenderer.js` → `addons/renderers/`. Replace all four together, then update `vendor/three/README.txt`.

## Continue development in Claude Code

Start Claude Code in the project folder (`claude`). It picks up `CLAUDE.md`, which holds the project rules, automatically.

**Taking over the project?** Read **[`docs/HANDOVER_CLAUDE.md`](docs/HANDOVER_CLAUDE.md)**. It covers the current state, the open decisions, how to use oh-my-claudecode (the `autopilot` workflow that built milestones 1 and 2), and how to verify an agent's changes, including a headless browser check (`npm run qa:browser`). `docs/CLAUDE_START_PROMPT.md` is the original milestone-1 prompt and is kept for history only.

## Still illustrative or not yet implemented

- The only charge shown anywhere is pixelAV simulated charge.
- No energy deposition, electron–hole pair generation, drift, diffusion, induced signal, threshold or noise. Per-pixel path lengths are pure geometry and are **not** a proxy for collected charge.
- Straight line only: no magnetic field, multiple scattering, delta rays, or energy loss.
- The display Z stretch distorts the visual angle of the track. Use ×1 to see true proportions.

## Suggested future improvements

1. *Partly done (v0.4.0):* hovering over a pixel in the 2D view shows its index, position and charge. Still open: path length, and picking in the 3D view.
2. *Done (v0.3.0):* pixelAV events. Still open: filtering and sorting events by truth (cotα, cotβ, pT), and drawing the charge along depth (z) when per-depth data is available.
3. Show several tracks per event and step through event sequences.
4. Export annotated images, including labels, and video frames for talks.

Do **not** add a made-up pixel response presented as charge, and do **not** change the detector dimensions or axis conventions without updating the specification and tests.
