import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSOR, ROI_SIZE, roiWindow, roiBounds, roiContains, traceParticle,
  progressAtZ, pointAtProgress, intersectVolume, traversedPixels, pixelAt,
} from '../src/geometry.js';
import { PRESETS } from '../src/presets.js';
import { trackSegments } from '../src/geometry.js';
import { CAMERA_PRESETS, matchingPreset } from '../src/sceneTransform.js';
import {
  SCENE_SCALE, toScene, fromScene, cameraDirection, anglesFromDirection,
} from '../src/sceneTransform.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected}`);
};

test('centered ROI puts the pixel at local (8,8) and is clamped inside the 48 × 192 array', () => {
  assert.deepEqual(roiWindow({ x: 24, y: 96 }), { x0: 16, x1: 32, y0: 88, y1: 104 });
  assert.deepEqual(roiWindow({ x: 0, y: 0 }), { x0: 0, x1: 16, y0: 0, y1: 16 });
  assert.deepEqual(roiWindow({ x: 47, y: 191 }), { x0: 32, x1: 48, y0: 176, y1: 192 });
  assert.deepEqual(roiWindow({ x: 3, y: 190 }), { x0: 0, x1: 16, y0: 176, y1: 192 });
  assert.equal(roiWindow(null), null);
  assert.equal(roiWindow({ x: 48, y: 0 }), null);
});

test('aligned ROI is the containing tile of a 3 × 12 tiling', () => {
  assert.deepEqual(roiWindow({ x: 17, y: 99 }, 'aligned'), { x0: 16, x1: 32, y0: 96, y1: 112 });
  assert.deepEqual(roiWindow({ x: 47, y: 191 }, 'aligned'), { x0: 32, x1: 48, y0: 176, y1: 192 });
  assert.deepEqual(roiWindow({ x: 15, y: 15 }, 'aligned'), { x0: 0, x1: 16, y0: 0, y1: 16 });
  assert.throws(() => roiWindow({ x: 1, y: 1 }, 'bogus'), RangeError);
});

test('every ROI contains its pixel and spans exactly 800 × 200 µm', () => {
  for (const mode of ['centered', 'aligned']) {
    for (let x = 0; x < SENSOR.pixelsX; x += 5) {
      for (let y = 0; y < SENSOR.pixelsY; y += 7) {
        const roi = roiWindow({ x, y }, mode);
        assert.ok(roiContains(roi, { x, y }));
        assert.equal(roi.x1 - roi.x0, ROI_SIZE);
        const b = roiBounds(roi);
        close(b.xMax - b.xMin, 800);
        close(b.yMax - b.yMin, 200);
        assert.ok(b.xMin >= -SENSOR.halfX && b.xMax <= SENSOR.halfX);
        assert.ok(b.yMin >= -SENSOR.halfY && b.yMax <= SENSOR.halfY);
      }
    }
  }
});

test('animation progress is linear in z: start 0, top/mid/bottom at the right fractions', () => {
  const t = traceParticle({ x0: 0, y0: 0, z0: 100, thetaX: 30, thetaY: 0 });
  close(progressAtZ(t, 100), 0);
  close(progressAtZ(t, 0), 0.5);
  close(progressAtZ(t, -50), 0.75);
  close(progressAtZ(t, -100), 1);
  const mid = pointAtProgress(t, 0.75);
  close(mid.x, t.mid.x); close(mid.y, t.mid.y); close(mid.z, -50);
  assert.deepEqual(pointAtProgress(t, 2), t.bottom);
});

test('volume intersection: normal incidence enters top and exits bottom with 100 µm chord', () => {
  const v = intersectVolume({ x0: 10, y0: -20, z0: 500, thetaX: 0, thetaY: 0 });
  assert.equal(v.entryFace, 'top');
  assert.equal(v.exitFace, 'bottom');
  close(v.length, 100);
  assert.equal(v.topHit, true);
});

test('volume intersection: oblique track exits through the +x side face', () => {
  // Hits top at x = 1150; tan 45° → reaches x = 1200 at z = -50.
  const v = intersectVolume({ x0: 1050, y0: 0, z0: 100, thetaX: 45, thetaY: 0 });
  assert.equal(v.entryFace, 'top');
  assert.equal(v.exitFace, 'x+');
  close(v.exit.x, 1200); close(v.exit.z, -50);
  close(v.length, 50 * Math.SQRT2);
});

