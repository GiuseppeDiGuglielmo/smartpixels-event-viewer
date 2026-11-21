# Claude Code — Project instructions

You are working in an interactive **particle-to-pixel silicon detector visualization** project. The user is a detector/ASIC researcher and needs a credible visual illustration of how a charged particle crosses a pixel sensor, in addition to a path to real simulated data.

## First actions

1. Read `README.md` and `docs/PROJECT_SPEC.md` to understand the fixed detector dimensions and coordinate conventions.
2. Inspect `src/geometry.js` (physical math), `src/renderer.js` (display), and `src/main.js` (UI).
3. Run `npm test` before changing code.
4. Run `npm run dev`, open http://127.0.0.1:5173/, and verify the UI when browser tooling is available.

## Non-negotiable constraints

- One sensor **group** is **48 X pixels × 192 Y pixels** (9,216 pixels), NOT 192 × 768 for this viewer.
- X pitch = **50 µm**, Y pitch = **12.5 µm**, sensor thickness = **100 µm**.
- X,Y active footprint = `[-1200,1200) × [-1200,1200) µm²`.
- Top plane z = 0; midplane z = −50 µm; bottom z = −100 µm. Increasing negative z is farther into silicon.
- Particle starts at `(x0,y0,z0)`, with `z0 > 0` (above sensor). Define angles as independent slopes: `x(z) = x0 + (z0-z)*tan(thetaX)`, `y(z) = y0 + (z0-z)*tan(thetaY)`.
- Zero-based pixel coordinates: X 0..47, Y 0..191. Do not silently transpose axes or pixels.
- Visual Z stretch is rendering only. All computations use physical µm.
- Current Gaussian pixel brightness is illustrative only; do not describe it as physical charge transport.
- Do not quietly replace top-surface-hit semantics. If you add side entry / volume intersection, separate it clearly and test it.

## Code organization

- `src/geometry.js`: pure functions, no DOM, authoritative coordinates and mapping. Favor adding/testable physics or geometry here.
- `src/sceneTransform.js`: display-only physical→Three.js mapping (Z stretch lives here only). Tested.
- `src/renderer3d.js`: Three.js (WebGL) renderer; draws only what geometry.js returns.
- `src/renderer.js`: legacy 2D-canvas renderer (fallback, `?renderer=2d`); keep physical coordinates distinct from projected coordinates.
- `src/roiPanel.js`: 16 × 16 ROI index-space panel.
- `src/pixelav.js`, `src/eventSource.js`, `src/dataPanel.js`: pixelAV simulated-event mode (decoder + mapping, Range loader, UI). Simulated charge stays separate from the illustrative Gaussian.
- `scripts/pixelav_convert.py`: Parquet → sparse converter (Python + pyarrow, e.g. conda env `pixelav-env`). Format and conventions: `docs/PIXELAV_DATA.md`.
- `vendor/three/`: unmodified Three.js r187 (MIT), loaded via the import map in index.html. No npm install.
- `src/main.js`: UI state, input validation, animation, interaction.
- `tests/*.test.js`: regression tests. Add tests for any new geometry or hit logic.
- `legacy/original-single-file.html`: untouched historical reference; useful if you need to compare visual behavior.
- `assets/reference-geometry.png`: original dimensioned drawing supplied by the user.

## Development guidance

- Prefer incremental, working changes with a short explanation of what changed.
- If migrating to Three.js, keep `src/geometry.js` and tests. Explicitly document the rendering dependency and update the run instructions.
- If introducing real charge simulation, keep the physically simulated output and the illustrative demo mode separate in the UI.
- Support Linux and local development with minimal setup; the current app uses Node 20+ and no npm packages (Three.js is vendored).
- Run `npm test` after edits. A change that only alters screenshots does not validate correct detector geometry.
- Prioritize a polished, accurate, interactive visualization for talks and demos.

## Recommended next task

Read `docs/HANDOVER_CLAUDE.md` for the current state, the open decisions (pixelAV origin and readout face) and the verification steps, including `npm run qa:browser` for UI checks. `docs/CLAUDE_START_PROMPT.md` is the completed milestone-1 prompt; don't re-run it. Ask the user for changes only if the requested behavior is scientifically ambiguous; preserve original defaults otherwise.
