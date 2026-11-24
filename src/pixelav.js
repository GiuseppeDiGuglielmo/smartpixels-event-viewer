/**
 * pixelAV simulated events: binary decoding and coordinate mapping.
 * Pure functions (no DOM, no fetch) so they run in Node tests and the browser.
 *
 * Data come from scripts/pixelav_convert.py (format "pixelav-sparse-v1").
 * Charge values are pixelAV SIMULATED electrons, cumulative over time slices.
 * This is real simulation output; it is the only charge the viewer shows
 * (pixelAV is the only data source).
 *
 * Coordinate conventions (verified on test/part.0, see docs/PIXELAV_DATA.md):
 *  - pixel index p = iy*48 + ix (same zero-based ix/iy as geometry.js; no transpose)
 *  - pixelAV z: top surface z=100, midplane 50, bottom 0  →  viewer z = z − 100
 *  - cotAlpha = n_x/n_z, cotBeta = n_y/n_z with n_z < 0 (travel toward −z), so the
 *    viewer slopes are tan(thetaX) = −cotAlpha, tan(thetaY) = −cotBeta
 *  - x/y origin: see PIXELAV_ORIGIN (a documented, reversible convention)
 */
import { SENSOR, pixelAt, pixelCenter } from './geometry.js';

export const PIXELAV_FORMAT = 'pixelav-sparse-v1';
export const INDEX_MAGIC = 'PXAVIDX1';
export const SAME_AS_PREVIOUS = 0xFFFFFFFF;
export const PIXELAV_Z_TOP = 100;
export const DATA_MODE_DEFAULT_Z0 = 150;

/**
 * Viewer position (µm) of the pixelAV (x, y) = (0, 0) point: the centre of
 * pixel (23, 95). With this choice the charge centroid matches the truth
 * midplane in x (≈0 µm); a constant ≈ −16 µm shift remains in y, which is
 * NOT removed (plausibly Lorentz drift). PENDING confirmation with the dataset
 * author — see .omc/autopilot/decisions-pending.md and docs/PIXELAV_DATA.md.
 */
export const PIXELAV_ORIGIN = Object.freeze(pixelCenter(23, 95));

export function validateManifest(manifest) {
  if (!manifest || manifest.format !== PIXELAV_FORMAT) {
    throw new Error(`Unsupported event manifest (expected format ${PIXELAV_FORMAT}).`);
  }
  if (manifest.pixelsX !== SENSOR.pixelsX || manifest.pixelsY !== SENSOR.pixelsY) {
    throw new Error(`Dataset is ${manifest.pixelsX} × ${manifest.pixelsY}, viewer expects ${SENSOR.pixelsX} × ${SENSOR.pixelsY}.`);
  }
  if (manifest.pitchX !== SENSOR.pitchX || manifest.pitchY !== SENSOR.pitchY) {
    throw new Error('Dataset pixel pitch differs from the viewer geometry.');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.truthColumns)) {
    throw new Error('Manifest is missing files or truthColumns.');
  }
  // Only plain "<split>/<stem>.index.bin|events.bin" paths (no '..', no absolute or protocol URLs).
  const safe = /^[\w-]+\/[\w.-]+\.(index|events)\.bin$/;
  for (const f of manifest.files) {
    if (!safe.test(f.index) || !safe.test(f.data) || f.index.includes('..') || f.data.includes('..')) {
      throw new Error(`Manifest entry has an unsafe path: ${f.index} / ${f.data}`);
    }
    if (!Number.isSafeInteger(f.events) || f.events < 0) throw new Error('Manifest entry has an invalid event count.');
  }
  return manifest;
}

