/**
 * Display-only colour mapping for SIMULATED pixel charge (electrons).
 * Log scale of |q| between `floor` and the event's maximum: a viridis-like ramp
 * for positive charge and a rose ramp for negative charge, meeting at zero.
 * Pure function, testable in Node.
 */
const STOPS = [
  [0.0, [68, 1, 84]],
  [0.25, [59, 82, 139]],
  [0.5, [33, 145, 140]],
  [0.75, [94, 201, 98]],
  [1.0, [253, 231, 37]],
];

/** Negative side of the scale; starts at the same colour as the positive ramp's zero. */
const NEGATIVE_STOPS = [
  [0.0, [68, 1, 84]],
  [0.5, [176, 36, 96]],
  [1.0, [255, 140, 130]],
];

/** 0..1 position of charge q on the log scale [floor, max]; 0 for q ≤ floor. */
export function chargeLevel(q, max, floor = 10) {
  if (!(q > floor) || !(max > floor)) return 0;
  return Math.min(1, Math.log(q / floor) / Math.log(max / floor));
}

/** [r, g, b] (0..255) for level 0..1. */
export function rampColor(level, stops = STOPS) {
  const v = Math.min(1, Math.max(0, level));
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    const [p0, c0] = stops[i - 1];
    if (v <= p1) {
      const f = (v - p0) / (p1 - p0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return stops[stops.length - 1][1].slice();
}

/** Colour of a signed charge; equal |q| has equal level on both ramps. */
export const chargeColor = (q, max, floor) => (q < 0
  ? rampColor(chargeLevel(-q, max, floor), NEGATIVE_STOPS)
  : rampColor(chargeLevel(q, max, floor)));

const formatCharge = (q) => {
  const a = Math.abs(q);
  const text = a >= 1000 ? `${Number((a / 1000).toFixed(1))}k` : String(Math.round(a));
  return q < 0 ? `−${text}` : text;
};

/**
 * Legend for an event's signed charge range [minQ ≤ 0, maxQ]: a CSS gradient
 * and ticks at the two ends, zero and the decades between them. `at` is the
 * 0..100 % position along the bar, which is linear in signed log level.
 */
export function chargeLegend(minQ, maxQ, floor = 10, minGap = 7) {
  const negative = chargeLevel(-minQ, maxQ, floor);
  const span = negative + 1;
  const at = (q) => (100 * ((q < 0 ? -chargeLevel(-q, maxQ, floor) : chargeLevel(q, maxQ, floor)) + negative)) / span;
  const css = (level, color) => `rgb(${color.join(',')}) ${(100 * (level + negative)) / span}%`;
  const negStops = NEGATIVE_STOPS.filter(([p]) => p > 0 && p < negative).map(([p, c]) => [-p, c]).reverse();
  const stops = [
    ...(negative > 0 ? [css(-negative, rampColor(negative, NEGATIVE_STOPS))] : []),
    ...negStops.map(([p, c]) => css(p, c)),
    ...STOPS.map(([p, c]) => css(p, c)),
  ];
  const ticks = [{ q: 0, at: at(0) }, { q: maxQ, at: 100 }];
  if (negative > 0) ticks.push({ q: minQ, at: 0 });
  for (let d = floor * 10; d < Math.max(maxQ, -minQ); d *= 10) {
    for (const q of [d, -d]) {
      if (q >= maxQ || q <= minQ) continue;
      const p = at(q);
      if (ticks.every((t) => Math.abs(t.at - p) >= minGap)) ticks.push({ q, at: p });
    }
  }
  return {
    gradient: `linear-gradient(90deg, ${stops.join(', ')})`,
    ticks: ticks.sort((a, b) => a.at - b.at).map((t) => ({ ...t, text: formatCharge(t.q) })),
  };
}

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
