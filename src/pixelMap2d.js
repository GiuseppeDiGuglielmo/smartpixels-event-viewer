/**
 * 2D top view of the full 48 × 192 pixel array (the "2D" view).
 *
 * Physical aspect: the map is drawn in µm with equal X and Y scale, so each
 * pixel appears 50 × 12.5 µm. +x to the right, +y UP (same as the 3D top view);
 * pixel indices are zero-based and never transposed.
 *
 * Pixel colours: pixelAV SIMULATED charge (pixelShading), positive and negative.
 * Everything else is geometry from geometry.js: the projected
 * track, the pixels it crosses, and the crossing points at the top surface
 * (z = 0), the midplane (z = −50) and the exit plane (z = −100).
 *
 * The layout helpers (mapWindow, mapTransform, crossingMarkers, pickPixel) are
 * pure and tested in Node; drawPixelMap needs only a CanvasRenderingContext2D.
 */
import { SENSOR, pixelAt, progressAtZ, pointAtProgress, trackSegments } from './geometry.js';
import { chargeColor, pixelShading } from './chargeColors.js';

export const FULL_WINDOW = Object.freeze({ x0: -SENSOR.halfX, x1: SENSOR.halfX, y0: -SENSOR.halfY, y1: SENSOR.halfY });
export const MAP_FITS = Object.freeze(['full', 'track']);
export const AXIS_UNITS = Object.freeze(['um', 'px']);
/** Pixel boundaries on the sensor's central axes (x = 0 and y = 0 µm). */
export const CENTER_X = SENSOR.pixelsX / 2;
export const CENTER_Y = SENSOR.pixelsY / 2;
export const CROSSED_COLOR = '#ff3b30';

/** Crossing markers, in drawing order. `z` is the physical plane in µm. Colours match the 3D markers. */
export const CROSSINGS = Object.freeze([
  { key: 'top', z: SENSOR.zTop, title: 'surface', long: 'Surface (z = 0)', color: '#62f5f3' },
  { key: 'mid', z: SENSOR.zMid, title: 'midplane', long: 'Midplane (z = −50 µm)', color: '#8fc3ff' },
  { key: 'exit', z: SENSOR.zBottom, title: 'exit', long: 'Exit (z = −100 µm)', color: '#ffa070' },
]);

const inFootprint = (p) => p.x >= -SENSOR.halfX && p.x < SENSOR.halfX && p.y >= -SENSOR.halfY && p.y < SENSOR.halfY;

/**
 * The three plane crossings of the straight track, with the pixel each one
 * falls in (null when outside the footprint) and the animation progress at
 * which the particle reaches it.
 */
export function crossingMarkers(trace) {
  const at = { top: [trace.top, trace.topPixel], mid: [trace.mid, trace.midPixel], exit: [trace.bottom, trace.exitPixel] };
  return CROSSINGS.map((c) => {
    const [p, pixel] = at[c.key];
    return { ...c, x: p.x, y: p.y, pixel, inside: pixel !== null, progress: progressAtZ(trace, c.z) };
  });
}

/**
 * µm window to show. 'full' is the whole footprint. 'track' frames the
 * crossings that lie on the sensor plus any charged pixels, with a margin and
 * a minimum span; it falls back to the full footprint when nothing of the
 * track or charge is on the sensor.
 */
