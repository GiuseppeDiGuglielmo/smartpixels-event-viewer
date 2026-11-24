import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SENSOR, traceParticle, pixelAt } from '../src/geometry.js';
import {
  PIXELAV_ORIGIN, SAME_AS_PREVIOUS, validateManifest, decodeIndex, decodeEvent, sliceToDense,
  chargeStats, truthToParticle, truthMidplane, pixelOfIndex,
} from '../src/pixelav.js';
import { createEventSource } from '../src/eventSource.js';

// Fixture written by scripts/test_pixelav_convert.py from the first 6 events of
// test/part.0.parquet (real pixelAV data, original byte format).
const FIX = fileURLToPath(new URL('./fixtures/pixelav/', import.meta.url));
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const manifest = JSON.parse(readFileSync(`${FIX}manifest.json`, 'utf8'));
const indexBuf = toArrayBuffer(readFileSync(`${FIX}test/part.0.index.bin`));
const dataBuf = toArrayBuffer(readFileSync(`${FIX}test/part.0.events.bin`));
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

test('manifest matches the viewer geometry (48 × 192, 50 × 12.5 µm, 20 slices)', () => {
  validateManifest(manifest);
  assert.equal(manifest.slices, 20);
  assert.ok(manifest.truthColumns.includes('cotAlpha'));
  assert.throws(() => validateManifest({ ...manifest, pixelsX: 192, pixelsY: 48 }), /viewer expects/);
  assert.throws(() => validateManifest({ ...manifest, format: 'other' }), /Unsupported/);
});

test('index decodes offsets and truth; event records decode to exactly 20 slices', () => {
  const index = decodeIndex(indexBuf, manifest.truthColumns);
  assert.equal(index.nEvents, 6);
  assert.equal(index.offsets[6], dataBuf.byteLength);
  for (let i = 0; i < index.nEvents; i++) {
    const [a, b] = index.range(i);
    const ev = decodeEvent(dataBuf.slice(a, b));
    assert.equal(ev.eventIndex, i);
    assert.equal(ev.slices.length, 20);
  }
  assert.throws(() => index.range(6), RangeError);
  assert.throws(() => decodeIndex(new ArrayBuffer(16)), /magic/);
});

test('final-slice charge equals number_eh_pairs (cumulative charge, nothing lost in conversion)', () => {
  const index = decodeIndex(indexBuf, manifest.truthColumns);
  for (let i = 0; i < index.nEvents; i++) {
    const [a, b] = index.range(i);
    const { slices } = decodeEvent(dataBuf.slice(a, b));
    const truth = index.truthOf(i);
    const final = slices[19];
    const total = final.charges.reduce((s, q) => s + q, 0);
    close(total, truth.number_eh_pairs, 1.0);
    // charge never decreases over time (cumulative), apart from ~0.1 e noise
    const sums = slices.map((s) => s.charges.reduce((x, q) => x + q, 0));
    for (let t = 1; t < 20; t++) assert.ok(sums[t] >= sums[t - 1] - 1);
  }
});

test('"same as previous" slices share arrays; dense expansion uses p = iy*48 + ix', () => {
  const index = decodeIndex(indexBuf, manifest.truthColumns);
  const [a, b] = index.range(0);
  const { slices } = decodeEvent(dataBuf.slice(a, b));
  assert.equal(slices[19], slices[18], 'saturated late slices are stored once');
  const dense = sliceToDense(slices[19]);
  assert.equal(dense.length, SENSOR.pixelsX * SENSOR.pixelsY);
  const p = slices[19].indices[0];
  assert.equal(dense[p], slices[19].charges[0]);
  assert.deepEqual(pixelOfIndex(48 * 100 + 7), { x: 7, y: 100 });
  // a hand-built record with a repeat marker
  const buf = new ArrayBuffer(8 + 4 + 2 + 2 + 4 + 4);
  const v = new DataView(buf);
  v.setUint32(0, 3, true); v.setUint16(4, 2, true);
  v.setUint32(8, 1, true); v.setUint16(12, 9215, true); v.setFloat32(16, 42, true);
  v.setUint32(20, SAME_AS_PREVIOUS, true);
  const ev = decodeEvent(buf);
  assert.equal(ev.slices[1], ev.slices[0]);
  assert.equal(ev.slices[0].charges[0], 42);
});

test('truth → viewer: line passes through the truth entry (top) and truth midplane', () => {
  const index = decodeIndex(indexBuf, manifest.truthColumns);
  for (let i = 0; i < index.nEvents; i++) {
    const truth = index.truthOf(i);
    const params = truthToParticle(truth);
    const t = traceParticle(params);
    close(t.top.x, truth['x-entry'] + PIXELAV_ORIGIN.x);
    close(t.top.y, truth['y-entry'] + PIXELAV_ORIGIN.y);
    const mid = truthMidplane(truth);
    close(t.mid.x, mid.x, 1e-6);
    close(t.mid.y, mid.y, 1e-6);
    assert.equal(t.hit, true);
    // slopes: travel toward −z with dx/d(−z) = −cotAlpha
    close(Math.tan(params.thetaX * Math.PI / 180), -truth.cotAlpha, 1e-9);
  }
});

test('origin convention: pixelAV (0,0) is the centre of pixel (23, 95)', () => {
  assert.deepEqual(PIXELAV_ORIGIN, { x: -25, y: -6.25 });
  assert.deepEqual(pixelAt(PIXELAV_ORIGIN.x, PIXELAV_ORIGIN.y), { x: 23, y: 95 });
});

