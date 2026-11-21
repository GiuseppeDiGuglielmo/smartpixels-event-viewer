#!/usr/bin/env python3
"""
Convert pixelAV parquet files (one event per row, 20 time slices x 48 x 192
pixel columns + truth columns) into a compact, randomly-accessible sparse
format the browser viewer can fetch one event at a time with HTTP Range.

Why: each source file has ~184k columns. Its parquet footer alone is ~100 MB,
so just opening a file costs ~0.7 GB of RAM, and a single event can't be read
without touching every column chunk. Charge is very sparse (~0.2 % of pixels
non-zero), so the sparse form is ~100x smaller and an event is a few KB.

Memory strategy
  * one worker process per source file (maxtasksperchild=1), so the large
    footer allocation is returned to the OS after every file;
  * truth columns first (21 x N), then pixel columns in bounded chunks
    (--chunk-cols, default 2304 = a quarter of a time slice): a chunk is at
    most N x chunk x 8 bytes (~92 MB for N=5000) and is reduced to its
    non-zero entries immediately;
  * outputs are written with a streaming writer; up-to-date outputs are skipped.

Output (<out>/manifest.json, and per source file <out>/<split>/<stem>.*):
  <stem>.index.bin   little-endian
      8s  magic  b"PXAVIDX1"
      u32 n_events, u32 n_truth
      f64[n_events + 1]       byte offsets of event records in .events.bin
      f64[n_truth][n_events]  truth values, column-major, order = manifest.truthColumns
  <stem>.events.bin  concatenated records, each:
      u32 event index, u16 n_slices, u16 reserved(0)
      for each slice t:  u32 count   (0xFFFFFFFF = identical to slice t-1)
                         u16[count] pixel index p = iy*48 + ix  (+ u16 pad if count is odd)
                         f32[count] charge (electrons, cumulative in time)

Usage (conda env with pyarrow, e.g. `conda activate pixelav-env`):
  python scripts/pixelav_convert.py SRC_DIR [--out data/pixelav] [--split test]
         [--limit 2] [--files test/part.0.parquet ...] [--jobs 1] [--chunk-cols 2304]
"""
from __future__ import annotations

import argparse
import gc
import json
import multiprocessing as mp
import os
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np

PIXELS_X = 48
PIXELS_Y = 192
PIXELS = PIXELS_X * PIXELS_Y  # 9216
INDEX_MAGIC = b"PXAVIDX1"
SAME_AS_PREVIOUS = 0xFFFFFFFF
FORMAT = "pixelav-sparse-v1"


def natural_key(path: Path):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", path.name)]


def classify_columns(names):
    """Split schema names into truth columns and pixel columns (numeric names)."""
    pixel = [n for n in names if n.isdigit()]
    truth = [n for n in names if not n.isdigit() and not n.startswith("__index_level")]
    n_pix = len(pixel)
    if n_pix == 0 or n_pix % PIXELS:
        raise ValueError(f"expected a multiple of {PIXELS} pixel columns, found {n_pix}")
    expected = [str(i) for i in range(n_pix)]
    if sorted(pixel, key=int) != expected:
        raise ValueError("pixel columns are not the contiguous range 0..N-1")
    return truth, n_pix // PIXELS


def read_truth(pf, truth_cols):
    import pyarrow as pa
    import pyarrow.compute as pc_

    table = pf.read(columns=truth_cols)
    out = np.empty((len(truth_cols), table.num_rows), dtype=np.float64)
    for i, name in enumerate(truth_cols):
        col = table.column(name)
        try:
            col = pc_.cast(col, pa.float64())  # bool/int/float → float64; nulls → NaN below
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError) as exc:
            raise ValueError(f"truth column {name!r} is not numeric ({col.type})") from exc
        out[i] = col.combine_chunks().to_numpy(zero_copy_only=False)  # nulls → NaN
    return out


def sparse_pixels(pf, n_events, n_slices, chunk_cols):
    """Return (event, column, value) of all non-zero pixel entries, chunk by chunk."""
    n_cols = n_slices * PIXELS
    ev_parts, col_parts, val_parts = [], [], []
    for start in range(0, n_cols, chunk_cols):
        stop = min(start + chunk_cols, n_cols)
        names = [str(c) for c in range(start, stop)]
        table = pf.read(columns=names, use_threads=True)
        block = np.empty((n_events, stop - start), dtype=np.float64)
        for j in range(stop - start):
            block[:, j] = table.column(j).to_numpy()
        del table
        ev, cc = np.nonzero(block)
        ev_parts.append(ev.astype(np.uint32))
        col_parts.append((cc + start).astype(np.uint32))
        val_parts.append(block[ev, cc].astype(np.float32))
        del block
    ev = np.concatenate(ev_parts)
    col = np.concatenate(col_parts)
    val = np.concatenate(val_parts)
    order = np.lexsort((col, ev))  # by event, then column (= slice-major, pixel-minor)
    return ev[order], col[order], val[order]


