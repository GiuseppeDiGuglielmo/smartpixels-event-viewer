import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeLevel, rampColor, chargeColor, RAMP_CSS } from '../src/chargeColors.js';

test('charge level is log-scaled, monotonic and clamped to [0, 1]', () => {
  assert.equal(chargeLevel(0, 1000), 0);
  assert.equal(chargeLevel(-5, 1000), 0);
  assert.equal(chargeLevel(10, 1000), 0);
  assert.equal(chargeLevel(1000, 1000), 1);
  assert.equal(chargeLevel(5000, 1000), 1);
  assert.ok(Math.abs(chargeLevel(100, 1000) - 0.5) < 1e-12);
  let prev = -1;
  for (const q of [11, 50, 100, 400, 999]) { const l = chargeLevel(q, 1000); assert.ok(l > prev); prev = l; }
  assert.equal(chargeLevel(100, 5), 0, 'degenerate scale');
});

test('ramp endpoints and CSS legend', () => {
  assert.deepEqual(rampColor(0), [68, 1, 84]);
  assert.deepEqual(rampColor(1), [253, 231, 37]);
  assert.deepEqual(chargeColor(1e6, 1e6), [253, 231, 37]);
  assert.match(RAMP_CSS, /^linear-gradient/);
});

import { pixelShading } from '../src/chargeColors.js';

test('pads are coloured only by loaded pixelAV charge', () => {
  const charge = { dense: new Float32Array(9216), scale: 1 };
  assert.equal(pixelShading({ mode: 'data', charge }), 'charge');
  assert.equal(pixelShading({ mode: 'data', charge: null }), 'none');
  assert.equal(pixelShading({ mode: 'demo', charge }), 'none');
  assert.equal(pixelShading({ mode: 'demo', charge: null }), 'none');
});
