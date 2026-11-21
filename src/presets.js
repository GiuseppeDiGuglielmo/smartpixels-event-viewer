/** Demonstration trajectories; all coordinates in µm, angles in degrees. */
export const PRESETS = Object.freeze({
  straight: { x0: -120, y0: 15, z0: 550, thetaX: 0, thetaY: 0 },
  angled: { x0: -620, y0: 125, z0: 600, thetaX: 28, thetaY: -8 },
  grazing: { x0: -1000, y0: -600, z0: 650, thetaX: 60, thetaY: 28 },
  miss: { x0: 1550, y0: 500, z0: 550, thetaX: 10, thetaY: 3 },
});