/** Decode <stem>.index.bin: offsets (n+1) and column-major truth (k × n). */
export function decodeIndex(buffer, truthColumns) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== INDEX_MAGIC) throw new Error('Not a pixelAV index file (bad magic).');
  const nEvents = view.getUint32(8, true);
  const nTruth = view.getUint32(12, true);
  if (truthColumns && truthColumns.length !== nTruth) throw new Error('Index truth columns do not match the manifest.');
  const expected = 16 + 8 * (nEvents + 1) + 8 * nTruth * nEvents;
  if (buffer.byteLength !== expected) throw new Error(`Index size ${buffer.byteLength} ≠ expected ${expected}.`);
  const readF64 = (offset, count) => {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat64(offset + 8 * i, true);
    return out;
  };
  const offsets = readF64(16, nEvents + 1);
  for (let i = 0; i <= nEvents; i++) {
    const o = offsets[i];
    if (!Number.isSafeInteger(o) || o < 0 || (i > 0 && o < offsets[i - 1])) throw new Error(`Corrupt index: bad offset at ${i}.`);
  }
  const truth = readF64(16 + 8 * (nEvents + 1), nTruth * nEvents);
  return {
    nEvents,
    nTruth,
    offsets,
    truthColumns: truthColumns ?? null,
    /** Byte range [start, end) of event i inside <stem>.events.bin. */
    range(i) {
      if (!Number.isInteger(i) || i < 0 || i >= nEvents) throw new RangeError(`Event ${i} outside 0..${nEvents - 1}`);
      return [offsets[i], offsets[i + 1]];
    },
    truthOf(i) {
      if (!Number.isInteger(i) || i < 0 || i >= nEvents) throw new RangeError(`Event ${i} outside 0..${nEvents - 1}`);
      const names = truthColumns ?? Array.from({ length: nTruth }, (_, k) => `truth${k}`);
      const record = {};
      names.forEach((name, k) => { record[name] = truth[k * nEvents + i]; });
      return record;
    },
  };
}

/**
 * Decode one sparse event record. Returns
 * { eventIndex, slices: [{ indices: Uint16Array, charges: Float32Array }] }.
 * A "same as previous" slice reuses the previous slice's arrays.
 */
export function decodeEvent(buffer) {
  const view = new DataView(buffer);
  const eventIndex = view.getUint32(0, true);
  const nSlices = view.getUint16(4, true);
  let pos = 8;
  const slices = [];
  for (let t = 0; t < nSlices; t++) {
    const count = view.getUint32(pos, true);
    pos += 4;
    if (count === SAME_AS_PREVIOUS) {
      if (t === 0) throw new Error('First slice cannot repeat a previous slice.');
      slices.push(slices[t - 1]);
      continue;
    }
    // Validate before allocating: a slice holds at most 9216 pixels and must fit in the record.
    if (count > SENSOR.pixelsX * SENSOR.pixelsY || pos + 6 * count + (count % 2 ? 2 : 0) > buffer.byteLength) {
      throw new Error(`Corrupt event record: slice ${t} count ${count} exceeds the record.`);
    }
    const indices = new Uint16Array(count);
    for (let i = 0; i < count; i++) indices[i] = view.getUint16(pos + 2 * i, true);
    pos += 2 * count + (count % 2 ? 2 : 0);
    const charges = new Float32Array(count);
    for (let i = 0; i < count; i++) charges[i] = view.getFloat32(pos + 4 * i, true);
    pos += 4 * count;
    for (const p of indices) if (p >= SENSOR.pixelsX * SENSOR.pixelsY) throw new Error(`Pixel index ${p} out of range.`);
    slices.push({ indices, charges });
  }
  if (pos !== buffer.byteLength) throw new Error(`Event record length mismatch (${pos} ≠ ${buffer.byteLength}).`);
  return { eventIndex, slices };
}

/** Expand a sparse slice to a dense Float32Array(9216) indexed by iy*48 + ix. */
export function sliceToDense(slice, out = new Float32Array(SENSOR.pixelsX * SENSOR.pixelsY)) {
  out.fill(0);
  for (let i = 0; i < slice.indices.length; i++) out[slice.indices[i]] = slice.charges[i];
  return out;
}

export const pixelOfIndex = (p) => ({ x: p % SENSOR.pixelsX, y: Math.floor(p / SENSOR.pixelsX) });

/**
 * The entries of a sparse slice that are displayed: |q| > threshold, for
 * negative and positive charge alike. Display only; the data is not changed.
 */
export function applyThreshold(slice, threshold = 0) {
  if (!(threshold > 0)) return slice;
  const keep = [];
  for (let i = 0; i < slice.charges.length; i++) if (Math.abs(slice.charges[i]) > threshold) keep.push(i);
  return {
    ...slice,
    indices: slice.indices.constructor.from(keep, (i) => slice.indices[i]),
    charges: slice.charges.constructor.from(keep, (i) => slice.charges[i]),
  };
}

