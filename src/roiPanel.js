import { ROI_SIZE, SENSOR, illustrativeWeight } from './geometry.js';
import { chargeColor, pixelShading } from './chargeColors.js';

/**
 * Draws the 16 × 16 ROI index-space panel. Cells are square for inspection
 * (physically each is 50 × 12.5 µm). +x to the right, +y UP, matching the
 * 3D top view. Demo mode: brightness is the illustrative Gaussian, not charge.
 * Data mode (`charge` given): colour is pixelAV SIMULATED charge (log scale).
 */
export function drawRoiPanel(canvas, { trace, roi, traversed = [], showGaussian = true, charge = null, mode = charge ? 'data' : 'demo' }) {
  const shading = pixelShading({ mode, charge, showGaussian });
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const left = 64;
  const right = 10;
  const top = 10;
  const bottom = 48;
  const step = Math.min((w - left - right) / ROI_SIZE, (h - top - bottom) / ROI_SIZE);
  const gridBottom = top + ROI_SIZE * step;
  ctx.fillStyle = '#091526';
  ctx.fillRect(0, 0, w, h);

  if (!roi) {
    ctx.fillStyle = '#a9bbca';
    ctx.font = '22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No top-surface hit', w / 2, h / 2);
    ctx.textAlign = 'left';
    return;
  }

  const cellX = (ix) => left + (ix - roi.x0) * step;
  // +y up: row y0 at the bottom of the grid.
  const cellY = (iy) => gridBottom - (iy - roi.y0 + 1) * step;

  for (let iy = roi.y0; iy < roi.y1; iy++) {
    for (let ix = roi.x0; ix < roi.x1; ix++) {
      if (shading === 'charge') {
        const q = charge.dense[iy * SENSOR.pixelsX + ix];
        if (q > 0) {
          const [r, g, b] = chargeColor(q, charge.scale);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        } else {
          ctx.fillStyle = 'rgba(30,82,126,0.14)';
        }
        ctx.fillRect(cellX(ix), cellY(iy), step - 0.8, step - 0.8);
        continue;
      }
      const weight = shading === 'gaussian' && trace.hit ? illustrativeWeight(ix, iy, trace.top) : 0;
      const alpha = 0.14 + 0.84 * weight;
      ctx.fillStyle = `rgba(${Math.round(30 + 104 * weight)},${Math.round(82 + 150 * weight)},${Math.round(126 + 42 * weight)},${alpha})`;
      ctx.fillRect(cellX(ix), cellY(iy), step - 0.8, step - 0.8);
    }
  }

  // Geometric traversal (path through pixel columns): small amber dots.
  ctx.fillStyle = '#ffb46a';
  for (const p of traversed) {
    if (p.x < roi.x0 || p.x >= roi.x1 || p.y < roi.y0 || p.y >= roi.y1) continue;
    ctx.beginPath();
    ctx.arc(cellX(p.x) + step / 2, cellY(p.y) + step / 2, Math.max(1.5, step * 0.14), 0, Math.PI * 2);
    ctx.fill();
  }

  if (trace.topPixel) {
    ctx.strokeStyle = '#7ff6f3';
    ctx.lineWidth = 2;
    ctx.strokeRect(cellX(trace.topPixel.x) + 1, cellY(trace.topPixel.y) + 1, step - 2.8, step - 2.8);
  }

  ctx.fillStyle = '#9fb7cb';
  ctx.font = '600 17px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`x ${roi.x0}`, left, gridBottom + 20);
  ctx.textAlign = 'right';
  ctx.fillText(`${roi.x1 - 1} →`, left + ROI_SIZE * step, gridBottom + 20);
  ctx.fillText(`y ${roi.y0}`, left - 6, gridBottom - 2);
  ctx.fillText(`${roi.y1 - 1}`, left - 6, top + 15);
  ctx.fillText('↑', left - 6, top + 36);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7f98ae';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText('cells drawn square', left + (ROI_SIZE * step) / 2, gridBottom + 42);
  ctx.textAlign = 'left';
}
