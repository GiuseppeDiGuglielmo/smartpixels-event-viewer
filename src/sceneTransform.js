/**
 * Display-only mapping between physical detector coordinates (µm) and the
 * Three.js scene. Pure functions, no DOM / no Three.js, so they are testable
 * in Node. Nothing here feeds back into geometry.js.
 *
 * Physical frame (right-handed): x across the 48 columns, y along the 192
 * rows, z up (top surface z = 0, silicon toward −z).
 * Three.js frame (right-handed, Y up): scene = (x, z · zStretch, −y) · SCENE_SCALE.
 * The mapping is a proper rotation (no mirror) followed by a scale and the
 * display-only Z stretch.
 */
export const SCENE_SCALE = 0.01; // scene units per µm (1 unit = 100 µm)

export function toScene(p, zStretch = 1) {
  return [p.x * SCENE_SCALE, p.z * zStretch * SCENE_SCALE, -p.y * SCENE_SCALE];
}

/** Inverse of toScene for the same zStretch. */
export function fromScene([sx, sy, sz], zStretch = 1) {
  return { x: sx / SCENE_SCALE, y: -sz / SCENE_SCALE, z: sy / (zStretch * SCENE_SCALE) };
}

/**
 * Unit vector in the PHYSICAL frame pointing from the look-at target toward
 * the camera, for the legacy azimuth/elevation convention:
 * azimuth measured in the x–y plane from +x toward +y, elevation above the
 * x–y plane. (Matches the original 2D renderer's camera basis.)
 */
export function cameraDirection(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * Math.PI / 180;
  const el = elevationDeg * Math.PI / 180;
  return { x: Math.cos(el) * Math.cos(az), y: Math.cos(el) * Math.sin(az), z: Math.sin(el) };
}

/** Inverse of cameraDirection for any non-zero physical-frame vector. */
export function anglesFromDirection({ x, y, z }) {
  const r = Math.hypot(x, y, z);
  if (!(r > 0)) return { azimuth: 0, elevation: 0 };
  return {
    azimuth: Math.atan2(y, x) * 180 / Math.PI,
    elevation: Math.asin(Math.max(-1, Math.min(1, z / r))) * 180 / Math.PI,
  };
}

/** Named camera directions [azimuth, elevation] in degrees. */
export const CAMERA_PRESETS = Object.freeze({ iso: [35, 30], top: [-90, 89], xz: [-90, 0], yz: [0, 0] });

/** Preset the camera is on (within 1°), or null after a free orbit. Elevations are clamped to the renderer's range. */
export function matchingPreset(azimuth, elevation, elevationMin = -89, elevationMax = 89) {
  const near = (a, b) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180) < 1;
  for (const [name, [az, el]] of Object.entries(CAMERA_PRESETS)) {
    if (near(azimuth, az) && Math.abs(elevation - Math.min(elevationMax, Math.max(elevationMin, el))) < 1) return name;
  }
  return null;
}
