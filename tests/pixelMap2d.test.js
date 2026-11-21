import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR, DEFAULT_STATE, traceParticle, pixelCenter, intersectVolume, traversedPixels } from '../src/geometry.js';
import {
  FULL_WINDOW, MAP_FITS, MAJOR, crossingMarkers, mapWindow, mapTransform, pickPixel, tickStep, drawPixelMap,
  axisTicks, indexStep, gridLines, axisBaselines,
} from '../src/pixelMap2d.js';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

test('crossing markers are the top, midplane and exit-plane points of the trace', () => {
  const trace = traceParticle(DEFAULT_STATE);
  const [top, mid, exit] = crossingMarkers(trace);
  assert.deepEqual([top.key, mid.key, exit.key], ['top', 'mid', 'exit']);
  assert.deepEqual([top.z, mid.z, exit.z], [0, -50, -100]);
  close(top.x, trace.top.x); close(top.y, trace.top.y);
  close(mid.x, trace.mid.x); close(mid.y, trace.mid.y);
  close(exit.x, trace.bottom.x); close(exit.y, trace.bottom.y);
  assert.deepEqual(top.pixel, trace.topPixel);
  assert.deepEqual(mid.pixel, trace.midPixel);
  assert.deepEqual(exit.pixel, trace.exitPixel);
  assert.ok(top.progress < mid.progress && mid.progress < exit.progress && exit.progress === 1);
});

test('crossings outside the footprint are flagged, not snapped to a pixel', () => {
  const trace = traceParticle({ x0: 1180, y0: 0, z0: 100, thetaX: 60, thetaY: 0 });
  const [top, , exit] = crossingMarkers(trace);
  assert.equal(top.inside, false);
  assert.equal(top.pixel, null);
  assert.equal(exit.inside, false);
});

test('transform keeps equal X/Y scale, +x right and +y up, and round-trips', () => {
  const t = mapTransform(FULL_WINDOW, 1000, 525);
  const [ax, ay] = t.toCanvas(0, 0);
  const [bx, by] = t.toCanvas(100, 100);
  close(bx - ax, 100 * t.scale);
  close(ay - by, 100 * t.scale); // +y is up on the canvas
  const back = t.toUm(...t.toCanvas(-333.3, 777.7));
  close(back.x, -333.3, 1e-9); close(back.y, 777.7, 1e-9);
  // The whole footprint fits, limited by the shorter (vertical) direction.
  assert.ok(t.visible.x0 <= -1200 && t.visible.x1 >= 1200);
  close(t.visible.y0, -1200); close(t.visible.y1, 1200);
});

test('picking the centre of a pixel returns that pixel (no transpose)', () => {
  for (const fit of ['full', 'track']) {
    const win = fit === 'full' ? FULL_WINDOW : { x0: -200, x1: 300, y0: 500, y1: 700 };
    const t = mapTransform(win, 900, 600);
    for (const [ix, iy] of [[3, 150], [40, 7], [0, 0], [47, 191], [23, 95]]) {
      const c = pixelCenter(ix, iy);
      const hit = pickPixel(t, ...t.toCanvas(c.x, c.y));
      assert.deepEqual(hit.pixel, { x: ix, y: iy });
    }
  }
  const t = mapTransform(FULL_WINDOW, 900, 600);
  assert.equal(pickPixel(t, ...t.toCanvas(1300, 0)).pixel, null);
});

