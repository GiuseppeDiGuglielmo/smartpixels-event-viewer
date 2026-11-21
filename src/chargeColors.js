/**
 * Display-only colour mapping for SIMULATED pixel charge (electrons).
 * Log scale between `floor` and the event's maximum, on a viridis-like ramp.
 * Pure function, testable in Node.
 */
const STOPS = [
  [0.0, [68, 1, 84]],
  [0.25, [59, 82, 139]],
  [0.5, [33, 145, 140]],
  [0.75, [94, 201, 98]],
  [1.0, [253, 231, 37]],
];

/** 0..1 position of charge q on the log scale [floor, max]; 0 for q ≤ floor. */
export function chargeLevel(q, max, floor = 10) {
  if (!(q > floor) || !(max > floor)) return 0;
  return Math.min(1, Math.log(q / floor) / Math.log(max / floor));
}

/** [r, g, b] (0..255) for level 0..1. */
export function rampColor(level) {
  const v = Math.min(1, Math.max(0, level));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    const [p0, c0] = STOPS[i - 1];
    if (v <= p1) {
      const f = (v - p0) / (p1 - p0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return STOPS[STOPS.length - 1][1].slice();
}

export const chargeColor = (q, max, floor) => rampColor(chargeLevel(q, max, floor));

/** CSS gradient string matching the ramp (for legends). */
export const RAMP_CSS = `linear-gradient(90deg, ${STOPS.map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`).join(', ')})`;

/**
 * Single rule for what colours the pixel pads, shared by every renderer:
 * pixelAV SIMULATED charge in data mode once an event is loaded, otherwise
 * nothing. There is no illustrative pixel response any more, so the pads never
 * show anything that could be mistaken for charge.
 */
export function pixelShading({ mode, charge }) {
  return mode === 'data' && charge ? 'charge' : 'none';
}
