# pixelAV simulated events in the viewer

The viewer can show real **pixelAV simulated** events instead of the geometric demo:
- the truth straight track,
- the collected charge per pixel (electrons), on the pads and as bars,
- the charge's evolution over the 20 time slices,
- a 2D top-view pixel map of the charge, with markers for the surface impact, midplane crossing, exit and charge centroid.

Source dataset used during development:

```
/path/to/
  dataset_2su_-9_9_48x192_50x12P5_parquets/{test,train}/part.N.parquet   (100 files, 14 GB)
```

## Quick start

```bash
conda activate pixelav-env                      # any Python ≥ 3.9 with pyarrow + numpy
# convert a couple of files first (≈ 15 s and ≈ 1 GB RAM per file):
npm run convert:pixelav -- /path/to/dataset_2su_-9_9_48x192_50x12P5_parquets --split test --limit 2
# or everything (≈ 1.5 GB output; --jobs N uses ≈ 1 GB RAM per worker):
npm run convert:pixelav -- /path/to/dataset_2su_-9_9_48x192_50x12P5_parquets --jobs 4
npm run dev                                  # serves ./data/pixelav at /data/pixelav/
```

Open http://127.0.0.1:5173/ and choose **Data source → pixelAV simulated events**.
You can also link straight to an event: `http://127.0.0.1:5173/?mode=data&file=0&event=42`.

The converter writes to `data/pixelav/` by default (git-ignored). It is incremental: unchanged files are skipped.
- To write elsewhere, use `--out DIR`.
- To serve another folder, run `PIXELAV_DATA=DIR npm run dev`.

## Why convert, and how memory stays bounded

Each source file holds 5000 events in **one row group**, as **184,341 columns**: 21 truth columns plus 20 time slices × 9216 pixels.
- The Parquet footer alone is about 100 MB, so opening a file costs about 0.7 GB of RAM.
- Reading even one event touches every column chunk.

A browser can't do this sensibly. The charge is very sparse, though: about 0.2 % of pixels are non-zero, typically 30–60 pixels per slice. So:

| Step | What is read | Peak memory |
|---|---|---|
| Convert (once) | One file per worker process. Truth columns first, then the pixel columns in chunks of 2304 columns, each reduced to its non-zero entries immediately. The worker exits after each file, which frees the footer memory. | ≈ 1.1 GB per worker (measured) |
| Browse | `manifest.json` (a few KB), then one file's index (≈ 0.9 MB: offsets and truth), then **one event per HTTP Range request (≈ 3–5 KB)** | Tiny. LRU caches keep 4 indexes and 64 events. |

Full dataset (100 files, 499,743 events): converted in **7.6 min with `--jobs 4`**, peak **1.1 GB RSS per worker**, giving **1.5 GB of sparse data** (from 14 GB of Parquet).

Measured on `test/part.0.parquet`: 143 MB of Parquet became 14.8 MB of sparse events plus a 0.9 MB index, in 13 s. Conversion is **exact for the integer charges** (essentially all values). Charges are stored as float32, so the rare non-integer values, such as −0.1 e⁻ (≈ 0.04 % of non-zero entries), carry about 1e-7 relative rounding. `scripts/test_pixelav_convert.py` checks decoded slices against the Parquet values cast to float32.

The dev server streams files and answers single `Range` requests with `206 Partial Content`. If a server ignores Range, the loader still works but downloads the whole events file, and `pixelSensorDebug.dataStats.fullFileFallbacks` counts it.

## File format (`pixelav-sparse-v1`)

All values are little-endian.

- `manifest.json`: geometry, `truthColumns`, `slices`, and the file list with split, name, events and paths. It also records each file's QA residual (below).
- `<split>/<stem>.index.bin`, in order:
  - `"PXAVIDX1"`
  - `u32 nEvents`, `u32 nTruth`
  - `f64[nEvents+1]` byte offsets
  - `f64[nTruth][nEvents]` truth values, column-major (booleans stored as 0/1)