test('"around the track" frames every on-sensor crossing and charged pixel', () => {
  const trace = traceParticle(DEFAULT_STATE);
  const charge = { sparse: { indices: Uint16Array.of(10 * 48 + 5, 180 * 48 + 40), charges: Float32Array.of(100, 50) } };
  const win = mapWindow('track', { trace, charge });
  for (const p of [trace.top, trace.mid, trace.bottom]) {
    assert.ok(p.x >= win.x0 && p.x <= win.x1 && p.y >= win.y0 && p.y <= win.y1);
  }
  // Charged pixels (5, 10) and (40, 180), including their far edges.
  assert.ok(win.x0 <= -1200 + 5 * 50 && win.x1 >= -1200 + 41 * 50);
  assert.ok(win.y0 <= -1200 + 10 * 12.5 && win.y1 >= -1200 + 181 * 12.5);
  // Normal incidence at one point still gets the minimum span.
  const point = mapWindow('track', { trace: traceParticle({ x0: 0, y0: 0, z0: 100, thetaX: 0, thetaY: 0 }) });
  close(point.x1 - point.x0, 400); close(point.y1 - point.y0, 400);
  // Zero / negative charge is ignored.
  const ignored = mapWindow('track', { trace: traceParticle({ x0: 0, y0: 0, z0: 100, thetaX: 0, thetaY: 0 }), charge: { sparse: { indices: Uint16Array.of(0), charges: Float32Array.of(-3) } } });
  close(ignored.x1 - ignored.x0, 400);
});

test('full view, and a track that misses the sensor, show the whole footprint', () => {
  assert.deepEqual(mapWindow('full', { trace: traceParticle(DEFAULT_STATE) }), FULL_WINDOW);
  const miss = traceParticle({ x0: 3000, y0: 3000, z0: 100, thetaX: 0, thetaY: 0 });
  assert.deepEqual(mapWindow('track', { trace: miss }), FULL_WINDOW);
});

test('tick steps are 1/2/2.5/5 × 10^n and at least the requested spacing', () => {
  for (const scale of [0.05, 0.2, 1, 3.7, 12]) {
    const step = tickStep(scale, 70);
    assert.ok(step * scale >= 70 - 1e-9);
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9), `step ${step}`);
  }
});

/** Minimal CanvasRenderingContext2D stand-in that records filled rectangles. */
function recordingContext() {
  const fills = [];
  const strokes = [];
  const ctx = new Proxy({ fillStyle: '', strokeStyle: '', measureText: (s) => ({ width: s.length * 6 }) }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'fillRect') return (x, y, w, h) => fills.push({ style: target.fillStyle, x, y, w, h });
      if (key === 'strokeRect') return () => strokes.push(target.strokeStyle);
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { ctx, fills, strokes };
}

const showAll = { grid: true, traversed: true, roi: true, top: true, mid: true, exit: true, centroid: true, labels: true };

function drawWith(extra) {
  const { ctx, fills, strokes } = recordingContext();
  const trace = traceParticle(DEFAULT_STATE);
  drawPixelMap(ctx, 1000, 525, {
    trace, volume: intersectVolume(DEFAULT_STATE), traversed: traversedPixels(DEFAULT_STATE), show: showAll, ...extra,
  });
  return { fills, strokes, trace };
}

test('demo mode never paints charge colours; data mode paints exactly the charged pixels', () => {
  const ramp = (f) => /^rgb\(/.test(f.style);
  assert.equal(drawWith({ mode: 'demo' }).fills.filter(ramp).length, 0);
  const charge = {
    sparse: { indices: Uint16Array.of(100, 101, 4000), charges: Float32Array.of(500, 20, 0) },
    scale: 500,
    stats: { centroid: { x: 0, y: 0 } },
  };
  assert.equal(drawWith({ mode: 'demo', charge }).fills.filter(ramp).length, 0);
  assert.equal(drawWith({ mode: 'data', charge }).fills.filter(ramp).length, 2);
});

test('crossing markers appear only once the animated particle reaches them', () => {
  const colours = { top: '#62f5f3', mid: '#8fc3ff', exit: '#ffa070' };
  const at = (progress) => drawWith({ mode: 'demo', progress }).strokes;
  const trace = traceParticle(DEFAULT_STATE);
  const [top, mid] = crossingMarkers(trace);
  assert.ok(!at(0).includes(colours.top));
  const afterTop = at((top.progress + mid.progress) / 2);
  assert.ok(afterTop.includes(colours.top) && !afterTop.includes(colours.mid) && !afterTop.includes(colours.exit));
  const done = at(1);
  assert.ok(done.includes(colours.top) && done.includes(colours.mid) && done.includes(colours.exit));
  // Each toggle hides its own marker only.
  const { strokes } = drawWith({ mode: 'demo', show: { ...showAll, mid: false } });
  assert.ok(strokes.includes(colours.top) && !strokes.includes(colours.mid) && strokes.includes(colours.exit));
  assert.ok(SENSOR.zMid === -50);
});

import { placeLabels } from '../src/pixelMap2d.js';

test('labels of nearby markers are moved apart instead of overlapping', () => {
  const measure = (text) => text.length * 7;
  const items = [
    { text: 'surface · px (17, 99)', x: 100, y: 100 },
    { text: 'midplane · px (18, 98)', x: 104, y: 102 },
    { text: 'exit · px (19, 98)', x: 108, y: 104 },
  ];
  const placed = placeLabels(items, measure);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].box; const b = placed[j].box;
      assert.ok(!(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0), `labels ${i} and ${j} overlap`);
    }
  }
  assert.equal(placed[0].y, 100); // the first label keeps its spot
  // Far-apart labels are not moved.
  const apart = placeLabels([{ text: 'a', x: 0, y: 0 }, { text: 'b', x: 500, y: 300 }], measure);
  assert.deepEqual(apart.map((p) => p.y), [0, 300]);
});

