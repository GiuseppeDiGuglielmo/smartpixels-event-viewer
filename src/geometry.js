/**
 * Geometry and straight-line ray mathematics, independent of the browser/UI.
 * All distances are in micrometers (µm), angles in degrees.
 *
 * X spans 48 pixels at 50 µm: [-1200, 1200).
 * Y spans 192 pixels at 12.5 µm: [-1200, 1200).
 * Top surface: z=0; midplane: z=-50; bottom: z=-100.
 *
 * This is NOT Geant4, Allpix², a drift/diffusion solver, or a transport model.
 */
export const SENSOR = Object.freeze({
  pixelsX: 48,
  pixelsY: 192,
  pitchX: 50,
  pitchY: 12.5,
  thickness: 100,
  halfX: 1200,
  halfY: 1200,
  zTop: 0,
  zMid: -50,
  zBottom: -100,
});

export const DEFAULT_STATE = Object.freeze({
  x0: -620,
  y0: 125,
  z0: 600,
  thetaX: 28,
  thetaY: -8,
  azimuth: 35,
  elevation: 30,
  zStretch: 5,
  zoom: 1,
  progress: 1,
  showGrid: true,
  showMid: true,
});

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

export function point(x, y, z) {
  return { x, y, z };
}

export function lerp(a, b, fraction) {
  return a + (b - a) * fraction;
}

/** Return a zero-based pixel address or null outside the sensor footprint. */
export function pixelAt(x, y) {
  const { halfX, halfY, pitchX, pitchY, pixelsX, pixelsY } = SENSOR;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Half-open bounds avoid incorrectly assigning points at the right/top edge.
  if (x < -halfX || x >= halfX || y < -halfY || y >= halfY) return null;
  const ix = Math.floor((x + halfX) / pitchX);
  const iy = Math.floor((y + halfY) / pitchY);
  if (ix < 0 || ix >= pixelsX || iy < 0 || iy >= pixelsY) return null;
  return { x: ix, y: iy };
}

export function pixelCenter(ix, iy) {
  if (!Number.isInteger(ix) || !Number.isInteger(iy) || ix < 0 || ix >= SENSOR.pixelsX || iy < 0 || iy >= SENSOR.pixelsY) {
    return null;
  }
  return {
    x: -SENSOR.halfX + (ix + 0.5) * SENSOR.pitchX,
    y: -SENSOR.halfY + (iy + 0.5) * SENSOR.pitchY,
  };
}

/**
 * thetaX and thetaY are slopes relative to downward (-Z) travel:
 * dx / (-dz) = tan(thetaX), dy / (-dz) = tan(thetaY).
 * They are NOT polar/azimuthal spherical angles.
 */
export function traceParticle({ x0, y0, z0, thetaX, thetaY }) {
  for (const value of [x0, y0, z0, thetaX, thetaY]) {
    if (!Number.isFinite(value)) throw new TypeError('Particle coordinates and angles must be finite numbers.');
  }
  if (z0 <= SENSOR.zTop) throw new RangeError('Start position z0 must be above the sensor (z > 0).');
  const dx = Math.tan(degreesToRadians(thetaX));
  const dy = Math.tan(degreesToRadians(thetaY));
  const atZ = (z) => point(x0 + (z0 - z) * dx, y0 + (z0 - z) * dy, z);
  const start = point(x0, y0, z0);
  const top = atZ(SENSOR.zTop);
  const mid = atZ(SENSOR.zMid);
  const bottom = atZ(SENSOR.zBottom);
  const topPixel = pixelAt(top.x, top.y);
  const midPixel = pixelAt(mid.x, mid.y);
  const exitPixel = pixelAt(bottom.x, bottom.y);
  return {
    start,
    top,
    mid,
    bottom,
    topPixel,
    midPixel,
    exitPixel,
    hit: topPixel !== null,
    midHit: midPixel !== null,
    exitHit: exitPixel !== null,
  };
}

/* ------------------------------------------------------------------------ *
 * Region of interest (ROI), animation parameterisation, and full-volume
 * intersection. All pure functions in physical µm / zero-based indices.
 * ------------------------------------------------------------------------ */