test('charge centroid lies near the truth midplane (same pixels; documented residual)', () => {
  const index = decodeIndex(indexBuf, manifest.truthColumns);
  for (let i = 0; i < index.nEvents; i++) {
    const [a, b] = index.range(i);
    const { slices } = decodeEvent(dataBuf.slice(a, b));
    const stats = chargeStats(slices[19]);
    const mid = truthMidplane(index.truthOf(i));
    assert.ok(Math.abs(stats.centroid.x - mid.x) < 3 * SENSOR.pitchX, `x residual ${stats.centroid.x - mid.x}`);
    assert.ok(Math.abs(stats.centroid.y - mid.y) < 5 * SENSOR.pitchY, `y residual ${stats.centroid.y - mid.y}`);
    assert.ok(stats.nAbove > 0 && stats.max > 0);
  }
});

function fixtureFetch(log) {
  return async (url, init = {}) => {
    const path = url.replace(/^.*?fixture\//, '');
    let bytes;
    try { bytes = readFileSync(FIX + path); } catch { return new Response('nope', { status: 404 }); }
    const range = init.headers?.Range;
    log.push({ path, range });
    if (range) {
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range);
      return new Response(bytes.subarray(Number(s), Number(e) + 1), { status: 206 });
    }
    return new Response(bytes, { status: 200 });
  };
}

test('event source fetches the index once and each event by byte range, with LRU caches', async () => {
  const log = [];
  const source = await createEventSource({ baseUrl: 'http://x/fixture', fetchImpl: fixtureFetch(log), maxEvents: 2 });
  assert.equal(source.files().length, 1);
  const e3 = await source.getEvent(0, 3);
  assert.equal(e3.eventIndex, 3);
  assert.equal(e3.slices.length, 20);
  assert.ok(Number.isFinite(e3.truth.cotAlpha));
  await source.getEvent(0, 3); // cached
  await source.getEvent(0, 4);
  await source.getEvent(0, 5); // evicts 3
  await source.getEvent(0, 3); // refetch
  assert.equal(source.stats.indexFetches, 1);
  assert.equal(source.stats.eventFetches, 4);
  assert.deepEqual(source.cacheSizes(), { indexes: 1, events: 2 });
  const eventRequests = log.filter((r) => r.path.endsWith('events.bin'));
  assert.ok(eventRequests.every((r) => /^bytes=\d+-\d+$/.test(r.range)), 'events are always range requests');
  assert.equal(source.stats.fullFileFallbacks, 0);
  await assert.rejects(source.getEvent(0, 99), RangeError);
});

test('event source still works (slower) when a server ignores Range', async () => {
  const plain = async (url) => {
    const path = url.replace(/^.*?fixture\//, '');
    return new Response(readFileSync(FIX + path), { status: 200 });
  };
  const source = await createEventSource({ baseUrl: 'http://x/fixture/', fetchImpl: plain });
  const ev = await source.getEvent(0, 2);
  assert.equal(ev.eventIndex, 2);
  assert.equal(source.stats.fullFileFallbacks, 1);
});

test('missing data directory gives a clear error', async () => {
  await assert.rejects(
    createEventSource({ baseUrl: 'http://x/none/', fetchImpl: async () => new Response('', { status: 404 }) }),
    /No converted pixelAV data/,
  );
});

test('defensive decoding: unsafe manifest paths, corrupt offsets and oversized counts are rejected', () => {
  const bad = (patch) => ({ ...manifest, files: [{ ...manifest.files[0], ...patch }] });
  assert.throws(() => validateManifest(bad({ data: '../../etc/x.events.bin' })), /unsafe path/);
  assert.throws(() => validateManifest(bad({ index: 'http://evil/x.index.bin' })), /unsafe path/);
  assert.throws(() => validateManifest(bad({ events: -1 })), /event count/);
  const idx = indexBuf.slice(0);
  new DataView(idx).setFloat64(16 + 8 * 2, 1.5, true); // non-integer offset
  assert.throws(() => decodeIndex(idx, manifest.truthColumns), /bad offset/);
  const rec = new ArrayBuffer(16);
  const v = new DataView(rec);
  v.setUint16(4, 1, true); v.setUint32(8, 0xFFFFFFFE, true); // absurd count
  assert.throws(() => decodeEvent(rec), /exceeds the record/);
});

test('locked charge: no charge before entry, slices spread over the silicon, round trip', async () => {
  const { lockedSlice, lockedProgress } = await import('../src/pixelav.js');
  assert.equal(lockedSlice(0.59, 0.6, 1, 20), null);
  assert.equal(lockedSlice(0.6, 0.6, 1, 20), 0);
  assert.equal(lockedSlice(1, 0.6, 1, 20), 19);
  assert.equal(lockedSlice(1, 0.6, 0.8, 20), 19, 'stays on the last slice after a side exit');
  assert.equal(lockedSlice(0.7, 0.7, 0.7, 20), 19, 'degenerate range');
  for (let t = 0; t < 20; t++) assert.equal(lockedSlice(lockedProgress(t, 0.6, 1, 20), 0.6, 1, 20), t);
});

test('display threshold keeps |q| above it for both signs and leaves the slice untouched', async () => {
  const { applyThreshold, chargeStats } = await import('../src/pixelav.js');
  const slice = { indices: Uint16Array.of(1, 2, 3, 4), charges: Float32Array.of(500, -500, 100, -100) };
  assert.equal(applyThreshold(slice, 0), slice);
  const shown = applyThreshold(slice, 100);
  assert.deepEqual([...shown.indices], [1, 2]);
  assert.deepEqual([...shown.charges], [500, -500]);
  assert.ok(shown.indices instanceof Uint16Array && shown.charges instanceof Float32Array);
  assert.equal(slice.indices.length, 4);
  const stats = chargeStats(slice, 100);
  assert.equal(stats.nAbove, 2);
  assert.equal(stats.total, 600, 'totals are not thresholded');
  assert.equal(stats.net, 0);
});
