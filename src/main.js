import {
  SENSOR, DEFAULT_STATE, clamp, traceParticle, intersectVolume, traversedPixels,
} from './geometry.js';
import { createRenderer } from './renderer.js';
import { drawPixelMap, pickPixel, zoomWindow, panWindow, canPan, MAP_FITS, AXIS_UNITS } from './pixelMap2d.js';
import { createDataPanel, DATA_DEFAULTS } from './dataPanel.js';

const el = (id) => document.getElementById(id);
const frame = el('frame');
const legacyCanvas = el('scene');
const mapCanvas = el('map2d');

// Display-only options live here, not in geometry.js.
const VIEW_DEFAULTS = Object.freeze({
  // Show panel: only the grid (DEFAULT_STATE.showGrid) starts on.
  showTraversed: false,
  showTrackOff: false,
  showTrackIn: false,
  showLabels: true,
  loop: false,
  // 2D view
  view: '2d',
  mapFit: 'full',
  mapZoom: null, // µm window set by the mouse wheel; overrides mapFit until a framing button is used
  axisUnits: 'um',
  markTop: false,
  markMid: false,
  markExit: false,
});
const state = { ...DEFAULT_STATE, ...VIEW_DEFAULTS, ...DATA_DEFAULTS, animating: false };
let ELEVATION_MIN = -89; // the legacy 2D fallback narrows this to 5..85
let ELEVATION_MAX = 89;
let ZOOM_MIN = 0.3; // the legacy 2D fallback narrows this to 0.45..5
let ZOOM_MAX = 80;
const DURATION_MS = 3200;

let renderer = null;
let dataPanel = null;

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
/** Crossing cell: position on one line, pixel on the next. */
const crossing = (p, pixel) => `${um(p.x)}, ${um(p.y)}\npixel ${px(pixel)}`;
const FACE = { top: 'top', bottom: 'bottom', 'x-': 'x− side', 'x+': 'x+ side', 'y-': 'y− side', 'y+': 'y+ side' };

function updateReadout() {
  const ray = traceParticle(state);
  const volume = intersectVolume(state);
  const traversed = traversedPixels(state);
  el('hitStatus').textContent = ray.hit ? 'HIT' : 'MISS';
  el('hitStatus').className = ray.hit ? 'good' : 'warn';
  el('hitPosition').textContent = crossing(ray.top, ray.topPixel);
  el('midPosition').textContent = crossing(ray.mid, ray.midPixel);
  el('exitPosition').textContent = crossing(ray.bottom, ray.exitPixel);
  el('volumePath').textContent = volume ? `${FACE[volume.entryFace]} → ${FACE[volume.exitFace]}` : 'does not cross silicon';
  el('volumeLength').textContent = volume ? `${volume.length.toFixed(1)} µm · ${traversed.length} pixel${traversed.length === 1 ? '' : 's'}` : '—';
  el('stretchBadge').textContent = `Z display ×${state.zStretch}`;
  el('zLabel').textContent = `×${state.zStretch}`;
  el('rendererBadge').textContent = renderer?.kind === 'webgl' ? 'WebGL · Three.js' : '2D canvas fallback';
  el('timeline').value = String(Math.round(state.progress * 1000));
  el('progressLabel').textContent = `${Math.round(state.progress * 100)}%`;
  // 'data' only once an event is loaded: until then the viewport and track readouts are covered.
  document.body.dataset.mode = state.event ? 'data' : 'data-pending';
}

/* ---------------- 2D view ---------------- */
let mapTransformUsed = null;
let mapHover = null;
let mapPointer = null; // last pointer position over the map (CSS px), to re-pick after redraws
let mapDrag = null; // { x, y, transform } at the start of a drag

function drawMap() {
  const rect = mapCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (mapCanvas.width !== w || mapCanvas.height !== h) { mapCanvas.width = w; mapCanvas.height = h; }
  const trace = traceParticle(state);
  mapTransformUsed = drawPixelMap(mapCanvas.getContext('2d'), rect.width, rect.height, {
    trace,
    volume: intersectVolume(state),
    traversed: traversedPixels(state),
    charge: state.mode === 'data' ? state.charge : null,
    frameCharge: state.mode === 'data' && state.event ? { sparse: state.event.slices[state.event.slices.length - 1] } : null,
    mode: state.mode,
    progress: state.progress,
    fit: state.mapFit,
    customWindow: state.mapZoom,
    units: state.axisUnits,
    hover: mapHover,
    dpr,
    show: {
      grid: state.showGrid, traversed: state.showTraversed,
      trackOff: state.showTrackOff, trackIn: state.showTrackIn,
      top: state.markTop, mid: state.markMid, exit: state.markExit,
    },
  });
  const pannable = canPan(mapTransformUsed);
  mapCanvas.style.cursor = mapDrag ? 'grabbing' : pannable ? 'grab' : 'crosshair';
  mapCanvas.style.touchAction = pannable ? 'none' : ''; // a drag moves the map only when zoomed in
  // The window may have moved (new event, edited track): keep the hover on what is under the pointer now.
  if (mapPointer && mapHover) {
    const next = pickPixel(mapTransformUsed, mapPointer.x, mapPointer.y);
    const moved = (next.pixel?.x !== mapHover.pixel?.x) || (next.pixel?.y !== mapHover.pixel?.y);
    mapHover = next;
    if (moved) { drawPixelMapAgain(); return; }
  }
  renderHover();
}

