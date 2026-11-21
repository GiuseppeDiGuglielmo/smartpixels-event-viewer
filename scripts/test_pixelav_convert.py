#!/usr/bin/env python3
"""
Tests for scripts/pixelav_convert.py.

  python scripts/test_pixelav_convert.py            # synthetic round-trip (needs pyarrow, numpy)
  PIXELAV_SOURCE=/path/to/dataset python scripts/test_pixelav_convert.py
                                                    # + float32-exact check against real parquet

Also writes tests/fixtures/pixelav/ (manifest + a tiny 6-event file) used by the
Node tests, so the JS decoder is checked against bytes produced by this script.
"""
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pixelav_convert as pc  # noqa: E402

ROOT = HERE.parent
FIXTURE = ROOT / "tests" / "fixtures" / "pixelav"


def decode_index(path):
    raw = path.read_bytes()
    assert raw[:8] == pc.INDEX_MAGIC
    n, k = struct.unpack_from("<II", raw, 8)
    offsets = np.frombuffer(raw, "<f8", n + 1, 16)
    truth = np.frombuffer(raw, "<f8", n * k, 16 + 8 * (n + 1)).reshape(k, n)
    return offsets, truth


def decode_event(buf, pixels=pc.PIXELS):
    ev, n_slices, _ = struct.unpack_from("<IHH", buf, 0)
    pos = 8
    dense = np.zeros((n_slices, pixels), np.float32)
    for t in range(n_slices):
        (count,) = struct.unpack_from("<I", buf, pos)
        pos += 4
        if count == pc.SAME_AS_PREVIOUS:
            dense[t] = dense[t - 1]
            continue
        idx = np.frombuffer(buf, "<u2", count, pos)
        pos += 2 * count + (2 if count % 2 else 0)
        q = np.frombuffer(buf, "<f4", count, pos)
        pos += 4 * count
        dense[t, idx] = q
    assert pos == len(buf), (pos, len(buf))
    return ev, dense


def write_synthetic(path, n_events=6, n_slices=3, seed=1):
    import pyarrow as pa
    import pyarrow.parquet as pq

    rng = np.random.default_rng(seed)
    pix = np.zeros((n_events, n_slices, pc.PIXELS), np.float64)
    for e in range(n_events):
        if e == 2:
            continue  # an event with no charge at all
        hits = rng.choice(pc.PIXELS, size=5 + e, replace=False)
        final = rng.integers(1, 5000, size=hits.size).astype(np.float64)
        for t in range(n_slices):
            frac = min(1.0, (t + 1) / 2)  # saturates at t = 1 -> slice 2 == slice 1
            pix[e, t, hits] = np.round(final * frac)
        if e == 3:
            pix[e, 0, hits[0]] = -0.1  # tiny negative value as in real data
    cols = {
        "x-entry": rng.normal(0, 300, n_events), "y-entry": rng.normal(0, 50, n_events),
        "z-entry": np.full(n_events, 100.0), "cotAlpha": rng.normal(0, 3, n_events),
        "cotBeta": rng.normal(0, 0.3, n_events), "original_atEdge": rng.random(n_events) > 0.5,
        "offset1": rng.integers(-9, 10, n_events),
    }
    cols["x-midplane"] = cols["x-entry"] - 50 * cols["cotAlpha"]
    cols["y-midplane"] = cols["y-entry"] - 50 * cols["cotBeta"]
    flat = pix.reshape(n_events, -1)
    arrays = {k: pa.array(v) for k, v in cols.items()}
    for c in range(flat.shape[1]):
        arrays[str(c)] = pa.array(flat[:, c])
    pq.write_table(pa.table(arrays), path, row_group_size=n_events)
    return cols, pix