def encode_event(event_index, n_slices, cols, vals):
    """Encode one event's sparse entries (cols sorted ascending) into bytes."""
    parts = [struct.pack("<IHH", event_index, n_slices, 0)]
    slice_of = cols // PIXELS
    previous = None
    for t in range(n_slices):
        sel = slice_of == t
        idx = (cols[sel] - t * PIXELS).astype("<u2")
        q = vals[sel].astype("<f4")
        key = (idx.tobytes(), q.tobytes())
        if previous is not None and key == previous:
            parts.append(struct.pack("<I", SAME_AS_PREVIOUS))
            continue
        previous = key
        parts.append(struct.pack("<I", len(idx)))
        parts.append(key[0])
        if len(idx) % 2:
            parts.append(b"\x00\x00")
        parts.append(key[1])
    return b"".join(parts)


def centroid_residual(truth_cols, truth, ev, col, val, n_slices):
    """Mean (charge centroid − truth midplane) in µm with truth taken array-centred (QA only)."""
    try:
        xm = truth[truth_cols.index("x-midplane")]
        ym = truth[truth_cols.index("y-midplane")]
    except ValueError:
        return None
    last = col // PIXELS == n_slices - 1
    e, p, q = ev[last], (col[last] - (n_slices - 1) * PIXELS), np.clip(val[last], 0, None)
    n = truth.shape[1]
    tot = np.bincount(e, q, n)
    ix = p % PIXELS_X
    iy = p // PIXELS_X
    with np.errstate(invalid="ignore", divide="ignore"):
        cx = np.bincount(e, q * ix, n) / tot
        cy = np.bincount(e, q * iy, n) / tot
    ok = (tot > 0) & np.isfinite(xm) & np.isfinite(ym)
    if not ok.any():
        return None
    dx = (-1200 + (cx + 0.5) * 50 - xm)[ok]
    dy = (-1200 + (cy + 0.5) * 12.5 - ym)[ok]
    return {"x": float(dx.mean()), "y": float(dy.mean()), "events": int(ok.sum()),
            "origin": "array centre (raw pixelAV x, y); viewer uses PIXELAV_ORIGIN, see docs"}