test('"around the track" also frames side entry / exit points on the sensor edge', () => {
  // Enters through the x+ side face; top crossing is outside the footprint.
  const params = { x0: 1400, y0: 0, z0: 100, thetaX: -60, thetaY: 0 }; // top at x ≈ 1227 (off sensor)
  const trace = traceParticle(params);
  const volume = intersectVolume(params);
  assert.ok(volume && volume.entryFace === 'x+' && !trace.hit);
  const win = mapWindow('track', { trace, volume });
  for (const p of [volume.entry, volume.exit]) {
    assert.ok(p.x >= win.x0 && p.x <= win.x1 && p.y >= win.y0 && p.y <= win.y1);
  }
  assert.ok(win.x1 - win.x0 < 2400); // not the full-sensor fallback
});

test('the map can be framed on a different slice than the one drawn', () => {
  const trace = traceParticle({ x0: 0, y0: 0, z0: 100, thetaX: 0, thetaY: 0 });
  const early = { sparse: { indices: Uint16Array.of(96 * 48 + 24), charges: Float32Array.of(10) } };
  const late = { sparse: { indices: Uint16Array.of(96 * 48 + 24, 96 * 48 + 40), charges: Float32Array.of(10, 10) } };
  assert.ok(mapWindow('track', { trace, charge: late }).x1 > mapWindow('track', { trace, charge: early }).x1);
});