export const ROI_SIZE = 16;
export const ROI_MODES = Object.freeze(['centered', 'aligned']);

/**
 * 16 × 16 ROI window in pixel-index space, as half-open ranges
 * { x0, x1, y0, y1 } with x1 = x0 + 16, y1 = y0 + 16.
 *  - 'centered': the window around `pixel` (pixel at local index 8,8),
 *    shifted so it stays fully inside the 48 × 192 array near the edges.
 *  - 'aligned': the fixed tile of a 3 × 12 tiling that contains `pixel`.
 * Returns null when there is no pixel (e.g. a miss).
 */
export function roiWindow(pixel, mode = 'centered') {
  if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y)) return null;
  const { pixelsX, pixelsY } = SENSOR;
  if (pixel.x < 0 || pixel.x >= pixelsX || pixel.y < 0 || pixel.y >= pixelsY) return null;
  let x0;
  let y0;
  if (mode === 'aligned') {
    x0 = Math.floor(pixel.x / ROI_SIZE) * ROI_SIZE;
    y0 = Math.floor(pixel.y / ROI_SIZE) * ROI_SIZE;
  } else if (mode === 'centered') {
    x0 = clamp(pixel.x - ROI_SIZE / 2, 0, pixelsX - ROI_SIZE);
    y0 = clamp(pixel.y - ROI_SIZE / 2, 0, pixelsY - ROI_SIZE);
  } else {
    throw new RangeError(`Unknown ROI mode: ${mode}`);
  }
  return { x0, x1: x0 + ROI_SIZE, y0, y1: y0 + ROI_SIZE };
}

/** Physical footprint [xMin,xMax) × [yMin,yMax) in µm of an ROI window. */
export function roiBounds(roi) {
  if (!roi) return null;
  return {
    xMin: -SENSOR.halfX + roi.x0 * SENSOR.pitchX,
    xMax: -SENSOR.halfX + roi.x1 * SENSOR.pitchX,
    yMin: -SENSOR.halfY + roi.y0 * SENSOR.pitchY,
    yMax: -SENSOR.halfY + roi.y1 * SENSOR.pitchY,
  };
}

export function roiContains(roi, pixel) {
  return !!roi && !!pixel && pixel.x >= roi.x0 && pixel.x < roi.x1 && pixel.y >= roi.y0 && pixel.y < roi.y1;
}

/**
 * The animation runs linearly from the start point (progress 0) to the
 * bottom-plane crossing (progress 1). Because motion is straight, progress is
 * linear in z.
 */
export function progressAtZ(trace, z) {
  return (trace.start.z - z) / (trace.start.z - trace.bottom.z);
}

export function pointAtProgress(trace, fraction) {
  const f = clamp(fraction, 0, 1);
  return point(
    lerp(trace.start.x, trace.bottom.x, f),
    lerp(trace.start.y, trace.bottom.y, f),
    lerp(trace.start.z, trace.bottom.z, f),
  );
}

/** Tolerance (µm) for plane-crossing ties in intersectVolume. */
export const VOLUME_EPSILON = 1e-9;

/**
 * Full ray / sensor-volume intersection (slab method), including entry or
 * exit through the side faces. This is reported SEPARATELY from `hit`, which
 * keeps its top-surface meaning. The volume uses the same half-open lateral
 * convention as pixelAt(): [-1200,1200) × [-1200,1200) × [-100,0], so the
 * readouts can never disagree with the pixel map.
 *
 * Consistency rules (ties within VOLUME_EPSILON):
 *  - if the ray is a top-surface HIT, the entry face is always 'top';
 *  - if it is not, a top-plane tie is attributed to the side face;
 *  - zero-length (tangential) chords count as no intersection.
 *
 * Returns null if the ray never enters the volume, otherwise
 * { entry, exit, entryFace, exitFace, length, topHit } with faces among
 * 'top', 'bottom', 'x-', 'x+', 'y-', 'y+' and `length` the 3D chord in µm.
 */
