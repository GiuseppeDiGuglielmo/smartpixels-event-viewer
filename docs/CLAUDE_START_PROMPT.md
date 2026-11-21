# Ready-to-paste first prompt for Claude Code

> **Historical:** this milestone-1 prompt was completed in v0.2.0, and v0.3.0 added pixelAV data. For the current state, see [`HANDOVER_CLAUDE.md`](HANDOVER_CLAUDE.md).

Please read `CLAUDE.md`, `README.md`, and `docs/PROJECT_SPEC.md` before editing anything. This project is a custom interactive particle-to-pixel-sensor simulator for presentation and research visualization.

I want you to **continue developing the existing project**, not start from scratch. The current app is a working, dependency-free 2D Canvas projection of a 3D sensor, with physical geometry separated into `src/geometry.js`. Preserve the 48 × 192 pixels, X pitch 50 µm, Y pitch 12.5 µm, thickness 100 µm, and conventions for x/y/z, directions, and pixel indices.

**First development milestone:** improve the 3D rendering and interaction, ideally using Three.js if it makes the result substantially better. I want a clearly recognizable volumetric silicon pixel sensor that I can rotate/zoom, plus a charged particle whose arbitrary starting (x0,y0,z0) and direction I can edit. Animate the particle from its starting location through the sensor and highlight the top-surface impact pixel, midplane crossing, and exit. Preserve the original app's controls and behaviors, add a nice toggle to highlight one 16 × 16 ROI, and maintain accurate physical geometry independent of display-only Z exaggeration.

Keep the trajectory model honest: it is geometric only. Keep the Gaussian pixel response explicitly labeled **illustrative**. Do not pretend that we have simulated electron-hole pairs or charge drift until actual physics/event data is integrated.

Please:

1. Run the existing tests first, then inspect the current UI if browser tooling is available.
2. Propose a small implementation plan that retains `src/geometry.js` as the geometry source of truth.
3. Implement the milestone with well-organized source files and useful controls.
4. Add regression tests for any new geometry computations and run `npm test`.
5. Update the README/run instructions and briefly summarize what changed and what is still illustrative.

The original user's sensor sketch is in `assets/reference-geometry.png`. The previous version's screenshot is in `assets/preview.png`, and the prior single-file HTML is in `legacy/original-single-file.html`.
