# Autopilot spec — Milestone 2: pixelAV event data (sparse, memory-bounded)

Source: /path/to/
        dataset_2su_-9_9_48x192_50x12P5_parquets/{test,train}/part.N.parquet  (100 files, 14 GB)

## Measured facts (probe on test/part.0.parquet)
- 5000 events/file, ONE row group, 184,341 columns: 21 truth + 184,320 = 20 time slices × 9216 px.
- Footer ≈ 100 MB (column-chunk metadata) → opening a file costs ~670 MB RSS in pyarrow;
  compressed data only ~41 MB (ZSTD). A browser cannot sensibly read these files directly.
- Pixel column k = t·9216 + iy·48 + ix (verified: centroid corr 0.996 vs truth; transposed ≈ 0).
- Slices are cumulative charge (e⁻); slice 19 total == number_eh_pairs exactly; saturates ~slice 10.
- ~0.2 % of pixels non-zero per slice (30–60 px/event) → sparse storage is ~100× smaller.
- pixelAV frame: top z=100, mid z=50, bottom z=0 (z_viewer = z − 100).
  cotAlpha = n_x/n_z, cotBeta = n_y/n_z;  x-mid = x-entry − 50·cotAlpha (verified).
  Viewer slopes: tan θX = −cotAlpha, tan θY = −cotBeta (|angle| up to ~84°).
- Charge centroid − truth midplane (raw frames) = (−24.7, −22.2) µm, independent of angles/pt/offsets.
- offset1 ↔ y-midplane (r=.98), offset2 ↔ x-midplane (r=.98): integer cluster shifts.

## Design
1. scripts/pixelav_convert.py (pyarrow+numpy, conda env pixelav-env): per file, read truth columns,
   then pixel columns in bounded chunks (default 2304 cols), keep only non-zero entries; one
   subprocess per file (releases the 100 MB-footer memory); writes
   <out>/<split>/<stem>.index.bin (offsets + columnar truth) and <stem>.events.bin (sparse records),
   plus <out>/manifest.json. Incremental (skips up-to-date outputs), --limit/--files/--jobs.
2. src/pixelav.js (pure, tested): binary decoders, dense slice expansion, truth → viewer params
   (origin convention in ONE constant), charge statistics.
3. src/eventSource.js: browser loader — manifest, per-file index LRU, per-event HTTP Range fetch, event LRU.
4. scripts/dev-server.mjs: HTTP Range (206) support + /data/ mount (PIXELAV_DATA env, default ./data/pixelav).
5. UI: mode switch "Illustrative demo" vs "pixelAV simulated event"; event browser (split/file/index,
   prev/next/random), time-slice slider, charge colour map + optional charge bars, event readout.
   Simulated charge and illustrative Gaussian never shown at the same time; labels say which.

## Assumptions (AFK protocol)
1. Python converter (needs pyarrow; pixelav-env has 12.0.1) is acceptable; the browser stays dependency-free. Reversible.
2. Converted cache default ./data/pixelav (git-ignored); full dataset ≈ few GB — convert subsets with --limit. Reversible.
3. Values stored as float32 e⁻ (exact for integers < 2^24); non-zero values kept, including tiny negatives. Reversible.
4. Data-mode start height z0 defaults to 150 µm above the top (display only; truth fixes the line). Reversible.
5. ROI in data mode still uses the top-impact pixel (same rule as demo). Reversible.

## Pending decision → .omc/autopilot/decisions-pending.md (pixelAV origin convention)