function drawPixelMapAgain() {
  const keep = mapPointer;
  mapPointer = null; // one extra redraw at most
  drawMap();
  mapPointer = keep;
}

function renderHover() {
  const box = el('mapHover');
  if (!mapHover) { box.textContent = ''; return; }
  const { pixel, x, y } = mapHover;
  // Position in the axis units: µm, or pixels from the sensor centre.
  const where = state.axisUnits === 'px'
    ? `x ${(x / SENSOR.pitchX).toFixed(2)}, y ${(y / SENSOR.pitchY).toFixed(2)} px`
    : `x ${x.toFixed(1)}, y ${y.toFixed(1)} µm`;
  if (!pixel) { box.textContent = `${where} · outside sensor`; return; }
  let text = `pixel (${pixel.x}, ${pixel.y}) · ${where}`;
  if (state.charge) {
    const i = pixel.y * SENSOR.pixelsX + pixel.x;
    const q = state.charge.rawDense[i];
    const hidden = q && !state.charge.dense[i] ? ' (below threshold)' : '';
    text += ` · ${q ? (Math.round(q * 10) / 10).toLocaleString('en-US') : 0} e⁻${hidden}`;
  }
  box.textContent = text;
}

/** Two-way choices share one control: a .seg group of buttons carrying data-value. */
function setSegment(id, value) {
  for (const button of el(id).querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
}
function bindSegment(id, onPick) {
  el(id).addEventListener('click', (event) => {
    const value = event.target.closest('button')?.dataset.value;
    if (value) onPick(value);
  });
}

/** Apply a wheel, drag or keyboard view of the map; null returns to the full sensor. */
function setMapWindow(win) {
  state.mapZoom = win;
  if (!win) state.mapFit = 'full';
  setSegment('mapFit', win ? 'custom' : state.mapFit); // neither framing button is active on a custom view
  syncUrl();
  drawMap();
}

/** Keyboard equivalents of wheel zoom and drag. Returns true when the key was used. */
function mapKey(key) {
  const t = mapTransformUsed;
  if (!t) return false;
  if (key === '0') { setMapWindow(null); return true; }
  if (key === '+' || key === '=' || key === '-') {
    const px = t.pad.left + (t.width - t.pad.left - t.pad.right) / 2;
    const py = t.pad.top + (t.height - t.pad.top - t.pad.bottom) / 2;
    setMapWindow(zoomWindow(t, px, py, key === '-' ? 1 / 1.25 : 1.25));
    return true;
  }
  const move = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[key];
  if (!move || !canPan(t)) return false; // nothing to move: leave the key to the page
  setMapWindow(panWindow(t, move[0], move[1]));
  return true;
}

/** Mirror the display choices into the URL so a link reopens the same view. */
function syncUrl() {
  const params = new URLSearchParams(location.search);
  if (state.view === '3d') params.set('view', '3d'); else params.delete('view');
  if (state.axisUnits === 'px') params.set('units', 'px'); else params.delete('units');
  if (state.mapFit === 'track') params.set('fit', 'track'); else params.delete('fit');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

/**
 * The legacy 2D-canvas renderer (?renderer=2d) draws only the original 3D
 * scene: pixels crossed work only in the 2D view, and it has no labels toggle.
 * One place decides which controls are enabled.
 */
function syncLegacyControls() {
  if (renderer.kind === 'webgl') return;
  const in3d = state.view === '3d';
  for (const id of ['traversedToggle', 'labelsToggle']) {
    el(id).disabled = in3d || id === 'labelsToggle';
    el(id).title = in3d ? 'Not drawn by the 2D-canvas fallback; use the 2D view' : '';
  }
}

function setView(view) {
  state.view = view === '3d' ? '3d' : '2d';
  frame.dataset.view = state.view;
  document.body.dataset.view = state.view;
  setSegment('viewSwitch', state.view);
  el('canvasTip').textContent = renderer.kind === 'webgl' ? 'Drag orbit · right-drag pan · scroll zoom' : 'Drag to orbit · scroll to zoom';
  syncLegacyControls();
  syncUrl();
  mapHover = null;
  if (state.view === '3d') renderer.resize();
  update();
}

function update() {
  dataPanel?.syncLockedSlice();
  syncCameraInputs();
  updateReadout();
  if (state.view === '2d') drawMap();
  else renderer.render();
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
    update();
  });
}