test('side entry is reported by the volume test but NOT counted as a top-surface HIT', () => {
  // Top crossing at x = -1250 (outside), enters -x face at z = -50.
  const params = { x0: -1350, y0: 0, z0: 100, thetaX: 45, thetaY: 0 };
  assert.equal(traceParticle(params).hit, false);
  const v = intersectVolume(params);
  assert.equal(v.entryFace, 'x-');
  assert.equal(v.exitFace, 'bottom');
  close(v.entry.z, -50);
  assert.equal(v.topHit, false);
});

test('volume intersection is null for a clean miss (including the miss preset)', () => {
  assert.equal(intersectVolume(PRESETS.miss), null);
  assert.equal(intersectVolume({ x0: 2000, y0: 0, z0: 100, thetaX: 0, thetaY: 0 }), null);
  assert.equal(intersectVolume({ x0: 0, y0: 1500, z0: 100, thetaX: 0, thetaY: 5 }), null);
});

test('traversed pixels: vertical track crosses one column, full 100 µm', () => {
  const list = traversedPixels({ x0: 10, y0: -20, z0: 500, thetaX: 0, thetaY: 0 });
  assert.equal(list.length, 1);
  assert.deepEqual({ x: list[0].x, y: list[0].y }, pixelAt(10, -20));
  close(list[0].length, 100);
});

test('traversed pixels are contiguous neighbours, start at top pixel, end at exit pixel, lengths sum to chord', () => {
  for (const preset of [PRESETS.angled, PRESETS.grazing, PRESETS.straight]) {
    const t = traceParticle(preset);
    const v = intersectVolume(preset);
    const list = traversedPixels(preset);
    assert.ok(list.length >= 1);
    assert.deepEqual({ x: list[0].x, y: list[0].y }, t.topPixel);
    if (t.exitHit) assert.deepEqual({ x: list.at(-1).x, y: list.at(-1).y }, t.exitPixel);
    close(list.reduce((sum, p) => sum + p.length, 0), v.length, 1e-6);
    for (let i = 1; i < list.length; i++) {
      const step = Math.abs(list[i].x - list[i - 1].x) + Math.abs(list[i].y - list[i - 1].y);
      assert.ok(step >= 1 && step <= 2, `pixels ${i - 1}→${i} not adjacent`);
    }
  }
});

test('traversed pixels along pure Y slope step only in y (12.5 µm pitch)', () => {
  // Top crossing at y = -96.875 + 100 = 3.125 (row 96); dy over 100 µm depth = 100 µm = 8 pitches → rows 96..104.
  const list = traversedPixels({ x0: 25, y0: -96.875, z0: 100, thetaX: 0, thetaY: 45 });
  assert.equal(list.length, 9);
  assert.ok(list.every((p) => p.x === list[0].x));
  assert.deepEqual(list.map((p) => p.y), [96, 97, 98, 99, 100, 101, 102, 103, 104]);
});

test('scene transform is a proper rotation (no mirroring) and Z stretch is display-only', () => {
  const ex = toScene({ x: 1, y: 0, z: 0 });
  const ey = toScene({ x: 0, y: 1, z: 0 });
  const ez = toScene({ x: 0, y: 0, z: 1 });
  const cross = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
  // x̂ × ŷ must equal ẑ in the scene as well (right-handedness preserved).
  for (let i = 0; i < 3; i++) close(cross[i] / SCENE_SCALE ** 2, ez[i] / SCENE_SCALE);
  const p = { x: -620, y: 125, z: -50 };
  const s5 = toScene(p, 5);
  close(s5[0], toScene(p, 1)[0]);
  close(s5[2], toScene(p, 1)[2]);
  close(s5[1], 5 * toScene(p, 1)[1]);
  const back = fromScene(s5, 5);
  close(back.x, p.x); close(back.y, p.y); close(back.z, p.z);
});

test('camera azimuth/elevation round-trip and match the legacy basis', () => {
  for (const [az, el] of [[35, 30], [-90, 89], [170, -40], [0, 5]]) {
    const r = anglesFromDirection(cameraDirection(az, el));
    close(r.azimuth, az, 1e-9);
    close(r.elevation, el, 1e-9);
  }
  // Legacy: camera right vector (-sin az, cos az, 0) ⟂ view direction.
  const d = cameraDirection(35, 30);
  const az = 35 * Math.PI / 180;
  close(-Math.sin(az) * d.x + Math.cos(az) * d.y, 0);
});

/* ---------- boundary / tie regressions ---------- */