class SyntheticRoundTrip(unittest.TestCase):
    def test_round_trip_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src" / "test"
            src.mkdir(parents=True)
            cols, pix = write_synthetic(src / "part.0.parquet")
            out = Path(tmp) / "out"
            self.assertEqual(pc.main([str(src.parent), "--out", str(out), "--chunk-cols", "1000"]), 0)
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual(manifest["slices"], 3)
            self.assertEqual(manifest["files"][0]["events"], 6)
            names = manifest["truthColumns"]
            offsets, truth = decode_index(out / "test" / "part.0.index.bin")
            data = (out / "test" / "part.0.events.bin").read_bytes()
            for e in range(6):
                ev, dense = decode_event(data[int(offsets[e]):int(offsets[e + 1])])
                self.assertEqual(ev, e)
                np.testing.assert_array_equal(dense, pix[e].astype(np.float32))
            np.testing.assert_allclose(truth[names.index("cotAlpha")], cols["cotAlpha"])
            np.testing.assert_array_equal(truth[names.index("original_atEdge")], cols["original_atEdge"].astype(float))
            # slice 2 == slice 1 is stored as "same as previous"
            rec = data[int(offsets[0]):int(offsets[1])]
            self.assertIn(struct.pack("<I", pc.SAME_AS_PREVIOUS), rec)
            # second run is incremental (skips)
            meta_before = (out / "test" / "part.0.meta.json").read_text()
            pc.main([str(src.parent), "--out", str(out)])
            self.assertEqual(meta_before, (out / "test" / "part.0.meta.json").read_text())

    def test_incremental_reconvert_ordering_stale_and_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src" / "test"
            src.mkdir(parents=True)
            write_synthetic(src / "part.10.parquet", seed=2)
            write_synthetic(src / "part.2.parquet", seed=3)
            (src / "part.7.parquet").write_bytes(b"not a parquet file")  # must fail alone
            out = Path(tmp) / "out"
            self.assertEqual(pc.main([str(src.parent), "--out", str(out)]), 2)  # non-zero: one failure
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual([f["name"] for f in manifest["files"]], ["part.2", "part.10"])  # natural order
            # a changed source is re-converted
            meta_path = out / "test" / "part.2.meta.json"
            before = json.loads(meta_path.read_text())
            write_synthetic(src / "part.2.parquet", n_events=4, seed=9)
            (src / "part.7.parquet").unlink()
            self.assertEqual(pc.main([str(src.parent), "--out", str(out)]), 0)
            after = json.loads(meta_path.read_text())
            self.assertEqual(after["events"], 4)
            self.assertNotEqual(before["sourceSize"], after["sourceSize"])
            # stale meta (outputs deleted) is left out of the manifest; corrupt meta is tolerated
            (out / "test" / "part.10.events.bin").unlink()
            (out / "test" / "part.2.meta.json").write_text("{ truncated")
            manifest = pc.build_manifest(out, src.parent)
            self.assertEqual(manifest["files"], [])
            self.assertEqual(pc.main([str(src.parent), "--out", str(out)]), 0)  # both re-converted
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual([f["name"] for f in manifest["files"]], ["part.2", "part.10"])
            self.assertFalse(list(out.glob("**/*.tmp")), "no temporary files left behind")

    def test_rejects_wrong_pixel_count(self):
        with self.assertRaises(ValueError):
            pc.classify_columns(["x-entry", "0", "1", "2"])


@unittest.skipUnless(os.environ.get("PIXELAV_SOURCE"), "set PIXELAV_SOURCE to check real data")
class RealData(unittest.TestCase):
    def test_first_events_match_parquet_exactly(self):
        import pyarrow.parquet as pq

        source = Path(os.environ["PIXELAV_SOURCE"])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            pc.main([str(source), "--out", str(out), "--files", "test/part.0.parquet"])
            offsets, truth = decode_index(out / "test" / "part.0.index.bin")
            data = (out / "test" / "part.0.events.bin").read_bytes()
            pf = pq.ParquetFile(str(source / "test" / "part.0.parquet"))
            for t in (0, 7, 19):
                names = [str(t * pc.PIXELS + i) for i in range(pc.PIXELS)]
                table = pf.read(columns=names)
                for e in (0, 1, 4999):
                    expected = np.array([table.column(i)[e].as_py() for i in range(pc.PIXELS)], np.float32)
                    _, dense = decode_event(data[int(offsets[e]):int(offsets[e + 1])])
                    np.testing.assert_array_equal(dense[t], expected)
            # write the small cross-language fixture from real events
            write_fixture(out, events=[0, 1, 2, 3, 4, 5])


def write_fixture(converted_root, events):
    """Copy a few converted events into tests/fixtures/pixelav (keeps the original byte format)."""
    manifest = json.loads((converted_root / "manifest.json").read_text())
    offsets, truth = decode_index(converted_root / "test" / "part.0.index.bin")
    data = (converted_root / "test" / "part.0.events.bin").read_bytes()
    (FIXTURE / "test").mkdir(parents=True, exist_ok=True)
    records, new_offsets = [], [0.0]
    for e in events:
        rec = bytearray(data[int(offsets[e]):int(offsets[e + 1])])
        struct.pack_into("<I", rec, 0, len(records))  # renumber 0..n-1
        records.append(bytes(rec))
        new_offsets.append(new_offsets[-1] + len(rec))
    (FIXTURE / "test" / "part.0.events.bin").write_bytes(b"".join(records))
    sub = truth[:, events]
    with open(FIXTURE / "test" / "part.0.index.bin", "wb") as fh:
        fh.write(pc.INDEX_MAGIC)
        fh.write(struct.pack("<II", len(events), sub.shape[0]))
        fh.write(np.asarray(new_offsets, "<f8").tobytes())
        fh.write(np.ascontiguousarray(sub, "<f8").tobytes())
    entry = dict(manifest["files"][0], events=len(events), eventsBytes=int(new_offsets[-1]))
    manifest = dict(manifest, files=[entry], source="(fixture: first events of test/part.0)")
    (FIXTURE / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