/**
 * Charge statistics of one slice: total (Σ of positive entries), net (Σ of all
 * entries, incl. small negative values), number of pixels with |q| above `threshold`
 * electrons, maximum, minimum (≤ 0), and the charge-weighted centroid (viewer µm, using
 * pixel centres; negative values ignored).
 */
export function chargeStats(slice, threshold = 0) {
  let total = 0;
  let net = 0;
  let max = 0;
  let min = 0;
  let above = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < slice.indices.length; i++) {
    const q = slice.charges[i];
    net += q;
    if (q < min) min = q;
    if (Math.abs(q) > threshold) above++;
    if (q <= 0) continue;
    const { x, y } = pixelOfIndex(slice.indices[i]);
    const c = pixelCenter(x, y);
    total += q;
    sx += q * c.x;
    sy += q * c.y;
    if (q > max) max = q;
  }
  const centroid = total > 0 ? { x: sx / total, y: sy / total } : null;
  return { total, net, max, min, nAbove: above, centroid, centroidPixel: centroid ? pixelAt(centroid.x, centroid.y) : null };
}

/**
 * Display link between the particle animation and the charge time slices.
 * The n slices are spread over the part of the animation inside the silicon,
 * [enter, leave] in progress units; before `enter` no charge is shown (null).
 * This is a display mapping, not a physical time axis.
 */
export function lockedSlice(progress, enter, leave, n) {
  if (progress < enter) return null;
  if (!(leave > enter)) return n - 1;
  const t = Math.round(((progress - enter) / (leave - enter)) * (n - 1));
  return Math.min(n - 1, Math.max(0, t));
}

/** Animation progress at which `lockedSlice` first shows the centre of slice t. */
export function lockedProgress(t, enter, leave, n) {
  return n > 1 ? enter + (t / (n - 1)) * (leave - enter) : leave;
}

/** pixelAV truth (x, y) → viewer µm. */
export function pixelavToViewerXY(x, y) {
  return { x: x + PIXELAV_ORIGIN.x, y: y + PIXELAV_ORIGIN.y };
}

/**
 * Straight-line parameters for the viewer from a truth record:
 * the line passes through the truth top-surface entry (pixelAV z = 100) with
 * slopes −cotAlpha / −cotBeta, starting z0 µm above the top surface.
 */
export function truthToParticle(truth, z0 = DATA_MODE_DEFAULT_Z0) {
  const cotAlpha = Number.isFinite(truth.cotAlpha) ? truth.cotAlpha : truth.n_x / truth.n_z;
  const cotBeta = Number.isFinite(truth.cotBeta) ? truth.cotBeta : truth.n_y / truth.n_z;
  for (const v of [truth['x-entry'], truth['y-entry'], cotAlpha, cotBeta, z0]) {
    if (!Number.isFinite(v)) throw new TypeError('Truth record is missing x-entry / y-entry / direction.');
  }
  if (Number.isFinite(truth['z-entry']) && Math.abs(truth['z-entry'] - PIXELAV_Z_TOP) > 1e-6) {
    throw new RangeError(`Expected entry at the top surface (pixelAV z = ${PIXELAV_Z_TOP}), got ${truth['z-entry']}.`);
  }
  const top = pixelavToViewerXY(truth['x-entry'], truth['y-entry']);
  // x(z) = x0 + (z0 − z)·tanθX with tanθX = −cotAlpha  ⇒  x0 = x_top + z0·cotAlpha
  return {
    x0: top.x + z0 * cotAlpha,
    y0: top.y + z0 * cotBeta,
    z0,
    thetaX: Math.atan(-cotAlpha) * 180 / Math.PI,
    thetaY: Math.atan(-cotBeta) * 180 / Math.PI,
  };
}

/** Truth midplane position in viewer µm (for residual displays). */
export function truthMidplane(truth) {
  if (!Number.isFinite(truth['x-midplane']) || !Number.isFinite(truth['y-midplane'])) return null;
  return pixelavToViewerXY(truth['x-midplane'], truth['y-midplane']);
}