def write_text_atomic(path: Path, text: str):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def read_meta(path: Path):
    """Parsed meta.json, or None if missing/unreadable (→ the file is (re)converted / skipped)."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def convert_one(task):
    """Worker entry: never raises, so one bad file cannot abort the whole run."""
    try:
        return _convert_one(task)
    except Exception as exc:  # noqa: BLE001 - reported to the main process
        return {"source": Path(task[0]).name, "error": f"{type(exc).__name__}: {exc}"}


def _convert_one(task):
    src, out_dir, chunk_cols = task
    import pyarrow.parquet as pq  # imported in the worker

    src = Path(src)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / f"{src.stem}.index.bin"
    events_path = out_dir / f"{src.stem}.events.bin"
    meta_path = out_dir / f"{src.stem}.meta.json"
    src_stat = src.stat()
    meta = read_meta(meta_path)
    if meta:
        if (meta.get("sourceSize") == src_stat.st_size and meta.get("sourceMtime") == int(src_stat.st_mtime)
                and index_path.exists() and events_path.exists() and meta.get("format") == FORMAT):
            meta["skipped"] = True
            return meta

    t0 = time.time()
    # meta.json is written last; removing it first means a crash mid-way leaves the
    # file "not converted" rather than pairing a new events.bin with an old index.
    meta_path.unlink(missing_ok=True)
    pf = pq.ParquetFile(str(src))
    truth_cols, n_slices = classify_columns(pf.schema_arrow.names)
    n_events = pf.metadata.num_rows
    truth = read_truth(pf, truth_cols)
    ev, col, val = sparse_pixels(pf, n_events, n_slices, chunk_cols)
    del pf
    gc.collect()

    bounds = np.searchsorted(ev, np.arange(n_events + 1))
    offsets = np.zeros(n_events + 1, dtype="<f8")
    tmp_events = events_path.with_suffix(".bin.tmp")
    with open(tmp_events, "wb") as fh:
        pos = 0
        for i in range(n_events):
            a, b = bounds[i], bounds[i + 1]
            rec = encode_event(i, n_slices, col[a:b], val[a:b])
            offsets[i] = pos
            fh.write(rec)
            pos += len(rec)
        offsets[n_events] = pos
    tmp_index = index_path.with_suffix(".bin.tmp")
    with open(tmp_index, "wb") as fh:
        fh.write(INDEX_MAGIC)
        fh.write(struct.pack("<II", n_events, len(truth_cols)))
        fh.write(offsets.tobytes())
        fh.write(truth.astype("<f8").tobytes())
    os.replace(tmp_events, events_path)
    os.replace(tmp_index, index_path)

    meta = {
        "format": FORMAT,
        "source": src.name,
        "sourceSize": src_stat.st_size,
        "sourceMtime": int(src_stat.st_mtime),
        "events": int(n_events),
        "slices": int(n_slices),
        "truthColumns": truth_cols,
        "nonZeroEntries": int(len(val)),
        "eventsBytes": int(offsets[-1]),
        "indexBytes": index_path.stat().st_size,
        "seconds": round(time.time() - t0, 2),
        "qaCentroidMinusTruthMidplaneUm": centroid_residual(truth_cols, truth, ev, col, val, n_slices),
    }
    write_text_atomic(meta_path, json.dumps(meta, indent=1, allow_nan=False))
    return meta


def build_manifest(out_root: Path, source_root: Path):
    files = []
    truth_cols = None
    slices = None
    for meta_path in sorted(out_root.glob("*/*.meta.json"), key=lambda p: (p.parent.name, natural_key(p))):
        meta = read_meta(meta_path)
        if not meta or meta.get("format") != FORMAT:
            continue
        split = meta_path.parent.name
        stem = meta_path.name[: -len(".meta.json")]
        if not (out_root / split / f"{stem}.index.bin").exists() or not (out_root / split / f"{stem}.events.bin").exists():
            continue  # stale meta whose outputs were deleted
        truth_cols = truth_cols or meta["truthColumns"]
        slices = slices or meta["slices"]
        if meta["truthColumns"] != truth_cols or meta["slices"] != slices:
            raise ValueError(f"{meta_path}: truth columns / slices differ from other files")
        files.append({
            "split": split,
            "name": stem,
            "events": meta["events"],
            "index": f"{split}/{stem}.index.bin",
            "data": f"{split}/{stem}.events.bin",
            "eventsBytes": meta["eventsBytes"],
            "qaCentroidMinusTruthMidplaneUm": meta.get("qaCentroidMinusTruthMidplaneUm"),
        })
    manifest = {
        "format": FORMAT,
        "dataset": source_root.name,
        "source": source_root.name,  # no absolute paths in served files
        "pixelsX": PIXELS_X,
        "pixelsY": PIXELS_Y,
        "pitchX": 50,
        "pitchY": 12.5,
        "slices": slices,
        "pixelIndex": "p = iy*48 + ix  (source column = t*9216 + p)",
        "chargeUnits": "electrons, cumulative over time slices (pixelAV simulation)",
        "truthColumns": truth_cols or [],
        "files": files,
        "createdBy": "scripts/pixelav_convert.py",
    }
    write_text_atomic(out_root / "manifest.json", json.dumps(manifest, indent=1, allow_nan=False))
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="dataset directory containing split folders with *.parquet")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "data" / "pixelav")
    ap.add_argument("--split", action="append", help="split folder(s) to convert (default: all)")
    ap.add_argument("--files", nargs="*", help="explicit files relative to SOURCE (e.g. test/part.0.parquet)")
    ap.add_argument("--limit", type=int, default=0, help="convert at most N files per split (0 = all)")
    ap.add_argument("--jobs", type=int, default=1, help="parallel worker processes (~1 GB RAM each)")
    ap.add_argument("--chunk-cols", type=int, default=2304, help="pixel columns read per chunk")
    ap.add_argument("--manifest-every", type=int, default=5, help="rebuild manifest.json every N converted files")
    args = ap.parse_args(argv)

    source = args.source.resolve()
    if args.files:
        sources = [source / f for f in args.files]
    else:
        splits = args.split or sorted(p.name for p in source.iterdir() if p.is_dir())
        sources = []
        for split in splits:
            found = sorted((source / split).glob("*.parquet"), key=natural_key)
            sources += found[: args.limit] if args.limit else found
    if not sources:
        print("no parquet files selected", file=sys.stderr)
        return 1
    tasks = [(str(s), str(args.out / s.parent.name), args.chunk_cols) for s in sources]
    print(f"converting {len(tasks)} file(s) -> {args.out}  (jobs={args.jobs}, chunk={args.chunk_cols} cols)")
    ctx = mp.get_context("spawn")
    failures = []
    try:
        with ctx.Pool(processes=max(1, args.jobs), maxtasksperchild=1) as pool:
            for i, meta in enumerate(pool.imap_unordered(convert_one, tasks), 1):
                if meta.get("error"):
                    failures.append(meta)
                    print(f"[{i}/{len(tasks)}] {meta['source']}: FAILED {meta['error']}", file=sys.stderr, flush=True)
                    continue
                state = "skip" if meta.get("skipped") else f"{meta['seconds']:.1f}s"
                print(f"[{i}/{len(tasks)}] {meta['source']}: {meta['events']} events, "
                      f"{meta['eventsBytes'] / 1e6:.1f} MB sparse ({state})", flush=True)
                if not meta.get("skipped") and i % max(1, args.manifest_every) == 0:
                    build_manifest(args.out, source)  # make progress visible to the viewer
    finally:
        manifest = build_manifest(args.out, source)  # always, even after failures / Ctrl-C
    total = sum(f["eventsBytes"] for f in manifest["files"])
    print(f"manifest: {len(manifest['files'])} file(s), {total / 1e6:.1f} MB event data")
    if failures:
        print(f"{len(failures)} file(s) failed; re-run to retry them", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