test('tie at the x− edge: a top-face HIT is never reported as a side entry', () => {
  // tan(45°) = 0.9999999999999999 → top crossing at x = −1200 (inside, half-open).
  const params = { x0: -1300, y0: 0, z0: 100, thetaX: 45, thetaY: 0 };
  const t = traceParticle(params);
  assert.equal(t.hit, true);
  assert.deepEqual(t.topPixel, { x: 0, y: 96 });
  const v = intersectVolume(params);
  assert.equal(v.entryFace, 'top');
  assert.deepEqual(traversedPixels(params)[0], { ...traversedPixels(params)[0], x: 0, y: 96 });
});

test('volume is half-open like pixelAt: vertical tracks on x = +1200 or y = +1200 miss', () => {
  assert.equal(intersectVolume({ x0: 1200, y0: 0, z0: 100, thetaX: 0, thetaY: 0 }), null);
  assert.equal(intersectVolume({ x0: 0, y0: 1200, z0: 100, thetaX: 0, thetaY: 0 }), null);
  const v = intersectVolume({ x0: -1200, y0: -1200, z0: 100, thetaX: 0, thetaY: 0 });
  assert.equal(v.entryFace, 'top');
  close(v.length, 100);
});

test('readouts agree: whenever the volume is crossed, at least one pixel is traversed', () => {
  for (const x0 of [-1300, -1250, -1200, 1150, 1200, 1250]) {
    for (const thetaX of [-75, -45, -10, 0, 10, 45, 75]) {
      const params = { x0, y0: 0, z0: 100, thetaX, thetaY: 0 };
      const v = intersectVolume(params);
      const list = traversedPixels(params);
      if (v) assert.ok(list.length > 0, `volume hit but no pixels for ${JSON.stringify(params)}`);
      if (traceParticle(params).hit) assert.equal(v.entryFace, 'top');
    }
  }
});

test('top crossing exactly on the excluded +x edge moving inward is a side entry, not a HIT', () => {
  // Top crossing at x = 1200 (outside, half-open), moving toward −x.
  const params = { x0: 1300, y0: 0, z0: 100, thetaX: -45, thetaY: 0 };
  assert.equal(traceParticle(params).hit, false);
  const v = intersectVolume(params);
  assert.equal(v.entryFace, 'x+');
  assert.equal(v.topHit, false);
});

test('side-in / side-out track near the (−x, −y) corner at ±75°', () => {
  // Top crossing at (−1210, −1180): outside in x. Enters x− at depth 10/tan75 ≈ 2.7 µm,
  // leaves y− at depth 20/tan75 ≈ 5.4 µm (before reaching the bottom).
  const T = 100 * Math.tan(75 * Math.PI / 180);
  const params = { x0: -1210 - T, y0: -1180 + T, z0: 100, thetaX: 75, thetaY: -75 };
  assert.equal(traceParticle(params).hit, false);
  const v = intersectVolume(params);
  assert.ok(v);
  assert.equal(v.entryFace, 'x-');
  assert.equal(v.exitFace, 'y-');
  const list = traversedPixels(params);
  assert.equal(list[0].x, 0, 'first traversed column is at the x− side face, not topPixel');
  close(list.reduce((sum, p) => sum + p.length, 0), v.length, 1e-6);
});

test('vertical track on an interior pixel boundary belongs to the higher column (half-open)', () => {
  const list = traversedPixels({ x0: -1150, y0: 0, z0: 100, thetaX: 0, thetaY: 0 });
  assert.equal(list.length, 1);
  assert.equal(list[0].x, 1);
});

test('trajectory segments split at the silicon and cover the whole path', () => {
  const kinds = (p) => trackSegments(traceParticle(p), intersectVolume(p)).map((g) => g.kind);
  assert.deepEqual(kinds(PRESETS.angled), ['off', 'in']);
  assert.deepEqual(kinds(PRESETS.miss), ['off']);
  const sideExit = { x0: 1000, y0: 0, z0: 100, thetaX: 60, thetaY: 0 }; // surface x ≈ 1173, bottom x ≈ 1346
  assert.deepEqual(kinds(sideExit), ['off', 'in', 'off']);
  const segs = trackSegments(traceParticle(sideExit), intersectVolume(sideExit));
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, 1);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to);
});

test('camera presets are recognised within 1°, and not after a free orbit', () => {
  for (const [name, [az, el]] of Object.entries(CAMERA_PRESETS)) assert.equal(matchingPreset(az + 0.4, el - 0.4), name);
  assert.equal(matchingPreset(35, 45), null);
  assert.equal(matchingPreset(270, 89), 'top', 'azimuth wraps around');
  assert.equal(matchingPreset(-90, 85, 5, 85), 'top', 'clamped elevation of the legacy renderer');
  assert.equal(matchingPreset(0, 5, 5, 85), 'yz');
});
