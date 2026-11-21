# Autopilot spec — milestone 4: 2D-first, full 48 × 192 map, simpler GUI, axis units

Request (2026-11-21): "start with the 2D map (default), 3D later; it should be 48x192 pixels, right now it
seems off, it seems that you zoomed it; improve and simplify the GUI (abstraction, discipline, hierarchy,
modularity, regularity) in what it shows, buttons, toggles; a tick to mark axis dimensions in µm or pixels".

## Requirements
1. The app opens on the 2D map. `?view=3d` opens the 3D scene (old `?view=2d` links still work).
2. The map shows the whole 48 × 192 array by default, filling the viewport: square canvas (the footprint is
   2.4 × 2.4 mm), axes only over the sensor, every pixel boundary drawn, heavier lines every 16 pixels
   (the 3 × 12 aligned-ROI tiles). "Zoom to track" stays as an opt-in.
3. Axis units switch: µm (physical, origin at the centre) or pixel index (0..47, 0..191, ticks at pixel
   centres, zero-based, no transpose). Default µm. Persisted in the URL (`units=px`).
4. GUI, by principle:
   - Hierarchy: view-independent first (Data → Track → Overlays), then the controls of the active view only.
   - Modularity: controls that only apply to one view live in that view's section and are hidden (not just
     disabled) in the other view; same for legend entries and readout cells.
   - Regularity: one name per concept everywhere (Surface z = 0 / Midplane z = −50 µm / Exit z = −100 µm),
     each crossing toggle carries its legend colour, segmented controls for 2-way choices
     (view, area, units), view-level actions (Save PNG) in the viewport header.
   - Abstraction/discipline: shorter header text, no duplicate controls, nothing shown that the view cannot draw.
5. Tests for the new layout helpers (square fit, pixel-unit ticks, grid majors), `npm test` green,
   headless browser QA of 2D (demo + data) and 3D.

## Assumptions (reversible)
- "48 × 192, zoomed" = the default "Around the track" framing; the fix is full-sensor default at true aspect
  (pixels drawn 50 × 12.5 µm, so they look 4:1 wide). An index-space square-cell view was not requested.
- 3D keeps its features unchanged; only its controls are grouped/hidden when 2D is shown.
