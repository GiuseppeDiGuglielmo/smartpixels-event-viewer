# Pending decision: where is pixelAV (x, y) = (0, 0) on the 48 × 192 array?

Evidence (test/part.0, 5000 events): mean(charge centroid − truth midplane) with truth taken as
array-centred = (−24.7 ± 0.3, −22.2 ± 0.1) µm; no dependence on cotAlpha, cotBeta, pt, offsets.

Options
A. Origin = centre of pixel (23, 95) = viewer (−25, −6.25) µm.   [IMPLEMENTED DEFAULT]
   x residual ≈ 0; leaves a constant y residual ≈ −16 µm, plausibly Lorentz drift in a B field.
B. Origin = array centre (0, 0): residuals (−25, −22) µm remain visible.
C. Empirical origin (−24.7, −22.2): forces residual to zero — would hide a physical drift (not recommended).

Reversibility: single constant PIXELAV_ORIGIN in src/pixelav.js; UI shows the residual so a wrong
choice is visible. Please confirm with the dataset author (pixelAV config / geometry definition).

Update (full dataset, 100 files): residual constant per file, x −25.8…−24.3, y −22.4…−22.0 µm.

# Pending decision 2: readout face
Charge is drawn on the entry face (viewer top, pixelAV z=100). Evidence: for |cotα|>5, the slice-0 charge
centroid sits at 0.31 of the track from the entry face (final charge: 0.50) → early-collected charge is
near the entry face → implants there. Reversible (renderer draws pads at z=0). Confirm with pixelAV config.
