# Open decisions

Conventions the data does not fully settle. Each is implemented in a reversible way and shown rather than hidden. If you know the PixelAV configuration, please open an issue with your source.

## 1. Where is PixelAV (x, y) = (0, 0) on the 48 × 192 array?

**Evidence** (`test/part.0`, 5000 events): the mean of charge centroid minus truth midplane, with truth taken as array-centred, is (−24.7 ± 0.3, −22.2 ± 0.1) µm. Across all 100 files it stays between −25.8 and −24.3 µm in x, and between −22.4 and −22.0 µm in y.

| Option | Effect |
|---|---|
| **A. Centre of pixel (23, 95)**, viewer (−25, −6.25) µm (**current**) | x residual about 0; leaves a y residual of about −16 µm |
| B. Array centre (0, 0) | Residuals of (−25, −22) µm remain visible |
| C. Empirical origin (−24.7, −22.2) µm | Forces the residual to zero and would hide a physical drift (not recommended) |

To change it, edit `PIXELAV_ORIGIN` in `src/pixelav.js`.

## 2. Which face holds the readout pixels?

The charge is drawn on the entry face (viewer z = 0, PixelAV z = 100). For steep tracks (|cotα| > 5, 800 events), the charge in slice 0 has its centroid 0.31 of the way along the track from the entry face, while the final charge sits at 0.50. Charge produced near the entry face therefore arrives first, which suggests the implants are on that face.

## 3. What is the y residual of about −16 µm?

It is shown, not corrected. The dataset uses a 3.8 T field along sensor X, so a Lorentz drift along Y is the likely explanation. Its expected size and sign have not been computed. A check on 1,500 events also found a weak dependence on cotβ (about −1.4 µm per unit of cotβ).

## 4. Smaller open points

- When slice 0 starts relative to the particle crossing.
- `n_x`, `n_y`, `n_z` are described as a unit vector in the [Zenodo record](https://zenodo.org/records/17180303), but their length here ranges from 0.04 to 36. The viewer uses `cotAlpha` and `cotBeta` for the direction.

See [PIXELAV_DATA.md](PIXELAV_DATA.md) for the full comparison.
