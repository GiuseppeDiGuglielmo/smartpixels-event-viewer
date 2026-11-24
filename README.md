# SmartPixels Event Viewer

Interactive 2D and 3D viewer for **PixelAV-simulated smart-pixel events**. It shows how a charged particle crosses a 48 × 192 silicon pixel sensor (50 × 12.5 µm pixels, 100 µm thick), with each event's truth track and the charge collected per pixel.

This project **displays** PixelAV output. It does not run or replace PixelAV.

![The viewer's 2D view showing one PixelAV event](assets/preview-pixelav.png)

![The 3D view of the same sensor](assets/preview-3d.png)

## Quick start

You need **Node.js 20 or newer** (22 recommended), **git** and a browser with WebGL 2. There is no `npm install` and no build step.

```bash
git clone https://github.com/GiuseppeDiGuglielmo/smartpixels-event-viewer.git
cd smartpixels-event-viewer
npm test          # optional: checks your setup
npm run sample    # starts the viewer with 6 example events
```

Open **http://127.0.0.1:5173/**. Press `Ctrl+C` in the terminal to stop the server.

The example events are real PixelAV events stored in the repository. To browse the full dataset, see **[Use the full dataset](#use-the-full-dataset)**.

## Use the full dataset

The dataset (about 14 GB of Parquet) is not in the repository. Convert it once into a compact format, which needs Python with `pyarrow` and `numpy`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

npm run convert:pixelav -- /path/to/dataset_2su_-9_9_48x192_50x12P5_parquets --jobs 4
npm run dev
```

This writes about 1.5 GB to `data/pixelav/` (git-ignored) in roughly 8 minutes. To try it on two files first, use `--split test --limit 2`. **[docs/SETUP.md](docs/SETUP.md)** has the complete steps and troubleshooting.

## What you can do

- **Browse events** one at a time; each is fetched on demand (about 4 KB).
- **Inspect the charge** in a true-aspect 2D map with zoom, drag and per-pixel hover, or in 3D as bars on the sensor.
- **Follow time**: play the particle and the 20 charge time slices together, or unlock them with the chain button.
- **Choose what is drawn**: the trajectory inside and outside the sensor, the surface, midplane and exit crossings, the pixels crossed, and a charge threshold.
- **Read axes** in µm or in pixels from the sensor centre, and **save** the current view as a PNG.

The **[User guide](docs/USER_GUIDE.md)** explains every control.

## Commands

| Command | What it does |
|---|---|
| `npm run sample` | Start the viewer with the 6 example events |
| `npm run dev` | Start the viewer with converted data from `data/pixelav/` |
| `npm test` | Run the JavaScript tests (no dataset needed) |
| `npm run convert:pixelav -- <dir>` | Convert the Parquet dataset (Python) |
| `npm run test:converter` | Test the converter (Python) |
| `npm run qa:browser -- <url> <outdir>` | Headless browser check with screenshots (Chrome, Node 22+) |

## Documentation

| Document | For |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Installing, running, the full dataset, remote machines, troubleshooting |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Using the viewer |
| [docs/PIXELAV_DATA.md](docs/PIXELAV_DATA.md) | Data format, memory strategy, coordinate mapping, open conventions |
| [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) | Detector geometry and requirements |
| [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md) | Physics conventions that still need confirming |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [docs/HANDOVER_CLAUDE.md](docs/HANDOVER_CLAUDE.md) | Developing with Claude Code and, optionally, oh-my-claudecode |

## Detector geometry

| Property | Value |
|---|---:|
| Pixels across X | 48 |
| Pixels along Y | 192 |
| X pitch | 50 µm |
| Y pitch | 12.5 µm |
| Active area | 2400 × 2400 µm |
| Thickness Z | 100 µm |
| Top, midplane, bottom | z = 0, −50, −100 µm |
| Pixel addresses | Zero-based, X 0–47, Y 0–191 |

X and Y are measured from the **centre of the sensor**: the footprint is `[-1200, 1200) × [-1200, 1200) µm²`. A particle starts above the sensor (`z0 > 0`) and moves toward negative Z. Its direction is given by two independent slope angles:

```text
x(z) = x0 + (z0 - z) * tan(thetaX)
y(z) = y0 + (z0 - z) * tan(thetaY)
```

**HIT** means the track crosses the **top surface** inside the footprint. Entry or exit through a side face is reported separately. The 3D **Z** stretch changes the picture only, never the geometry or a pixel address.

## What this is not

- **The charge is PixelAV output.** The viewer does not simulate energy deposition, drift, diffusion, induced signal or noise, and adds no pixel response of its own.
- **The track is a straight line**, with no magnetic field, multiple scattering, delta rays or energy loss.
- **Locking the particle to the charge is a display mapping**, not a physical time axis.
- **Three PixelAV conventions are still open** (origin, readout face and a y offset of about −16 µm). See [docs/PIXELAV_DATA.md](docs/PIXELAV_DATA.md).

## Project layout

```text
smartpixels-event-viewer/
├── index.html                Page and import map for the vendored Three.js
├── src/
│   ├── geometry.js           Source of truth: constants, track math, pixel mapping (no DOM)
│   ├── sceneTransform.js     Physical → 3D scene mapping and camera presets
│   ├── pixelMap2d.js         2D view: layout, axes, markers, drawing
│   ├── renderer3d.js         3D view (Three.js)
│   ├── renderer.js           Fallback canvas renderer (no WebGL, or ?renderer=2d)
│   ├── pixelav.js            PixelAV decoding, truth mapping, charge statistics
│   ├── eventSource.js        One-event-at-a-time loader (HTTP Range, LRU caches)
│   ├── dataPanel.js          Event browser, time slices, readouts
│   ├── chargeColors.js       Signed log colour scale
│   ├── presets.js            Example tracks used by the tests
│   ├── main.js               UI state, controls, animation
│   └── styles.css            Styling and design tokens
├── scripts/
│   ├── dev-server.mjs        Dependency-free server with HTTP Range support
│   ├── pixelav_convert.py    Parquet → sparse event converter
│   ├── test_pixelav_convert.py
│   └── qa-browser.mjs        Headless browser check
├── tests/                    Node tests and 6 real example events (fixtures/pixelav)
├── vendor/three/             Three.js r187 (MIT), unmodified
├── docs/                     Documentation
├── assets/                   Screenshots and the reference drawing
├── legacy/                   Original single-file prototype
├── requirements.txt          Python packages for the converter
└── CLAUDE.md                 Project rules for Claude Code
```

## Contributing

Contributions are welcome, with or without AI coding agents. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Run `npm test` after every change; a change that only alters screenshots does not validate the geometry. Project rules, including the detector constants and axis conventions, are in [CLAUDE.md](CLAUDE.md). Do not add a made-up pixel response, and do not change the detector dimensions or axis conventions without updating the specification and tests.

**Upgrading Three.js:** The vendored files are copied verbatim from the npm package (`npm pack three@<version>`): `build/three.module.js`, `build/three.core.js`, `examples/jsm/controls/OrbitControls.js` → `addons/controls/`, and `examples/jsm/renderers/CSS2DRenderer.js` → `addons/renderers/`. Replace all four together, then update `vendor/three/README.txt`.

## References

- **PixelAV:** M. Swartz, "CMS pixel simulations", *Nucl. Instrum. Meth. A* **511** (2003) 88–91, [doi:10.1016/S0168-9002(03)01757-1](https://doi.org/10.1016/S0168-9002(03)01757-1). See also [CERN Document Server record 687440](https://cds.cern.ch/record/687440?ln=en).
- **Datasets:** D. Shekar, M. Swartz, J. Dickinson, M. A. Wadud, *Smartpixels co-design datasets*, Zenodo (2025), [doi:10.5281/zenodo.17180303](https://doi.org/10.5281/zenodo.17180303), CC BY 4.0.
- **Smart pixels:** J. Yoo et al., "Smart pixel sensors: towards on-sensor filtering of pixel clusters with deep learning", *Mach. Learn.: Sci. Technol.* **5** (2024), [doi:10.1088/2632-2153/ad6a00](https://doi.org/10.1088/2632-2153/ad6a00).

How these sources relate to the data shown here is in [docs/PIXELAV_DATA.md](docs/PIXELAV_DATA.md#published-datasets-and-references).

## License

[MIT](LICENSE). Three.js is also MIT licensed.
