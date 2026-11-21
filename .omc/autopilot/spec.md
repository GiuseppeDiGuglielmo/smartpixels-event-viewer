# Autopilot spec — milestone 3: remove the Gaussian, add a 2D pixel map

Request (2026-11-21): "remove the illustrative gaussian code, and add a feature to show it in 2d? on the 2d
there should be an option to highlight center of impact on the surface, midplane, and on the exit".
User answers: 2D = pixel map in both modes; placement = 3D/2D toggle in the main viewport.

## Requirements
1. Remove `illustrativeWeight` and every Gaussian path: geometry.js, renderer3d, legacy renderer, ROI panel,
   pixelShading ('gaussian' state), the toggle, legend, captions, tests, docs. Demo mode becomes a purely
   geometric demo (no pixel brightness). Data mode is unchanged.
2. New 2D pixel map (top view, full 48 × 192 array, physical aspect: 2400 × 2400 µm square, so pixels look
   50 × 12.5 µm). Shown in the main viewport via a 3D / 2D switch; the 3D renderer keeps its state.
   - Data mode: pixels coloured by pixelAV simulated charge (same ramp, same slice/threshold state).
   - Demo mode: no charge; geometric overlays only.
   - Overlays: pixel grid (toggle), pixels crossed by track (toggle), ROI rectangle (toggle), the projected
     in-silicon track segment, the particle position during the animation.
   - Marker toggles (2D panel): top-surface impact (z = 0), midplane crossing (z = −50), exit (z = −100);
     each draws the crossing point (x, y) and outlines its pixel; outside-sensor points are drawn hollow / noted.
     Data mode adds an optional charge-centroid marker.
   - View: "Full sensor" or "Around track" (auto-fit window around the crossings / charge with margin).
   - Hover readout: pixel (ix, iy), its position in µm and, in data mode, its charge.
   - Save PNG exports the 2D map when it is shown. URL `view=2d` opens it.
3. Pure layout/marker math lives in a DOM-free module with tests (µm ↔ canvas mapping, fit window, markers,
   hover pick using geometry.pixelAt; +y up; no transpose).

## Assumptions (reversible)
- "Exit" = crossing of the bottom plane z = −100 (same as the 3D view and readout). Side exits keep their
  existing separate reporting; the 2D map draws the volume's side exit point separately if it differs.
- Camera controls are disabled while 2D is shown.
- The legacy `?renderer=2d` projected fallback stays (it is a 3D projection, not this map).
