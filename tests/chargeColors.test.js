import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeLevel, rampColor, chargeColor, chargeLegend, RAMP_CSS } from '../src/chargeColors.js';

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

test('negative charge has its own ramp, with the same level for the same |q|', () => {
  assert.deepEqual(chargeColor(-1000, 1000), [255, 140, 130]);
  assert.notDeepEqual(chargeColor(-100, 1000), chargeColor(100, 1000));
  assert.deepEqual(chargeColor(-5, 1000), chargeColor(5, 1000), 'both ramps meet below the floor');
});

test('legend spans the signed range with zero between the ends', () => {
  const { gradient, ticks } = chargeLegend(-2333, 67884);
  assert.match(gradient, /^linear-gradient/);
  assert.equal(ticks[0].text, '−2.3k');
  assert.equal(ticks[0].at, 0);
  assert.equal(ticks.at(-1).text, '67.9k');
  assert.equal(ticks.at(-1).at, 100);
  const zero = ticks.find((t) => t.q === 0);
  assert.ok(zero.at > 0 && zero.at < 100);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].at > ticks[i - 1].at);
  assert.ok(ticks.some((t) => t.q === 1000) && ticks.some((t) => t.q === -100));
});

test('legend without negative charge starts at zero', () => {
  const { ticks } = chargeLegend(0, 5000);
  assert.equal(ticks[0].q, 0);
  assert.equal(ticks[0].at, 0);
});