export function mapWindow(fit, { trace, volume = null, charge = null, minSpan = 400, margin = 0.35 } = {}) {
  if (fit !== 'track' || !trace) return { ...FULL_WINDOW };
  const xs = [];
  const ys = [];
  for (const p of [trace.top, trace.mid, trace.bottom]) {
    if (inFootprint(p)) { xs.push(p.x); ys.push(p.y); }
  }
  // Side entry / exit points lie on the sensor edge: frame them too.
  if (volume) for (const p of [volume.entry, volume.exit]) { xs.push(p.x); ys.push(p.y); }
  const sparse = charge?.sparse;
  if (sparse) {
    for (let i = 0; i < sparse.indices.length; i++) {
      if (!(sparse.charges[i] > 0)) continue;
      const ix = sparse.indices[i] % SENSOR.pixelsX;
      const iy = Math.floor(sparse.indices[i] / SENSOR.pixelsX);
      const x = -SENSOR.halfX + ix * SENSOR.pitchX;
      const y = -SENSOR.halfY + iy * SENSOR.pitchY;
      xs.push(x, x + SENSOR.pitchX);
      ys.push(y, y + SENSOR.pitchY);
    }
  }
  if (!xs.length) return { ...FULL_WINDOW };
  const span = (lo, hi) => {
    const pad = Math.max((hi - lo) * margin, (minSpan - (hi - lo)) / 2, 0);
    return [lo - pad, hi + pad];
  };
  const [x0, x1] = span(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = span(Math.min(...ys), Math.max(...ys));
  return { x0, x1, y0, y1 };
}

/**
 * Equal-scale mapping between µm and canvas pixels for a window drawn into a
 * width × height canvas with the given padding. The window is centred and the
 * shorter canvas direction limits the scale (no stretching).
 */
export function mapTransform(win, width, height, pad = { left: 56, right: 16, top: 16, bottom: 40 }) {
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = Math.max(1, height - pad.top - pad.bottom);
  const scale = Math.min(innerW / (win.x1 - win.x0), innerH / (win.y1 - win.y0));
  const cx = pad.left + innerW / 2;
  const cy = pad.top + innerH / 2;
  const mx = (win.x0 + win.x1) / 2;
  const my = (win.y0 + win.y1) / 2;
  return {
    scale,
    toCanvas: (x, y) => [cx + (x - mx) * scale, cy - (y - my) * scale],
    toUm: (px, py) => ({ x: mx + (px - cx) / scale, y: my - (py - cy) / scale }),
    // µm range actually visible on the canvas (wider than `win` along one axis).
    visible: {
      x0: mx - (innerW / 2) / scale, x1: mx + (innerW / 2) / scale,
      y0: my - (innerH / 2) / scale, y1: my + (innerH / 2) / scale,
    },
    pad,
    width,
    height,
  };
}

/**
 * Window after zooming by `factor` about canvas point (px, py): the µm under
 * that point stays put unless this would show area beyond the sensor. Zoom-in
 * stops when one 50 µm pixel fills the plot. Returns null once zoomed out to
 * the full sensor.
 */
export function zoomWindow(t, px, py, factor) {
  const innerW = Math.max(1, t.width - t.pad.left - t.pad.right);
  const innerH = Math.max(1, t.height - t.pad.top - t.pad.bottom);
  const fullScale = mapTransform(FULL_WINDOW, t.width, t.height, t.pad).scale;
  const maxScale = Math.min(innerW, innerH) / SENSOR.pitchX;
  const scale = Math.min(maxScale, t.scale * factor);
  if (scale <= fullScale * (1 + 1e-9)) return null;
  const at = t.toUm(px, py);
  return windowAt(t, at.x - (px - (t.pad.left + innerW / 2)) / scale, at.y + (py - (t.pad.top + innerH / 2)) / scale, scale);
}

/** Window of the given scale centred on (mx, my), moved back if it would show area beyond the sensor. */
function windowAt(t, mx, my, scale) {
  const spanX = Math.max(1, t.width - t.pad.left - t.pad.right) / scale;
  const spanY = Math.max(1, t.height - t.pad.top - t.pad.bottom) / scale;
  const centre = (value, span, half) => (span >= 2 * half ? 0 : Math.max(-half + span / 2, Math.min(half - span / 2, value)));
  const x = centre(mx, spanX, SENSOR.halfX);
  const y = centre(my, spanY, SENSOR.halfY);
  return { x0: x - spanX / 2, x1: x + spanX / 2, y0: y - spanY / 2, y1: y + spanY / 2 };
}

/** True when the view is closer than the full sensor, so there is somewhere to drag to. */
export function canPan(t) {
  return t.scale > mapTransform(FULL_WINDOW, t.width, t.height, t.pad).scale * (1 + 1e-9);
}

/** Window after dragging the map by (dx, dy) canvas pixels from transform t; the content follows the pointer. */
export function panWindow(t, dx, dy) {
  const mx = (t.visible.x0 + t.visible.x1) / 2 - dx / t.scale;
  const my = (t.visible.y0 + t.visible.y1) / 2 + dy / t.scale;
  return windowAt(t, mx, my, t.scale);
}

/** Pixel under a canvas position (or null), via geometry.pixelAt. */
export function pickPixel(transform, px, py) {
  const p = transform.toUm(px, py);
  return { ...p, pixel: pixelAt(p.x, p.y) };
}

/** Index range [lo, hi) of pixels overlapping [a, b) µm along one axis. */
function indexRange(a, b, half, pitch, n) {
  return [Math.max(0, Math.floor((a + half) / pitch)), Math.min(n, Math.ceil((b + half) / pitch))];
}

/** "Nice" tick step in µm giving at least `minPx` canvas pixels between ticks. */
export function tickStep(scale, minPx = 70) {
  const raw = minPx / scale;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** Smallest power-of-two pixel step (1, 2, 4, … 32) whose ticks are at least `minPx` apart. */
export function indexStep(pitch, scale, minPx = 40) {
  let step = 1;
  while (step < 32 && step * pitch * scale < minPx) step *= 2;
  return step;
}

/**
 * Axis ticks for the visible window, limited to the sensor footprint.
 *  units 'um': physical µm (origin at the sensor centre), nice steps.
 *  units 'px': pixels counted from the sensor centre (x −24..24, y −96..96),
 *  so 0 is the central axis and each tick is a pixel boundary. These are
 *  distances, not pixel addresses, which stay zero-based (x 0..47, y 0..191).
 * Returns { x: [{ at, text }], y: [{ at, text }], title: { x, y } } with `at` in µm.
 */
export function axisTicks(visible, scale, units = 'um') {
  const clip = (lo, hi, half) => [Math.max(lo, -half), Math.min(hi, half)];
  if (units === 'px') {
    const axis = (lo, hi, half, pitch) => {
      const step = indexStep(pitch, scale);
      const last = Math.floor(half / pitch / step);
      const out = [];
      for (let k = -last; k <= last; k++) {
        const at = k * step * pitch;
        if (at >= lo && at <= hi) out.push({ at, text: String(k * step + 0) });
      }
      return out;
    };
    return {
      x: axis(visible.x0, visible.x1, SENSOR.halfX, SENSOR.pitchX),
      y: axis(visible.y0, visible.y1, SENSOR.halfY, SENSOR.pitchY),
      title: { x: 'x (pixels from centre) →', y: 'y (pixels from centre) →' },
    };
  }
  const step = tickStep(scale);
  const axis = (lo, hi, half) => {
    const [a, b] = clip(lo, hi, half);
    const out = [];
    for (let v = Math.ceil(a / step - 1e-9) * step; v <= b + 1e-9; v += step) {
      const at = Math.round(v * 1000) / 1000;
      out.push({ at, text: String(Math.round(at * 10) / 10) });
    }
    return out;
  };
  return {
    x: axis(visible.x0, visible.x1, SENSOR.halfX),
    y: axis(visible.y0, visible.y1, SENSOR.halfY),
    title: { x: 'x (µm) →', y: 'y (µm) →' },
  };
}

/**
 * Pixel boundaries to draw along one axis between index lo and hi: every
 * boundary when they are at least `minPx` apart, otherwise every 2nd, 4th, …
 * counted from `center`, whose line is always kept and flagged.
 */
export function gridLines(lo, hi, pitch, scale, center, minPx = 2.5) {
  let every = 1;
  while (every < 16 && every * pitch * scale < minPx) every *= 2;
  const out = [];
  for (let i = lo; i <= hi; i++) {
    if ((i - center) % every === 0) out.push({ i, center: i === center });
  }
  return out;
}

/**
 * Draw the map. `options`:
 *  trace, volume, traversed, charge, mode, progress (0..1),
 *  show: { grid, traversed, trackOff, trackIn, top, mid, exit },
 *  fit ('full' | 'track'), customWindow (wheel zoom; overrides fit), units ('um' | 'px'), hover ({ pixel, x, y } | null), dpr.
 * Returns the transform used (for hover picking).
 */
export function drawPixelMap(ctx, width, height, options) {
  const { trace, volume = null, traversed = [], charge = null, frameCharge = null, mode = 'data', progress = 1, show = {}, fit = 'full', customWindow = null, units = 'um', hover = null, dpr = 1 } = options;
  const shading = pixelShading({ mode, charge });
  // Frame on `frameCharge` (e.g. the event's last slice) so the view stays put while scrubbing slices.
  const win = customWindow ?? mapWindow(fit, { trace, volume, charge: shading === 'charge' ? (frameCharge ?? charge) : null });
  const t = mapTransform(win, width, height);
  const { scale, toCanvas, visible } = t;
  const P = (x, y) => toCanvas(x, y);
  const labels = []; // placed at the end so they can avoid each other

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a1626';
  ctx.fillRect(0, 0, width, height);

  // Sensor footprint.
  const [fx0, fy0] = P(-SENSOR.halfX, SENSOR.halfY);
  const [fx1, fy1] = P(SENSOR.halfX, -SENSOR.halfY);
  ctx.fillStyle = '#16293f';
  ctx.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0);

  const [ix0, ix1] = indexRange(visible.x0, visible.x1, SENSOR.halfX, SENSOR.pitchX, SENSOR.pixelsX);
  const [iy0, iy1] = indexRange(visible.y0, visible.y1, SENSOR.halfY, SENSOR.pitchY, SENSOR.pixelsY);
  const cell = (ix, iy) => {
    const [x, y] = P(-SENSOR.halfX + ix * SENSOR.pitchX, -SENSOR.halfY + (iy + 1) * SENSOR.pitchY);
    return [x, y, SENSOR.pitchX * scale, SENSOR.pitchY * scale];
  };
  const fillCell = (ix, iy, style, inset = 0) => {
    const [x, y, w, h] = cell(ix, iy);
    ctx.fillStyle = style;
    ctx.fillRect(x + inset, y + inset, Math.max(0.5, w - 2 * inset), Math.max(0.5, h - 2 * inset));
  };

  // Pixel shading: pixelAV simulated charge only.
  if (shading === 'charge') {
    const { indices, charges } = charge.sparse;
    for (let i = 0; i < indices.length; i++) {
      if (!charges[i]) continue; // negative charge is drawn too
      const [r, g, b] = chargeColor(charges[i], charge.scale);
      fillCell(indices[i] % SENSOR.pixelsX, Math.floor(indices[i] / SENSOR.pixelsX), `rgb(${r},${g},${b})`);
    }
  }


  // Grid: pixel boundaries (thinned when denser than 2.5 canvas px), with the central x = 0 and y = 0 axes highlighted.
  if (show.grid) {
    const xs = gridLines(ix0, ix1, SENSOR.pitchX, scale, CENTER_X);
    const ys = gridLines(iy0, iy1, SENSOR.pitchY, scale, CENTER_Y);
    const top = Math.max(fy0, 0); const bot = Math.min(fy1, height);
    const left = Math.max(fx0, 0); const right = Math.min(fx1, width);
    for (const center of [false, true]) {
      ctx.lineWidth = center ? 1.5 : 1;
      ctx.strokeStyle = center ? 'rgba(214,234,250,0.85)' : 'rgba(120,160,200,0.16)';
      ctx.beginPath();
      for (const g of xs) {
        if (g.center !== center) continue;
        const [x] = P(-SENSOR.halfX + g.i * SENSOR.pitchX, 0);
        ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, bot);
      }
      for (const g of ys) {
        if (g.center !== center) continue;
        const [, y] = P(0, -SENSOR.halfY + g.i * SENSOR.pitchY);
        ctx.moveTo(left, Math.round(y) + 0.5); ctx.lineTo(right, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }
  // Pixels crossed by the track (geometric): a thin red border, so the charge colour stays readable.
  if (show.traversed) {
    ctx.strokeStyle = CROSSED_COLOR;
    ctx.lineWidth = 1;
    for (const p of traversed) {
      if (p.x < ix0 || p.x >= ix1 || p.y < iy0 || p.y >= iy1) continue;
      const [x, y, w, h] = cell(p.x, p.y);
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    }
  }
  ctx.strokeStyle = '#5f84a6';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);

  // Trajectory, split at the silicon: dashed off the sensor; inside it a faint
  // guide plus a bright part for the distance travelled so far.
  const reach = Math.max(0, Math.min(1, progress));
  ctx.lineCap = 'round';
  const stroke = (from, to) => {
    const a = pointAtProgress(trace, from);
    const b = pointAtProgress(trace, to);
    ctx.beginPath(); ctx.moveTo(...P(a.x, a.y)); ctx.lineTo(...P(b.x, b.y)); ctx.stroke();
  };
  for (const seg of trackSegments(trace, volume)) {
    if (seg.kind === 'off') {
      if (show.trackOff === false) continue;
      ctx.strokeStyle = 'rgba(255,155,110,0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      stroke(seg.from, seg.to);
      ctx.setLineDash([]);
    } else {
      if (show.trackIn === false) continue;
      ctx.strokeStyle = 'rgba(255,240,160,0.45)';
      ctx.lineWidth = 1;
      stroke(seg.from, seg.to);
      if (reach > seg.from) {
        ctx.strokeStyle = 'rgba(255,240,160,0.9)';
        ctx.lineWidth = 3;
        stroke(seg.from, Math.min(reach, seg.to));
      }
    }
  }

  // Side entry / exit through the lateral faces (reported separately from the HIT);
  // they belong to the in-sensor trajectory and follow its toggle.
  if (volume && show.trackIn !== false) {
    for (const [p, face] of [[volume.entry, volume.entryFace], [volume.exit, volume.exitFace]]) {
      if (face === 'top' || face === 'bottom') continue;
      const [x, y] = P(p.x, p.y);
      ctx.fillStyle = '#e879c9';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      labels.push({ text: `side ${face}`, ax: x, ay: y, x: x + 9, y: y + 16, color: '#f5b3e3' });
    }
  }

  // Plane crossing markers.
  for (const m of crossingMarkers(trace)) {
    if (!show[m.key] || reach + 1e-9 < m.progress) continue;
    const [x, y] = P(m.x, m.y);
    if (m.pixel) {
      const [cx, cy, w, h] = cell(m.pixel.x, m.pixel.y);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 1, cy - 1, w + 2, h + 2);
    }
    crosshair(ctx, x, y, m.color, m.inside);
    const text = m.inside ? `${m.title} · px (${m.pixel.x}, ${m.pixel.y})` : `${m.title} · outside sensor`;
    labels.push({ text, ax: x, ay: y, x: x + 12, y: y - 9, color: m.color });
  }

  // Particle position during the animation: a plain white circle.
  if (reach < 1) {
    const now = pointAtProgress(trace, reach);
    const [x, y] = P(now.x, now.y);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  }

  // Hovered pixel.
  if (hover?.pixel) {
    const [cx, cy, w, h] = cell(hover.pixel.x, hover.pixel.y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 0.5, cy - 0.5, w + 1, h + 1);
  }

  drawLabels(ctx, labels);
  drawAxes(ctx, t, units);
  return t;
}

/**
 * Greedy label placement: each label keeps its preferred spot unless it
 * overlaps one already placed, in which case it moves down (then up) in
 * 18 px steps; displaced labels get a thin leader line to their marker.
 */
export function placeLabels(items, measure, step = 18) {
  const placed = [];
  const box = (it, y) => {
    const w = measure(it.text) + 8;
    const x0 = it.align === 'right' ? it.x - w + 4 : it.x - 4;
    return { x0, x1: x0 + w, y0: y - 13, y1: y + 5 };
  };
  const hits = (b) => placed.some((p) => b.x0 < p.box.x1 && b.x1 > p.box.x0 && b.y0 < p.box.y1 && b.y1 > p.box.y0);
  for (const it of items) {
    let y = it.y;
    for (let k = 1; k <= 12 && hits(box(it, y)); k++) y = it.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
    placed.push({ ...it, y, box: box(it, y) });
  }
  return placed;
}

function drawLabels(ctx, items) {
  ctx.font = '600 12px system-ui, sans-serif';
  for (const it of placeLabels(items, (text) => ctx.measureText(text).width)) {
    const { box } = it;
    const near = it.ay >= box.y0 - 4 && it.ay <= box.y1 + 4;
    if (!near) {
      ctx.strokeStyle = it.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.align === 'right' ? box.x1 : box.x0, (box.y0 + box.y1) / 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    label(ctx, it.text, it.x, it.y, it.color, it.align);
  }
}

function crosshair(ctx, x, y, color, filled) {
  ctx.strokeStyle = '#0a1626';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
  if (filled) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.beginPath();
  ctx.moveTo(x - 11, y); ctx.lineTo(x - 7, y); ctx.moveTo(x + 7, y); ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 7); ctx.moveTo(x, y + 7); ctx.lineTo(x, y + 11);
  ctx.stroke();
}

function label(ctx, text, x, y, color, align = 'left') {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = align;
  const w = ctx.measureText(text).width;
  const bx = align === 'right' ? x - w - 4 : x - 4;
  ctx.fillStyle = 'rgba(8,22,37,0.82)';
  ctx.fillRect(bx, y - 12, w + 8, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

/** Canvas x of the y axis and canvas y of the x axis: the footprint edges, kept inside the padding. */
export function axisBaselines(t) {
  const [fx0] = t.toCanvas(-SENSOR.halfX, 0);
  const [, fy0] = t.toCanvas(0, -SENSOR.halfY);
  return { left: Math.max(t.pad.left, fx0), bottom: Math.min(t.height - t.pad.bottom, fy0) };
}

function drawAxes(ctx, t, units) {
  const { visible, toCanvas, scale, pad, width, height } = t;
  const ticks = axisTicks(visible, scale, units);
  const { left, bottom } = axisBaselines(t);
  ctx.fillStyle = '#0a1626';
  ctx.fillRect(0, height - pad.bottom, width, pad.bottom);
  ctx.fillRect(0, 0, pad.left, height);
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.strokeStyle = '#6b8aa6';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#9fb7cb';
  ctx.textAlign = 'center';
  for (const { at, text } of ticks.x) {
    const [px] = toCanvas(at, 0);
    ctx.beginPath(); ctx.moveTo(px, bottom); ctx.lineTo(px, bottom + 5); ctx.stroke();
    ctx.fillText(text, px, bottom + 17);
  }
  ctx.textAlign = 'right';
  for (const { at, text } of ticks.y) {
    const [, py] = toCanvas(0, at);
    if (py < pad.top - 2 || py > bottom) continue;
    ctx.beginPath(); ctx.moveTo(left - 5, py); ctx.lineTo(left, py); ctx.stroke();
    ctx.fillText(text, left - 8, py + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7f98ae';
  const [cx] = toCanvas((visible.x0 + visible.x1) / 2, 0);
  const [, cy] = toCanvas(0, (visible.y0 + visible.y1) / 2);
  ctx.fillText(ticks.title.x, cx, bottom + 33);
  ctx.save();
  ctx.translate(Math.max(13, left - 43), cy);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(ticks.title.y, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}