- `<split>/<stem>.events.bin`: concatenated records. Each record is:
  - `u32 event`, `u16 nSlices`, `u16 0`
  - then, for each slice: `u32 count`, `u16[count]` pixel indices (plus one `u16` of padding if `count` is odd), `f32[count]` electrons.
  - `count = 0xFFFFFFFF` means "identical to the previous slice". Charge saturates after about slice 10, so the late slices cost 4 bytes each.

Pixel index: `p = iy·48 + ix`, and the source column is `t·9216 + p`. This was verified on the data: the charge centroid correlates with truth at r = 0.996, while the transposed layout gives r ≈ 0. So the indices are the viewer's zero-based (ix, iy) with no transpose.

## Coordinate mapping (pixelAV → viewer)

| pixelAV | Viewer |
|---|---|
| top surface `z = 100`, midplane `50`, bottom `0` | `z − 100` → 0 / −50 / −100 |
| `cotAlpha = n_x/n_z`, `cotBeta = n_y/n_z` (n_z < 0, moving toward −z) | `tan θX = −cotAlpha`, `tan θY = −cotBeta` |
| `x-entry`, `y-entry` at the top surface | the line's top crossing |
| `(x, y) = (0, 0)` | **centre of pixel (23, 95)** = viewer (−25, −6.25) µm, set in `PIXELAV_ORIGIN` in `src/pixelav.js` |

All of these are covered by `tests/pixelav.test.js`, which uses real events. For example, the drawn line passes through the truth `x/y-midplane` to within 1e-6 µm.

**Origin convention: please confirm.** On test/part.0, the charge centroid minus the truth midplane, measured relative to the array centre, is (−24.7, −22.2) µm. It does not depend on cotα, cotβ, pT or the offsets, and it is the same in all 100 files: x from −25.8 to −24.3 µm, y from −22.4 to −22.0 µm (`qaCentroidMinusTruthMidplaneUm` in the manifest, measured relative to the array centre). Taking the origin at the centre of pixel (23, 95) removes the x part exactly, since 25 µm is half the 50 µm pitch. It leaves a constant ≈ −16 µm shift in y, which looks like Lorentz drift, and the viewer deliberately does **not** remove it. The UI shows "centroid − truth mid" for every event. To change the convention, edit the single constant `PIXELAV_ORIGIN`.

**Readout face.** The charge is drawn on the entry face, which is the viewer's top (z = 0) and pixelAV z = 100. The data support this. For steep tracks (|cotα| > 5, 800 events), the charge collected in the first time slice has its centroid at 0.31 of the way along the track from the entry face, while the final charge sits at 0.50. So the charge produced near the entry face reaches the pixels first, which puts the implants on that face. Please confirm with the pixelAV configuration.

Data angles reach about ±84° (|cotα| up to about 9.8). The ±75° input limit applies only to the demo inputs.

## What is simulated and what is not

- **Simulated (pixelAV):** per-pixel collected charge in electrons, cumulative over 20 time slices, and the truth track parameters.
- **Display only:**
  - the colour map (log scale up to the event's maximum pixel),
  - the bar heights (linear in charge, with the event's maximum shown as 400 µm of display height; this height is not a z coordinate),
  - the Z exaggeration,
  - the start height above the sensor (`z0`, which only moves the start point along the truth line).
- **Demo mode** has no pixel response at all (the illustrative Gaussian was removed in v0.4.0).
- **Not interpreted:** columns such as `pt`, `y-local`, `offset1/2` and `*_atEdge` are shown as stored. From the data, `offset1` tracks y-midplane and `offset2` tracks x-midplane (r ≈ 0.98).

## Tests

```bash
npm test                                   # JS: decoder, mapping, loader, Range, server (uses tests/fixtures/pixelav)
npm run test:converter                     # Python: synthetic round trip
PIXELAV_SOURCE=/path/to/dataset_... npm run test:converter   # + float32-exact check vs real parquet, refreshes the fixture
```
