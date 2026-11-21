import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSOR, DEFAULT_STATE, pixelAt, pixelCenter, traceParticle,
} from '../src/geometry.js';

const close = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected}`);
};

test('dimensions are exactly 48 × 192 and 2400 × 2400 × 100 µm', () => {
  assert.equal(SENSOR.pixelsX * SENSOR.pitchX, 2400);
  assert.equal(SENSOR.pixelsY * SENSOR.pitchY, 2400);
  assert.equal(SENSOR.pixelsX * SENSOR.pixelsY, 9216);
  assert.equal(SENSOR.zMid, -50);
  assert.equal(SENSOR.zBottom, -100);
});

test('central perpendicular ray keeps x and y across all sensor planes', () => {
  const t = traceParticle({ x0: 10, y0: -20, z0: 500, thetaX: 0, thetaY: 0 });
  assert.equal(t.hit, true);
  assert.equal(t.top.x, 10);
  assert.equal(t.mid.x, 10);
  assert.equal(t.bottom.y, -20);
  assert.deepEqual(t.topPixel, { x: 24, y: 94 });
});

test('angled ray follows independent x and y slopes', () => {
  const t = traceParticle({ x0: 0, y0: 0, z0: 100, thetaX: 45, thetaY: -45 });
  close(t.top.x, 100);
  close(t.top.y, -100);
  close(t.mid.x, 150);
  close(t.mid.y, -150);
  close(t.bottom.x, 200);
  close(t.bottom.y, -200);
});

test('boundary convention is half-open and indices are zero-based', () => {
  assert.deepEqual(pixelAt(-1200, -1200), { x: 0, y: 0 });
  assert.deepEqual(pixelAt(1199.999, 1199.999), { x: 47, y: 191 });
  assert.equal(pixelAt(1200, 0), null);
  assert.equal(pixelAt(0, 1200), null);
  assert.equal(pixelAt(-1200.001, 0), null);
  assert.equal(pixelAt(0, -1200.001), null);
  assert.equal(pixelAt(NaN, 1), null);
});

test('center coordinates map back to the correct pixels', () => {
  for (const [x, y] of [[0, 0], [47, 191], [23, 96]]) {
    const c = pixelCenter(x, y);
    assert.deepEqual(pixelAt(c.x, c.y), { x, y });
  }
  assert.equal(pixelCenter(-1, 10), null);
  assert.equal(pixelCenter(1, 192), null);
});

test('miss case does not yield an impact address', () => {
  const t = traceParticle({ x0: 1600, y0: 0, z0: 300, thetaX: 0, thetaY: 0 });
  assert.equal(t.hit, false);
  assert.equal(t.topPixel, null);
});

test('particle starts above silicon with finite values', () => {
  assert.throws(() => traceParticle({ x0: 0, y0: 0, z0: 0, thetaX: 0, thetaY: 0 }), RangeError);
  assert.throws(() => traceParticle({ x0: Infinity, y0: 0, z0: 10, thetaX: 0, thetaY: 0 }), TypeError);
});

test('default demonstration has a top-surface hit', () => {
  assert.equal(traceParticle(DEFAULT_STATE).hit, true);
});