function bindControls() {
  attachNumericField('z0', 10, 5000);

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
    ['gridToggle', 'showGrid'], ['midToggle', 'showMid'],
    ['traversedToggle', 'showTraversed'],
    ['trackOffToggle', 'showTrackOff'], ['trackInToggle', 'showTrackIn'],
    ['labelsToggle', 'showLabels'], ['loopToggle', 'loop'],
    ['markTop', 'markTop'], ['markMid', 'markMid'], ['markExit', 'markExit'],
  ]) {
    el(id).checked = !!state[key];
    el(id).addEventListener('change', (event) => {
      state[key] = event.target.checked;
      syncLegacyControls();
      update();
    });
  }

  bindSegment('viewSwitch', setView);
  bindSegment('mapFit', (value) => {
    state.mapFit = MAP_FITS.includes(value) ? value : 'full';
    state.mapZoom = null;
    setSegment('mapFit', state.mapFit);
    syncUrl();
    mapHover = null;
    update();
  });
  bindSegment('axisUnits', (value) => {
    state.axisUnits = AXIS_UNITS.includes(value) ? value : 'um';
    setSegment('axisUnits', state.axisUnits);
    syncUrl();
    update();
  });
  mapCanvas.addEventListener('pointermove', (event) => {
    if (!mapTransformUsed) return;
    const rect = mapCanvas.getBoundingClientRect();
    mapPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (mapDrag) {
      state.mapZoom = panWindow(mapDrag.transform, mapPointer.x - mapDrag.x, mapPointer.y - mapDrag.y);
      setSegment('mapFit', 'custom');
      mapHover = null; // no hover readout while dragging
      drawMap();
      return;
    }
    const next = pickPixel(mapTransformUsed, mapPointer.x, mapPointer.y);
    const same = mapHover && next.pixel?.x === mapHover.pixel?.x && next.pixel?.y === mapHover.pixel?.y;
    mapHover = next;
    if (same) renderHover(); else drawMap();
  });
  mapCanvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !mapTransformUsed || !canPan(mapTransformUsed)) return;
    const rect = mapCanvas.getBoundingClientRect();
    mapDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top, transform: mapTransformUsed };
    mapCanvas.setPointerCapture(event.pointerId);
    mapHover = null;
    drawMap();
  });
  for (const name of ['pointerup', 'pointercancel']) {
    mapCanvas.addEventListener(name, () => {
      if (!mapDrag) return;
      mapDrag = null;
      mapHover = mapPointer ? pickPixel(mapTransformUsed, mapPointer.x, mapPointer.y) : null;
      drawMap();
    });
  }
  mapCanvas.addEventListener('wheel', (event) => {
    if (!mapTransformUsed || mapDrag) { event.preventDefault(); return; }
    event.preventDefault(); // zoom the map instead of scrolling the page
    const rect = mapCanvas.getBoundingClientRect();
    mapPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    mapHover = pickPixel(mapTransformUsed, mapPointer.x, mapPointer.y);
    setMapWindow(zoomWindow(mapTransformUsed, mapPointer.x, mapPointer.y, Math.exp(-pixels * 0.0015)));
  }, { passive: false });
  mapCanvas.addEventListener('pointerleave', () => { if (mapDrag) return; mapHover = null; mapPointer = null; drawMap(); });

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
    const url = state.view === '2d'
      ? mapCanvas.toDataURL('image/png')
      : renderer.exportPNG ? renderer.exportPNG() : legacyCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `pixel-sensor-${state.view}-x${state.x0}-y${state.y0}-tx${state.thetaX}-ty${state.thetaY}.png`;
    link.click();
  });

  // Keyboard orbit/zoom on the viewport (both renderers).
  frame.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '0', ' '].includes(event.key)) return;
    if (event.key === ' ') { event.preventDefault(); play(); return; }
    if (state.view === '2d') { if (mapKey(event.key)) event.preventDefault(); return; }
    if (event.key === '0') return;
    event.preventDefault();
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
  const onResize = () => { if (state.view === '2d') drawMap(); else renderer.resize(); };
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(frame);
  else window.addEventListener('resize', onResize);
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
dataPanel = createDataPanel({ state, el, update, stopParticle: stop });
dataPanel.bind();
renderer.resize();
const params = new URLSearchParams(location.search);
state.axisUnits = params.get('units') === 'px' ? 'px' : 'um';
state.mapFit = params.get('fit') === 'track' ? 'track' : 'full';
setSegment('axisUnits', state.axisUnits);
setSegment('mapFit', state.mapFit);
setView(params.get('view') === '3d' ? '3d' : '2d'); // old ?view=2d links land here too

// Read-only diagnostics for the browser console / integration checks.
// Not a stable API; import geometry.js directly in code.
window.pixelSensorDebug = Object.freeze({
  get trace() { return traceParticle(state); },
  get volume() { return intersectVolume(state); },
  get traversed() { return traversedPixels(state); },
  get state() { return { ...state }; },
  get renderer() { return renderer.kind; },
  get event() { return state.event ? { fileId: state.event.fileId, eventIndex: state.event.eventIndex, truth: state.event.truth } : null; },
  get charge() { return state.charge ? { slice: state.charge.slice, ...state.charge.stats, scale: state.charge.scale } : null; },
  get dataStats() { return dataPanel.source ? { ...dataPanel.source.stats, ...dataPanel.source.cacheSizes() } : null; },
  get geometry() { return SENSOR; },
  get view() { return state.view; },
  get mapWindow() { return mapTransformUsed ? { ...mapTransformUsed.visible, scale: mapTransformUsed.scale } : null; },
});