test('a charged pixel is painted exactly over its own cell (+y up, no transpose)', () => {
  const { ctx, fills } = recordingContext();
  const ix = 4; const iy = 2; // asymmetric so a transpose would move it
  const charge = { sparse: { indices: Uint16Array.of(iy * 48 + ix), charges: Float32Array.of(100) }, scale: 100, stats: {} };
  const trace = traceParticle(DEFAULT_STATE);
  const t = drawPixelMap(ctx, 1000, 525, { trace, mode: 'data', charge, fit: 'full', show: {} });
  const cellFill = fills.find((f) => /^rgb\(/.test(f.style));
  const [left, topEdge] = t.toCanvas(-1200 + ix * 50, -1200 + (iy + 1) * 12.5); // top-left corner: upper y edge
  close(cellFill.x, left, 1e-9);
  close(cellFill.y, topEdge, 1e-9);
  close(cellFill.w, 50 * t.scale, 1e-9);
  close(cellFill.h, 12.5 * t.scale, 1e-9);
});

test('picking on a pixel boundary follows the half-open rule', () => {
  const t = mapTransform(FULL_WINDOW, 900, 600);
  // x = −1000 is the left edge of column 4; y = −1175 the lower edge of row 2.
  assert.deepEqual(pickPixel(t, ...t.toCanvas(-1000, -1175)).pixel, { x: 4, y: 2 });
});

test('the default framing is the whole 48 × 192 array, and a square canvas shows exactly the footprint', () => {
  assert.equal(MAP_FITS[0], 'full');
  assert.deepEqual(mapWindow(undefined, { trace: traceParticle(DEFAULT_STATE) }), FULL_WINDOW);
  const pad = { left: 56, right: 16, top: 16, bottom: 40 };
  const t = mapTransform(FULL_WINDOW, 800 + 72, 800 + 56, pad);
  close(t.scale, 800 / 2400);
  close(t.visible.x0, -1200); close(t.visible.x1, 1200);
  close(t.visible.y0, -1200); close(t.visible.y1, 1200);
});

test('pixel-unit ticks sit at pixel centres, zero-based, never beyond 47 / 191', () => {
  const t = mapTransform(FULL_WINDOW, 872, 856);
  const ticks = axisTicks(t.visible, t.scale, 'px');
  assert.equal(ticks.x[0].text, '0');
  close(ticks.x[0].at, -1200 + 25);
  close(ticks.y[0].at, -1200 + 6.25);
  for (const { at, text } of ticks.x) {
    const i = Number(text);
    assert.ok(i >= 0 && i <= 47);
    close(at, pixelCenter(i, 0).x);
  }
  for (const { at, text } of ticks.y) {
    const i = Number(text);
    assert.ok(i >= 0 && i <= 191);
    close(at, pixelCenter(0, i).y);
  }
  assert.match(ticks.title.x, /pixel index/);
  // Steps are powers of two and leave at least 40 canvas px between labels.
  const sx = Number(ticks.x[1].text) - Number(ticks.x[0].text);
  const sy = Number(ticks.y[1].text) - Number(ticks.y[0].text);
  assert.ok([1, 2, 4, 8, 16, 32, 64].includes(sx) && [1, 2, 4, 8, 16, 32, 64].includes(sy));
  assert.ok(sx * SENSOR.pitchX * t.scale >= 40 && sy * SENSOR.pitchY * t.scale >= 40);
  assert.equal(indexStep(SENSOR.pitchY, 1000), 1);
});

test('µm ticks stay on the sensor footprint even when the canvas is wider', () => {
  const t = mapTransform(FULL_WINDOW, 1000, 525); // wide canvas: visible x spans beyond ±1200
  assert.ok(t.visible.x0 < -1200);
  const ticks = axisTicks(t.visible, t.scale, 'um');
  assert.ok(ticks.x.every(({ at }) => at >= -1200 && at <= 1200));
  assert.ok(ticks.x.some(({ at }) => at === 0));
  assert.match(ticks.title.y, /µm/);
});

test('grid lines: every boundary when dense enough, majors every 16 pixels always kept', () => {
  const all = gridLines(0, 48, SENSOR.pitchX, 1);
  assert.equal(all.length, 49);
  assert.deepEqual(all.filter((g) => g.major).map((g) => g.i), [0, 16, 32, 48]);
  const thin = gridLines(0, 192, SENSOR.pitchY, 0.05); // 0.6 px apart: thinned
  assert.ok(thin.length < 193);
  assert.deepEqual(thin.filter((g) => g.major).map((g) => g.i), Array.from({ length: 13 }, (_, k) => k * MAJOR));
  // Thinned lines are evenly spaced, also across the major lines.
  const gaps = new Set(gridLines(0, 40, SENSOR.pitchY, 0.07).slice(1).map((g, k, a) => g.i - (k ? a[k - 1].i : 0)));
  assert.equal(gaps.size, 1);
});

test('axes sit on the footprint edges on a non-square canvas, and on the padding when zoomed in', () => {
  const t = mapTransform(FULL_WINDOW, 1000, 600); // wide: the sensor is centred horizontally
  const { left, bottom } = axisBaselines(t);
  close(left, t.toCanvas(-1200, 0)[0]);
  close(bottom, t.toCanvas(0, -1200)[1]);
  assert.ok(left > t.pad.left);
  const zoom = mapTransform({ x0: -100, x1: 100, y0: -100, y1: 100 }, 1000, 600);
  assert.deepEqual(axisBaselines(zoom), { left: zoom.pad.left, bottom: 600 - zoom.pad.bottom });
});
