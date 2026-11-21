# Project specification — Pixel Sensor Particle Simulator

## Mission

Build an interactive visualization of a charged particle flying toward a silicon pixel sensor, entering the sensor at an arbitrary position and angle, traversing the volume, and showing where it intersects the pixels. The initial use case is an attractive research / presentation graphic; the architecture should allow future loading of simulated detector hit/charge data.

The source of the geometry is `assets/reference-geometry.png`. This project represents one **48 × 192 pixel region**, not the entire larger chip. Since milestone 1 (v0.2.0) the main view is a Three.js r187 WebGL renderer, vendored under `vendor/three/`. The original 2D-canvas projection remains as a fallback (`?renderer=2d`).

## 1. Sensor and axes

| Axis | Extent | Divisions | Pitch |
|---|---|---|---|
| X | 2400 µm | 48 | 50 µm |
| Y | 2400 µm | 192 | 12.5 µm |
| Z | 100 µm | bulk volume | — |

- Center the sensor laterally at X=0, Y=0.
- Pixel `(0,0)` occupies `[-1200,-1150) × [-1200,-1187.5)` µm².
- Pixel `(47,191)` is the opposite corner.
- Top z=0 µm, midplane z=−50 µm, bottom z=−100 µm.
- Physical dimensions are *not* distorted by the optional display-only Z stretch.
- ROI is 16 × 16 pixels, which corresponds to **800 µm along X and 200 µm along Y**. Two placements (`roiWindow` in geometry.js):
  - `centered`: the hit pixel sits at local (8, 8). Near the array edge the window shifts inward, so it always stays inside 0..47 × 0..191.
  - `aligned`: the containing tile of the fixed 3 × 12 tiling (x0 ∈ {0, 16, 32}, y0 ∈ {0, 16, …, 176}).
  The ROI panel is an *index-space display* (cells drawn square, +y up). This does not represent physical aspect ratio; the 3D view draws the ROI at true physical size.

## 2. Particle motion

A user can set (x0,y0,z0) and (thetaX,thetaY) for a single particle.

- Starting point must be above silicon (`z0 > 0`).
- `thetaX` sets `dx/d(-z)` and `thetaY` sets `dy/d(-z)`.
- As z decreases, x and y advance by `tan(thetaX)` and `tan(thetaY)` per micrometer respectively.
- Calculate and display intercepts at top/mid/bottom plane.
- Translate a top-plane impact to pixel indices by using the half-open physical footprint.
- For now, **HIT** means the extrapolated ray hits the top face of the sensor. This is deliberately narrower than full solid-volume ray-box intersection.
- `intersectVolume` (slab method, same half-open lateral footprint as `pixelAt`, 1e-9 µm tie tolerance; a top-face HIT always reports entry face `top`) separately reports the entry and exit faces (`top`, `bottom`, `x±`, `y±`) and the 3D chord. A side entry is shown in the UI but is **not** a HIT.
- `traversedPixels` lists the pixel columns crossed by the in-silicon segment, in track order, with the geometric path length in each. It splits the segment at pixel boundaries and classifies each piece by its midpoint, using the half-open convention.
- Animation progress runs linearly from the start (0) to the bottom-plane crossing (1): `progressAtZ`, `pointAtProgress`.

## 3. User experience (implemented)

- Volumetric translucent slab (WebGL) with a 48 × 192 pixel-pad texture and grid on top, midplane, backside, axis triad, and edge index labels.
- Control particle origin and direction; presets.
- Orbit, pan and zoom camera (OrbitControls), synced with the sliders and keyboard. View presets: top, side X–Z, side Y–Z, focus impact, reset.
- Play, pause, loop and seek the particle path. Top impact, midplane crossing and exit markers, with their pixels, appear as the particle reaches each plane.
- 16 × 16 ROI toggle (centered or aligned tile); pixels crossed by the track; illustrative Gaussian toggle; label toggle.
- Readouts: top/mid/bottom positions and pixel addresses, volume entry→exit faces and chord, number of pixels crossed.
- PNG export of the 3D canvas.

## 4. Visual and physics assumptions

The 3D view uses Three.js with a perspective camera. Physical µm are mapped to scene units only in `src/sceneTransform.js`: `(x, z·stretch, −y)·0.01`, a proper rotation with no mirroring. Z is exaggerated to improve readability, and this affects the display only.

No actual particle/material interaction is simulated. The line is straight, with no magnetic field, multiple scattering, or energy loss. Pixel brightness comes from an arbitrary Gaussian centered at the extrapolated *surface* point. This should never be reported as charge in electrons without replacing it with real response data.

## 5. Future feature proposals (not implemented)

1. **WebGL renderer:** *done in v0.2.0* (orbit camera, transparent volume). Still open: selectable pixels, a clipping plane, and a multi-track event view.
2. **More physical path intersection:** *done* as the separate `intersectVolume` / `traversedPixels`. Still open: deciding whether a side entry should count as a HIT (a scientific decision).
3. **Charge cloud / drift:** optional idealized visualization of ionization and carrier drift, clearly labeled illustrative unless physics solver is integrated.
4. **External data:** *done in v0.3.0* for pixelAV parquet datasets (converted to a sparse, Range-addressable format). See `docs/PIXELAV_DATA.md`.
5. **ROI and ML:** overlay 16 × 16 ROI, center-finding, projected impact at z=−50, and reconstruction comparison.
6. **Publication output:** repeatable camera poses, adjustable colors, annotated image export and timeline video frames.

## 6. Acceptance and tests

- `npm test` passes the 9 original geometry tests plus the volume/ROI/scene-transform tests.
- `npm run dev` serves the UI locally with no dependency installation.
- Starting point and angles visibly change the trajectory and numeric intercept readouts.
- Edge handling honors the half-open footprint, and a miss has no pixel address.
- The panel layout and controls stay those of `assets/preview.png`; the 3D view looks like `assets/preview-3d.png`.
- No user-visible feature claims non-existent physical accuracy.
