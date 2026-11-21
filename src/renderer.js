import {
  SENSOR, clamp, degreesToRadians as deg, point, lerp,
  traceParticle, illustrativeWeight,
} from './geometry.js';
import { chargeColor, pixelShading } from './chargeColors.js';

/**
 * LEGACY / FALLBACK renderer: dependency-free 3D-looking orthographic
 * rendering on a 2D canvas, used when WebGL is unavailable or ?renderer=2d.
 * The ROI panel is drawn by roiPanel.js.
 * The sensor and ray are first expressed in physical 3D coordinates; only
 * the projection is 2D. Z exaggeration is visual, never physical.
 */
export function createRenderer({ canvas, getState }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D rendering is unsupported in this browser.');
  let width = 700;
  let height = 525;

  const state = () => getState();
  const line = (a, b, color, strokeWidth = 1, dash = []) => {
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const polygon = (points, fill, stroke, strokeWidth = 1) => {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  };
  const circle = (p, radius, fill, outline) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (outline) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = outline;
      ctx.stroke();
    }
  };

  function cameraBasis() {
    const s = state();
    const az = deg(s.azimuth);
    const e = deg(s.elevation);
    return {
      right: point(-Math.sin(az), Math.cos(az), 0),
      up: point(-Math.sin(e) * Math.cos(az), -Math.sin(e) * Math.sin(az), Math.cos(e)),
    };
  }

  function projectedCamera(t) {
    const s = state();
    const b = cameraBasis();
    const corners = [];
    for (const x of [-SENSOR.halfX, SENSOR.halfX]) {
      for (const y of [-SENSOR.halfY, SENSOR.halfY]) {
        for (const z of [SENSOR.zBottom, SENSOR.zTop]) {
          corners.push(point(x, y, z));
        }
      }
    }
    corners.push(t.start, t.bottom);
    const raw = (p) => {
      const visualZ = p.z * s.zStretch;
      return {
        x: p.x * b.right.x + p.y * b.right.y + visualZ * b.right.z,
        y: p.x * b.up.x + p.y * b.up.y + visualZ * b.up.z,
      };
    };
    const values = corners.map(raw);
    const minX = Math.min(...values.map((p) => p.x));
    const maxX = Math.max(...values.map((p) => p.x));
    const minY = Math.min(...values.map((p) => p.y));
    const maxY = Math.max(...values.map((p) => p.y));
    const marginX = Math.min(75, width * 0.14);
    const marginY = Math.min(75, height * 0.14);
    const scale = Math.max(0.015, Math.min(
      (width - 2 * marginX) / Math.max(200, maxX - minX),
      (height - 2 * marginY) / Math.max(200, maxY - minY),
    )) * s.zoom;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
      project: (p) => {
        const v = raw(p);
        return { x: width / 2 + (v.x - centerX) * scale, y: height / 2 - (v.y - centerY) * scale };
      },
      scale,
      basis: b,
    };
  }

  function label(p, text, color, dx = 12, dy = -13) {
    ctx.font = '600 12px system-ui,sans-serif';
    const measured = ctx.measureText(text).width;
    const X = clamp(p.x + dx, 6, Math.max(6, width - measured - 14));
    const Y = clamp(p.y + dy, 18, Math.max(18, height - 12));
    ctx.fillStyle = '#091827db';
    ctx.fillRect(X - 5, Y - 13, measured + 10, 19);
    ctx.fillStyle = color;
    ctx.fillText(text, X, Y);
  }

  function background() {
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#5377970d';
    for (let x = 0; x < width; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += 30) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    const glow = ctx.createRadialGradient(width * 0.54, height * 0.47, 30, width * 0.54, height * 0.47, Math.max(width, height) * 0.6);
    glow.addColorStop(0, '#4673a10e');
    glow.addColorStop(1, '#00000000');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }

  function axes(camera) {
    const origin = { x: 57, y: height - 55 };
    const b = camera.basis;
    const axes = [
      ['X', point(1, 0, 0), '#ff9992'],
      ['Y', point(0, 1, 0), '#9efac3'],
      ['Z', point(0, 0, 1), '#9bcbfc'],
    ];
    for (const [name, v, color] of axes) {
      const target = {
        x: origin.x + 48 * (v.x * b.right.x + v.y * b.right.y + v.z * b.right.z),
        y: origin.y - 48 * (v.x * b.up.x + v.y * b.up.y + v.z * b.up.z),
      };
      line(origin, target, color, 2);
      circle(target, 2.4, color);
      ctx.fillStyle = color;
      ctx.font = '700 11px ui-monospace,monospace';
      ctx.fillText(name, target.x + 5, target.y + 3);
    }
    circle(origin, 3, '#dce6ef');
  }

  function drawScene() {
    const s = state();
    const t = traceParticle(s);
    const camera = projectedCamera(t);
    const P = camera.project;
    const a = (x, y, z) => P(point(x, y, z));
    const H = SENSOR.halfX;
    const K = SENSOR.halfY;
    const visibleX = Math.cos(deg(s.azimuth)) >= 0 ? H : -H;
    const visibleY = Math.sin(deg(s.azimuth)) >= 0 ? K : -K;
    background();

    // Sensor slab: bottom, two projected sides, midplane, top.
    polygon([a(-H, -K, -100), a(H, -K, -100), a(H, K, -100), a(-H, K, -100)], '#26384b99', '#476987', 1.1);
    polygon([a(visibleX, -K, 0), a(visibleX, K, 0), a(visibleX, K, -100), a(visibleX, -K, -100)], '#4a729277', '#98b7ce', 1.35);
    polygon([a(-H, visibleY, 0), a(H, visibleY, 0), a(H, visibleY, -100), a(-H, visibleY, -100)], '#365d7f88', '#98b7ce', 1.35);

    if (s.showMid) {
      polygon([a(-H, -K, -50), a(H, -K, -50), a(H, K, -50), a(-H, K, -50)], '#338df91b', '#459dff88', 1);
      line(a(visibleX, -K, -50), a(visibleX, K, -50), '#5aa6ff', 1.5, [6, 4]);
      line(a(-H, visibleY, -50), a(H, visibleY, -50), '#5aa6ff', 1.5, [6, 4]);
    }
    polygon([a(-H, -K, 0), a(H, -K, 0), a(H, K, 0), a(-H, K, 0)], '#b3d6df23', '#a9d6e5', 2);
    if (s.showGrid) {
      for (let col = 1; col < SENSOR.pixelsX; col++) {
        const x = -H + col * SENSOR.pitchX;
        line(a(x, -K, 0), a(x, K, 0), col % 8 === 0 ? '#a3e6f96e' : '#aedcfb2a', col % 8 === 0 ? 1 : 0.55);
      }
      const spacing = SENSOR.pitchY * camera.scale;
      const stride = spacing < 0.75 ? 8 : spacing < 1.5 ? 4 : spacing < 2.5 ? 2 : 1;
      for (let row = stride; row < SENSOR.pixelsY; row += stride) {
        const y = -K + row * SENSOR.pitchY;
        line(a(-H, y, 0), a(H, y, 0), row % 16 === 0 ? '#a3e6f96c' : '#aedcfb24', row % 16 === 0 ? 1 : 0.5);
      }
    }

    // pixelAV SIMULATED charge (data mode): colour the non-zero pixels of the current slice.
    const shading = pixelShading(s);
    if (shading === 'charge') {
      const { indices, charges } = s.charge.sparse; // only the non-zero pixels
      const px = SENSOR.pitchX;
      const py = SENSOR.pitchY;
      for (let i = 0; i < indices.length; i++) {
        if (!(charges[i] > 0)) continue;
        const [r, g, b] = chargeColor(charges[i], s.charge.scale);
        const x = -H + (indices[i] % SENSOR.pixelsX) * px;
        const y = -K + Math.floor(indices[i] / SENSOR.pixelsX) * py;
        polygon([a(x, y, 0), a(x + px, y, 0), a(x + px, y + py, 0), a(x, y + py, 0)], `rgb(${r},${g},${b})`, null);
      }
    }

    // Illustration only: Gaussian brightness is NOT a physical charge model.
    if (shading === 'gaussian' && t.topPixel) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -5; dy <= 5; dy++) {
          const ix = t.topPixel.x + dx;
          const iy = t.topPixel.y + dy;
          const intensity = illustrativeWeight(ix, iy, t.top, 38, 22);
          if (intensity < 0.035) continue;
          const x = -H + ix * SENSOR.pitchX;
          const y = -K + iy * SENSOR.pitchY;
          polygon([a(x, y, 0), a(x + 50, y, 0), a(x + 50, y + 12.5, 0), a(x, y + 12.5, 0)], `rgba(88,238,233,${Math.min(0.9, 0.16 + 0.78 * intensity)})`, null);
        }
      }
    }

    const src = P(t.start);
    const top = P(t.top);
    const mid = P(t.mid);
    const bottom = P(t.bottom);
    line(src, bottom, '#ff9b6e91', 2, [5, 6]);
    const fraction = s.progress;
    const moving = P(point(
      lerp(t.start.x, t.bottom.x, fraction),
      lerp(t.start.y, t.bottom.y, fraction),
      lerp(t.start.z, t.bottom.z, fraction),
    ));
    line(src, moving, '#ffac59', 3);
    circle(src, 5.5, '#ffba70', '#fff0d2');
    if (t.hit) {
      circle(top, 8, '#22dbed39');
      circle(top, 4, '#62f5f3', '#d4ffff');
      if (s.showMid && t.midHit) circle(mid, 6, '#4f9aff88', '#c6e1ff');
    }
    if (fraction < 0.999) {
      ctx.shadowColor = '#ffad58';
      ctx.shadowBlur = 15;
      circle(moving, 6.5, '#ffc26f', '#ffffff');
      ctx.shadowBlur = 0;
    } else {
      circle(bottom, 4, '#ffbf8f');
    }
    label(src, 'particle start', '#ffc17c', 11, -18);
    if (t.hit) label(top, 'surface hit', '#80f7f0', 11, -16);
    if (s.showMid && t.midHit) label(mid, 'midplane', '#9cc9ff', 10, 21);
    label(a(-H, visibleY, -100), '100 µm thickness', '#d2e5f4', 0, 25);
    axes(camera);
  }

  function render() {
    drawScene();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  return { kind: 'canvas2d', element: canvas, render, resize };
}
