import {
  SENSOR, DEFAULT_STATE, clamp, traceParticle, intersectVolume, traversedPixels, roiWindow,
} from './geometry.js';
import { PRESETS } from './presets.js';
import { createRenderer } from './renderer.js';
import { drawRoiPanel } from './roiPanel.js';
import { createDataPanel, DATA_DEFAULTS } from './dataPanel.js';

const el = (id) => document.getElementById(id);
const frame = el('frame');
const legacyCanvas = el('scene');
const roiCanvas = el('roi');

// Display-only options live here, not in geometry.js.
const VIEW_DEFAULTS = Object.freeze({
  showRoi: false,
  roiMode: 'centered',
  showGaussian: true,
  showTraversed: true,
  showLabels: true,
  loop: false,
});
const state = { ...DEFAULT_STATE, ...VIEW_DEFAULTS, ...DATA_DEFAULTS, animating: false };
let ELEVATION_MIN = -89; // the legacy 2D fallback narrows this to 5..85
let ELEVATION_MAX = 89;
let ZOOM_MIN = 0.3; // the legacy 2D fallback narrows this to 0.45..5
let ZOOM_MAX = 80;
const DURATION_MS = 3200;

let renderer = null;

function syncCameraInputs() {
  el('azimuth').value = String(Math.round(state.azimuth));
  el('elevation').value = String(Math.round(state.elevation));
  el('azLabel').textContent = `${Math.round(state.azimuth)}°`;
  el('elLabel').textContent = `${Math.round(state.elevation)}°`;
}

async function createBestRenderer() {
  const wanted = new URLSearchParams(location.search).get('renderer');
  if (wanted !== '2d') {
    try {
      const probe = document.createElement('canvas').getContext('webgl2'); // three r163+ requires WebGL 2
      if (!probe) throw new Error('WebGL 2 unavailable');
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      const { createRenderer3D } = await import('./renderer3d.js');
      legacyCanvas.hidden = true;
      return createRenderer3D({
        frame,
        getState: () => state,
        zoomRange: [ZOOM_MIN, ZOOM_MAX],
        onCameraChange: ({ azimuth, elevation, zoom }) => {
          state.azimuth = azimuth;
          state.elevation = elevation;
          state.zoom = zoom;
          syncCameraInputs();
        },
      });
    } catch (error) {
      console.warn('[pixel-sensor] WebGL renderer unavailable, using 2D canvas fallback:', error);
      legacyCanvas.hidden = false;
    }
  }
  return createRenderer({ canvas: legacyCanvas, getState: () => state });
}