export function intersectVolume(params) {
  const trace = traceParticle(params);
  const { x0, y0, z0 } = params;
  const dx = Math.tan(degreesToRadians(params.thetaX));
  const dy = Math.tan(degreesToRadians(params.thetaY));
  const eps = VOLUME_EPSILON;
  // Parameter s = z0 - z >= 0 (depth travelled downward from the start).
  const sTop = z0 - SENSOR.zTop;
  let sIn = sTop;
  let sOut = z0 - SENSOR.zBottom;
  let entryFace = 'top';
  let exitFace = 'bottom';
  const sideTies = [];
  const slabs = [
    { origin: x0, slope: dx, half: SENSOR.halfX, name: 'x' },
    { origin: y0, slope: dy, half: SENSOR.halfY, name: 'y' },
  ];
  for (const { origin, slope, half, name } of slabs) {
    if (slope === 0) {
      if (origin < -half || origin >= half) return null; // half-open, as pixelAt()
      continue;
    }
    let sNear = (-half - origin) / slope;
    let sFar = (half - origin) / slope;
    let nearFace = `${name}-`;
    let farFace = `${name}+`;
    if (sNear > sFar) {
      [sNear, sFar] = [sFar, sNear];
      [nearFace, farFace] = [farFace, nearFace];
    }
    if (Math.abs(sNear - sTop) <= eps) sideTies.push(nearFace);
    if (sNear > sIn + eps) { sIn = sNear; entryFace = nearFace; }
    if (sFar < sOut - eps) { sOut = sFar; exitFace = farFace; }
  }
  if (sOut - sIn <= eps) return null;
  if (trace.hit) {
    entryFace = 'top';
    sIn = sTop;
  } else if (entryFace === 'top') {
    // Top-plane crossing lies on the (excluded) footprint edge: it is a side entry.
    if (sideTies.length === 0) return null;
    entryFace = sideTies[0];
  }
  const at = (s) => point(x0 + s * dx, y0 + s * dy, z0 - s);
  const entry = trace.hit ? { ...trace.top } : at(sIn);
  const exit = at(sOut);
  const length = Math.hypot(exit.x - entry.x, exit.y - entry.y, exit.z - entry.z);
  return { entry, exit, entryFace, exitFace, length, topHit: trace.hit };
}

/**
 * Pixel columns (zero-based x, y) whose 50 × 12.5 × 100 µm volume is crossed
 * by the in-silicon segment, ordered along the track, with the geometric 3D
 * path length (µm) inside each column. Purely geometric — not charge.
 * Splits the segment at every pixel-boundary crossing and classifies each
 * piece by its midpoint with the same half-open convention as pixelAt().
 */
export function traversedPixels(params) {
  const volume = intersectVolume(params);
  if (!volume) return [];
  const { entry, exit } = volume;
  const ddx = exit.x - entry.x;
  const ddy = exit.y - entry.y;
  const cuts = [0, 1];
  const addCuts = (startValue, delta, lines) => {
    if (delta === 0) return;
    for (const lineValue of lines) {
      const u = (lineValue - startValue) / delta;
      if (u > 0 && u < 1) cuts.push(u);
    }
  };
  const xLines = Array.from({ length: SENSOR.pixelsX + 1 }, (_, i) => -SENSOR.halfX + i * SENSOR.pitchX);
  const yLines = Array.from({ length: SENSOR.pixelsY + 1 }, (_, i) => -SENSOR.halfY + i * SENSOR.pitchY);
  addCuts(entry.x, ddx, xLines);
  addCuts(entry.y, ddy, yLines);
  cuts.sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a <= 1e-12 && cuts.length > 2) continue;
    const m = (a + b) / 2;
    const pixel = pixelAt(entry.x + m * ddx, entry.y + m * ddy);
    if (!pixel) continue;
    const length = (b - a) * volume.length;
    const last = result[result.length - 1];
    if (last && last.x === pixel.x && last.y === pixel.y) last.length += length;
    else result.push({ x: pixel.x, y: pixel.y, length });
  }
  return result;
}
