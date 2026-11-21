/**
 * 2D top view of the full 48 × 192 pixel array (the "2D pixel map").
 *
 * Physical aspect: the map is drawn in µm with equal X and Y scale, so each
 * pixel appears 50 × 12.5 µm. +x to the right, +y UP (same as the 3D top view
 * and the ROI panel); pixel indices are zero-based and never transposed.
 *
 * Pixel colours: pixelAV SIMULATED charge in data mode (pixelShading), nothing
 * in demo mode. Everything else is geometry from geometry.js: the projected
 * track, the pixels it crosses, and the crossing points at the top surface
 * (z = 0), the midplane (z = −50) and the exit plane (z = −100).
 *
 * The layout helpers (mapWindow, mapTransform, crossingMarkers, pickPixel) are
 * pure and tested in Node; drawPixelMap needs only a CanvasRenderingContext2D.
 */
import { SENSOR, pixelAt, progressAtZ, pointAtProgress } from './geometry.js';
import { chargeColor, pixelShading } from './chargeColors.js';

export const FULL_WINDOW = Object.freeze({ x0: -SENSOR.halfX, x1: SENSOR.halfX, y0: -SENSOR.halfY, y1: SENSOR.halfY });
export const MAP_FITS = Object.freeze(['track', 'full']);

/** Crossing markers, in drawing order. `z` is the physical plane in µm. Colours match the 3D markers. */
export const CROSSINGS = Object.freeze([
  { key: 'top', z: SENSOR.zTop, title: 'surface', long: 'Top-surface impact (z = 0)', color: '#62f5f3' },
  { key: 'mid', z: SENSOR.zMid, title: 'midplane', long: 'Midplane crossing (z = −50 µm)', color: '#8fc3ff' },
  { key: 'exit', z: SENSOR.zBottom, title: 'exit', long: 'Exit plane (z = −100 µm)', color: '#ffa070' },
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

/**
 * Draw the map. `options`:
 *  trace, volume, traversed, roi, charge, mode, progress (0..1),
 *  show: { grid, traversed, roi, top, mid, exit, centroid, labels },
 *  fit ('track' | 'full'), hover ({ pixel, x, y } | null), dpr.
 * Returns the transform used (for hover picking).
 */
export function drawPixelMap(ctx, width, height, options) {
  const { trace, volume = null, traversed = [], roi = null, charge = null, frameCharge = null, mode = 'demo', progress = 1, show = {}, fit = 'track', hover = null, dpr = 1 } = options;
  const shading = pixelShading({ mode, charge });
  // Frame on `frameCharge` (e.g. the event's last slice) so the view stays put while scrubbing slices.
  const win = mapWindow(fit, { trace, volume, charge: shading === 'charge' ? (frameCharge ?? charge) : null });
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
      if (!(charges[i] > 0)) continue;
      const [r, g, b] = chargeColor(charges[i], charge.scale);
      fillCell(indices[i] % SENSOR.pixelsX, Math.floor(indices[i] / SENSOR.pixelsX), `rgb(${r},${g},${b})`);
    }
  }

  // Pixels crossed by the track (geometric), drawn as an amber wash.
  if (show.traversed) {
    for (const p of traversed) {
      if (p.x < ix0 || p.x >= ix1 || p.y < iy0 || p.y >= iy1) continue;
      fillCell(p.x, p.y, shading === 'charge' ? 'rgba(255,180,106,0.22)' : 'rgba(255,180,106,0.5)');
    }
  }

  // Grid: every pixel boundary when it is at least 4 canvas px apart, otherwise every n-th.
  if (show.grid) {
    const every = (pitch) => Math.max(1, Math.ceil(4 / (pitch * scale)));
    ctx.lineWidth = 1;
    const ex = every(SENSOR.pitchX);
    const ey = every(SENSOR.pitchY);
    ctx.strokeStyle = 'rgba(120,160,200,0.22)';
    ctx.beginPath();
    for (let ix = ix0 - (ix0 % ex); ix <= ix1; ix += ex) {
      const [x] = P(-SENSOR.halfX + ix * SENSOR.pitchX, 0);
      ctx.moveTo(Math.round(x) + 0.5, Math.max(fy0, 0)); ctx.lineTo(Math.round(x) + 0.5, Math.min(fy1, height));
    }
    for (let iy = iy0 - (iy0 % ey); iy <= iy1; iy += ey) {
      const [, y] = P(0, -SENSOR.halfY + iy * SENSOR.pitchY);
      ctx.moveTo(Math.max(fx0, 0), Math.round(y) + 0.5); ctx.lineTo(Math.min(fx1, width), Math.round(y) + 0.5);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = '#5f84a6';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);

  // 16 × 16 ROI.
  if (show.roi && roi) {
    const [rx, ry] = P(-SENSOR.halfX + roi.x0 * SENSOR.pitchX, -SENSOR.halfY + roi.y1 * SENSOR.pitchY);
    const w = (roi.x1 - roi.x0) * SENSOR.pitchX * scale;
    const h = (roi.y1 - roi.y0) * SENSOR.pitchY * scale;
    ctx.fillStyle = 'rgba(199,146,255,0.08)';
    ctx.fillRect(rx, ry, w, h);
    ctx.strokeStyle = '#c792ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, w, h);
    ctx.setLineDash([]);
  }

  // Projected track: dashed above the surface, solid inside the silicon (top → bottom plane).
  const [sx, sy] = P(trace.start.x, trace.start.y);
  const [tx, ty] = P(trace.top.x, trace.top.y);
  const [bx, by] = P(trace.bottom.x, trace.bottom.y);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,155,110,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.setLineDash([]);
  const reach = Math.max(0, Math.min(1, progress));
  // Bright: the part of the path inside the silicon travelled so far (volume entry → min(now, exit)).
  if (volume) {
    const enter = progressAtZ(trace, volume.entry.z);
    const leave = Math.min(reach, progressAtZ(trace, volume.exit.z));
    if (leave > enter) {
      const [ex, ey] = P(volume.entry.x, volume.entry.y);
      const now = pointAtProgress(trace, leave);
      const [nx, ny] = P(now.x, now.y);
      ctx.strokeStyle = 'rgba(255,240,160,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(nx, ny); ctx.stroke();
    }
  }
  // Faint guide for the segment inside the silicon: the volume chord when it
  // exists (clipped at side faces), otherwise the top → exit-plane projection.
  const [gx0, gy0] = volume ? P(volume.entry.x, volume.entry.y) : [tx, ty];
  const [gx1, gy1] = volume ? P(volume.exit.x, volume.exit.y) : [bx, by];
  ctx.strokeStyle = volume ? 'rgba(255,240,160,0.45)' : 'rgba(255,240,160,0.2)';
  ctx.lineWidth = 1;
  if (!volume) ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(gx0, gy0); ctx.lineTo(gx1, gy1); ctx.stroke();
  ctx.setLineDash([]);

  // Side entry / exit through the lateral faces (reported separately from the HIT).
  if (volume) {
    for (const [p, face] of [[volume.entry, volume.entryFace], [volume.exit, volume.exitFace]]) {
      if (face === 'top' || face === 'bottom') continue;
      const [x, y] = P(p.x, p.y);
      ctx.fillStyle = '#e879c9';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (show.labels) labels.push({ text: `side ${face}`, ax: x, ay: y, x: x + 9, y: y + 16, color: '#f5b3e3' });
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
    if (show.labels) {
      const text = m.inside ? `${m.title} · px (${m.pixel.x}, ${m.pixel.y})` : `${m.title} · outside sensor`;
      labels.push({ text, ax: x, ay: y, x: x + 12, y: y - 9, color: m.color });
    }
  }

  // Charge-weighted centroid of the simulated charge (data mode).
  if (show.centroid && shading === 'charge' && charge.stats?.centroid) {
    const { x: cx0, y: cy0 } = charge.stats.centroid;
    const [x, y] = P(cx0, cy0);
    ctx.fillStyle = '#fde68a';
    ctx.strokeStyle = '#0a1626';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath();
    ctx.fill(); ctx.stroke();
    if (show.labels) labels.push({ text: 'charge centroid', ax: x, ay: y, x: x - 12, y: y + 20, color: '#fde68a', align: 'right' });
  }

  // Particle position during the animation.
  if (reach < 1) {
    const now = pointAtProgress(trace, reach);
    const [x, y] = P(now.x, now.y);
    ctx.fillStyle = '#ffe1b0';
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
  drawAxes(ctx, t);
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

function drawAxes(ctx, t) {
  const { visible, toCanvas, scale, pad, width, height } = t;
  const step = tickStep(scale);
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillStyle = '#9fb7cb';
  ctx.strokeStyle = '#6b8aa6';
  ctx.lineWidth = 1;
  const bottom = height - pad.bottom;
  ctx.fillStyle = '#0a1626';
  ctx.fillRect(0, bottom, width, pad.bottom);
  ctx.fillRect(0, 0, pad.left, height);
  ctx.fillStyle = '#9fb7cb';
  ctx.textAlign = 'center';
  for (let x = Math.ceil(visible.x0 / step) * step; x <= visible.x1; x += step) {
    const [px] = toCanvas(x, 0);
    ctx.beginPath(); ctx.moveTo(px, bottom); ctx.lineTo(px, bottom + 5); ctx.stroke();
    ctx.fillText(String(Math.round(x * 10) / 10), px, bottom + 17);
  }
  ctx.textAlign = 'right';
  for (let y = Math.ceil(visible.y0 / step) * step; y <= visible.y1; y += step) {
    const [, py] = toCanvas(0, y);
    if (py < pad.top - 2 || py > bottom) continue;
    ctx.beginPath(); ctx.moveTo(pad.left - 5, py); ctx.lineTo(pad.left, py); ctx.stroke();
    ctx.fillText(String(Math.round(y * 10) / 10), pad.left - 8, py + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7f98ae';
  ctx.fillText('x (µm) →', pad.left + (width - pad.left - pad.right) / 2, bottom + 33);
  ctx.save();
  ctx.translate(13, pad.top + (bottom - pad.top) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('y (µm) →', 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}