const um = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} µm` : '—');
const px = (pixel) => (pixel ? `(${pixel.x}, ${pixel.y})` : 'outside');
const FACE = { top: 'top', bottom: 'bottom', 'x-': 'x− side', 'x+': 'x+ side', 'y-': 'y− side', 'y+': 'y+ side' };

function updateReadout() {
  const ray = traceParticle(state);
  const volume = intersectVolume(state);
  const traversed = traversedPixels(state);
  const roi = roiWindow(ray.topPixel, state.roiMode);
  el('hitStatus').textContent = ray.hit ? 'HIT' : 'MISS';
  el('hitStatus').className = ray.hit ? 'good' : 'warn';
  el('hitPixel').textContent = ray.topPixel ? `(${ray.topPixel.x}, ${ray.topPixel.y})` : '—';
  el('hitPosition').textContent = `${um(ray.top.x)}, ${um(ray.top.y)}`;
  el('midPosition').textContent = `${um(ray.mid.x)}, ${um(ray.mid.y)} · px ${px(ray.midPixel)}`;
  el('exitPosition').textContent = `${um(ray.bottom.x)}, ${um(ray.bottom.y)} · px ${px(ray.exitPixel)}`;
  el('volumePath').textContent = volume
    ? `${FACE[volume.entryFace]} → ${FACE[volume.exitFace]} · ${volume.length.toFixed(1)} µm`
    : 'does not cross silicon';
  el('traversedCount').textContent = volume ? `${traversed.length} pixel${traversed.length === 1 ? '' : 's'}` : '—';
  el('viewDescription').textContent = `Z shown ×${state.zStretch}`;
  el('stretchBadge').textContent = `Z display ×${state.zStretch}`;
  el('zLabel').textContent = `×${state.zStretch}`;
  el('rendererBadge').textContent = renderer?.kind === 'webgl' ? 'WebGL · Three.js' : '2D canvas fallback';
  el('timeline').value = String(Math.round(state.progress * 1000));
  el('progressLabel').textContent = `${Math.round(state.progress * 100)}%`;
  const dataMode = state.mode === 'data' && state.charge;
  const shading = dataMode
    ? `Colour: pixelAV simulated charge at time slice ${state.charge.slice} (log scale, e⁻)`
    : state.mode === 'data'
      ? 'No pixelAV event loaded yet (no charge shown)'
      : state.showGaussian ? 'Green: illustrative Gaussian (not charge)' : 'No pixel shading';
  el('roiCaption').textContent = roi
    ? `ROI x ${roi.x0}–${roi.x1 - 1}, y ${roi.y0}–${roi.y1 - 1} (${state.roiMode === 'aligned' ? 'aligned tile' : 'centered on impact'}) = 800 × 200 µm. ${shading}; amber dots: pixels crossed by the track (geometric).`
    : 'No top-surface hit, so no ROI is defined.';
  // 'data' only once an event is loaded, so no text claims a truth track before then.
  document.body.dataset.mode = state.mode === 'data' ? (state.event ? 'data' : 'data-pending') : 'demo';
  drawRoiPanel(roiCanvas, {
    trace: ray, roi, traversed, showGaussian: state.showGaussian,
    charge: dataMode ? state.charge : null,
    mode: state.mode,
  });
}

function update() {
  syncCameraInputs();
  updateReadout();
  renderer.render();
}

/* ---------------- animation ---------------- */
let frameHandle = null;
let startedAt = 0;
let startProgress = 0;
let dwellUntil = 0;

function stop() {
  state.animating = false;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  el('play').textContent = '▶ Play';
}

function tick(now) {
  if (!state.animating) return;
  if (now < dwellUntil) { frameHandle = requestAnimationFrame(tick); return; } // hold on the exit
  state.progress = clamp(startProgress + (now - startedAt) / DURATION_MS, 0, 1);
  update();
  if (state.progress >= 1) {
    if (state.loop) {
      dwellUntil = now + 600; // short dwell at the exit before restarting
      startProgress = 0;
      startedAt = dwellUntil;
      frameHandle = requestAnimationFrame(tick);
      return;
    }
    stop();
    return;
  }
  frameHandle = requestAnimationFrame(tick);
}

function play() {
  if (state.animating) { stop(); return; }
  if (state.progress >= 0.999) state.progress = 0;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    state.progress = 1;
    update();
    return;
  }
  state.animating = true;
  startProgress = state.progress;
  startedAt = performance.now();
  el('play').textContent = '❚❚ Pause';
  frameHandle = requestAnimationFrame(tick);
}

/* ---------------- inputs ---------------- */
function attachNumericField(id, min, max) {
  const input = el(id);
  input.addEventListener('change', () => {
    // An empty number control must not silently become zero.
    const parsed = input.value.trim() === '' ? NaN : Number(input.value);
    state[id] = clamp(Number.isFinite(parsed) ? parsed : DEFAULT_STATE[id], min, max);
    input.value = String(state[id]);
    stop();
    state.progress = 1;
    el('preset').value = 'manual';
    update();
  });
}

function bindControls() {
  attachNumericField('x0', -5000, 5000);
  attachNumericField('y0', -5000, 5000);
  attachNumericField('z0', 10, 5000);
  attachNumericField('thetaX', -75, 75);
  attachNumericField('thetaY', -75, 75);

  for (const key of ['azimuth', 'elevation']) {
    el(key).addEventListener('input', (event) => {
      state[key] = Number(event.target.value);
      renderer.syncCamera?.();
      update();
    });
  }
  el('zStretch').addEventListener('input', (event) => {
    state.zStretch = Number(event.target.value);
    update();
  });

  for (const [id, key] of [
    ['gridToggle', 'showGrid'], ['midToggle', 'showMid'], ['roiToggle', 'showRoi'],
    ['gaussToggle', 'showGaussian'], ['traversedToggle', 'showTraversed'],
    ['labelsToggle', 'showLabels'], ['loopToggle', 'loop'],
  ]) {
    el(id).checked = !!state[key];
    el(id).addEventListener('change', (event) => {
      state[key] = event.target.checked;
      el('roiMode').disabled = !state.showRoi;
      update();
    });
  }
  el('roiMode').value = state.roiMode;
  el('roiMode').disabled = !state.showRoi;
  el('roiMode').addEventListener('change', (event) => {
    state.roiMode = event.target.value;
    update();
  });

  el('preset').addEventListener('change', () => {
    const preset = PRESETS[el('preset').value];
    if (!preset) return;
    Object.assign(state, preset);
    for (const key of Object.keys(preset)) el(key).value = preset[key];
    stop();
    state.progress = 1;
    update();
  });

  el('play').addEventListener('click', play);
  el('restart').addEventListener('click', () => {
    stop();
    state.progress = 0;
    update();
  });
  el('timeline').addEventListener('input', (event) => {
    stop();
    state.progress = Number(event.target.value) / 1000;
    update();
  });

  const setCamera = (azimuth, elevation, view) => {
    state.azimuth = azimuth;
    state.elevation = clamp(elevation, ELEVATION_MIN, ELEVATION_MAX);
    state.zoom = DEFAULT_STATE.zoom;
    if (renderer.setView) renderer.setView(view);
    update();
  };
  el('resetView').addEventListener('click', () => {
    state.zStretch = DEFAULT_STATE.zStretch;
    el('zStretch').value = String(state.zStretch);
    setCamera(DEFAULT_STATE.azimuth, DEFAULT_STATE.elevation, 'reset');
  });
  el('viewTop').addEventListener('click', () => setCamera(-90, 89, 'reset'));
  el('viewSideX').addEventListener('click', () => setCamera(-90, 0, 'reset'));
  el('viewSideY').addEventListener('click', () => setCamera(0, 0, 'reset'));
  el('viewFocus').addEventListener('click', () => {
    if (!renderer.setView) return;
    renderer.setView('focus');
    update();
  });
  el('savePng').addEventListener('click', () => {
    const url = renderer.exportPNG ? renderer.exportPNG() : legacyCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `pixel-sensor-x${state.x0}-y${state.y0}-tx${state.thetaX}-ty${state.thetaY}.png`;
    link.click();
  });

  // Keyboard orbit/zoom on the viewport (both renderers).
  frame.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === ' ') { play(); return; }
    const wrap = (a) => ((a + 180) % 360 + 360) % 360 - 180;
    if (event.key === 'ArrowLeft') state.azimuth = wrap(state.azimuth - 5);
    if (event.key === 'ArrowRight') state.azimuth = wrap(state.azimuth + 5);
    if (event.key === 'ArrowUp') state.elevation = clamp(state.elevation + 5, ELEVATION_MIN, ELEVATION_MAX);
    if (event.key === 'ArrowDown') state.elevation = clamp(state.elevation - 5, ELEVATION_MIN, ELEVATION_MAX);
    if (event.key === '+' || event.key === '=') state.zoom = clamp(state.zoom * 1.15, ZOOM_MIN, ZOOM_MAX);
    if (event.key === '-') state.zoom = clamp(state.zoom / 1.15, ZOOM_MIN, ZOOM_MAX);
    renderer.syncCamera?.();
    update();
  });

  // Legacy 2D renderer has no OrbitControls: keep the original drag/wheel.
  if (renderer.kind !== 'webgl') bindLegacyPointer();

  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  if ('ResizeObserver' in window) new ResizeObserver(() => renderer.resize()).observe(renderer.element);
  else window.addEventListener('resize', () => renderer.resize());
}

function bindLegacyPointer() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  legacyCanvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    legacyCanvas.setPointerCapture(event.pointerId);
  });
  legacyCanvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    state.azimuth = ((state.azimuth + (event.clientX - lastX) * 0.55 + 180) % 360 + 360) % 360 - 180;
    state.elevation = clamp(state.elevation - (event.clientY - lastY) * 0.4, 5, 85);
    lastX = event.clientX;
    lastY = event.clientY;
    update();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    legacyCanvas.addEventListener(name, () => { dragging = false; });
  }
  legacyCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.001), ZOOM_MIN, ZOOM_MAX);
    update();
  }, { passive: false });
}

renderer = await createBestRenderer();
frame.dataset.renderer = renderer.kind;
if (renderer.kind !== 'webgl') {
  frame.querySelector('.canvas-tip').textContent = 'Drag to orbit · scroll to zoom';
  for (const id of ['viewTop', 'viewSideX', 'viewSideY']) el(id).title = 'Orbit presets (2D fallback: approximate)';
  ELEVATION_MIN = 5;
  ELEVATION_MAX = 85;
  ZOOM_MIN = 0.45;
  ZOOM_MAX = 5;
  el('elevation').min = '5';
  el('elevation').max = '85';
}
el('viewFocus').disabled = !renderer.setView;
bindControls();
const dataPanel = createDataPanel({ state, el, update, stopParticle: stop });
dataPanel.bind();
if (renderer.kind !== 'webgl') {
  // The 2D fallback draws only the original scene; disable toggles it cannot show.
  for (const id of ['roiToggle', 'roiMode', 'traversedToggle', 'labelsToggle', 'viewFocus']) {
    el(id).disabled = true;
    el(id).title = 'Available in the WebGL (3D) view only';
  }
}
renderer.resize();
update();

// Read-only diagnostics for the browser console / integration checks.
// Not a stable API; import geometry.js directly in code.
window.pixelSensorDebug = Object.freeze({
  get trace() { return traceParticle(state); },
  get volume() { return intersectVolume(state); },
  get traversed() { return traversedPixels(state); },
  get roi() { return roiWindow(traceParticle(state).topPixel, state.roiMode); },
  get state() { return { ...state }; },
  get renderer() { return renderer.kind; },
  get event() { return state.event ? { fileId: state.event.fileId, eventIndex: state.event.eventIndex, truth: state.event.truth } : null; },
  get charge() { return state.charge ? { slice: state.charge.slice, ...state.charge.stats, scale: state.charge.scale } : null; },
  get dataStats() { return dataPanel.source ? { ...dataPanel.source.stats, ...dataPanel.source.cacheSizes() } : null; },
  get geometry() { return SENSOR; },
});
