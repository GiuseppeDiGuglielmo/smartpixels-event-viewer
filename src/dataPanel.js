/**
 * PixelAV simulated events: event browser, time-slice control and the
 * simulated-event readout. Loads events lazily through eventSource.js (one
 * HTTP Range request per event, small LRU caches) — never whole files.
 *
 * PixelAV is the only data source, and every charge label says "PixelAV
 * simulated".
 */
import { createEventSource } from './eventSource.js';
import {
  DATA_MODE_DEFAULT_Z0, sliceToDense, applyThreshold, chargeStats, truthToParticle, lockedSlice, lockedProgress,
} from './pixelav.js';
import { traceParticle, intersectVolume, progressAtZ } from './geometry.js';
import { chargeLegend } from './chargeColors.js';

const PARTICLE_KEYS = ['x0', 'y0', 'z0', 'thetaX', 'thetaY'];
const SLICE_ANIMATION_MS = 2400;

export function createDataPanel({ state, el, update, stopParticle, dataUrl = './data/pixelav/' }) {
  let source = null;
  let sourcePromise = null;
  let loadToken = 0;
  let sliceTimer = null;
  let requested = null; // { fileId, index } of the newest request (rapid ◀/▶ clicks accumulate)

  const setStatus = (text, kind = '') => {
    el('dataStatus').textContent = text;
    el('dataStatus').className = `data-status ${kind}`;
    el('noEvent').textContent = text; // shown over the viewport until an event is loaded
  };

  async function ensureSource() {
    if (source) return source;
    sourcePromise ??= createEventSource({ baseUrl: dataUrl }).catch((error) => {
      sourcePromise = null;
      throw error;
    });
    source = await sourcePromise;
    const select = el('dataFile');
    select.innerHTML = '';
    for (const f of source.files()) {
      const option = document.createElement('option');
      option.value = String(f.id);
      option.textContent = `${f.split}/${f.name} · ${f.events} events`;
      select.append(option);
    }
    el('dataDataset').textContent = source.manifest.dataset ?? '—';
    return source;
  }

  function computeCharge() {
    const ev = state.event;
    if (!ev) { state.charge = null; return; }
    const t = Math.min(state.slice, ev.slices.length - 1);
    const finalStats = chargeStats(ev.slices[ev.slices.length - 1], state.threshold);
    const shown = applyThreshold(ev.slices[t], state.threshold);
    // Colour/bar scale fixed per event (max over ALL slices) so time evolution is visible
    // and earlier slices never exceed it.
    ev.scale ??= Math.max(...ev.slices.map((sl) => chargeStats(sl).max));
    ev.minCharge ??= Math.min(...ev.slices.map((sl) => chargeStats(sl).min));
    state.charge = {
      key: `${ev.fileId}:${ev.eventIndex}:${t}:${state.threshold}`,
      slice: t,
      // What the renderers draw: pixels with |q| above the display threshold.
      sparse: shown,
      dense: sliceToDense(shown),
      rawDense: sliceToDense(ev.slices[t]), // every pixel, for the hover readout
      stats: chargeStats(ev.slices[t], state.threshold),
      scale: ev.scale,
      minCharge: ev.minCharge,
      finalTotal: finalStats.total,
    };
  }

  function applyParticle(params) {
    Object.assign(state, params);
    for (const key of PARTICLE_KEYS) el(key).value = String(Number(state[key].toFixed(3)));
  }

  const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const bool = (v) => (v ? 'yes' : 'no');

  /** Signed colour scale of the event (fixed across its time slices). */
  function renderLegend() {
    const c = state.charge;
    if (!c) return;
    const { gradient, ticks } = chargeLegend(c.minCharge, c.scale);
    el('chargeRampLegend').style.background = gradient;
    el('chargeTicks').replaceChildren(...ticks.map(({ at, text }) => {
      const tick = document.createElement('span');
      tick.style.bottom = `${at}%`;
      tick.textContent = text;
      return tick;
    }));
  }

  function renderReadout() {
    const ev = state.event;
    el('eventPanel').hidden = !ev;
    if (!ev) return;
    const t = ev.truth;
    const c = state.charge;
    const rows = [
      ['pT (truth column)', fmt(t.pt, 4)],
      ['e–h pairs (truth)', fmt(t.number_eh_pairs, 0)],
      ['Share of final charge', c ? `${fmt((100 * c.stats.total) / (c.finalTotal || 1), 0)} %` : '—'],
      ['Net charge (all entries)', c ? `${fmt(c.stats.net, 0)} e⁻` : '—'],
      ['Max pixel', c ? `${fmt(c.stats.max, 0)} e⁻` : '—'],
      ['offset1 · offset2', `${fmt(t.offset1, 0)} · ${fmt(t.offset2, 0)}`],
      ['at edge (orig · uncent.)', `${bool(t.original_atEdge)} · ${bool(t.uncentered_atEdge)}`],
      ['truth entry (PixelAV)', `${fmt(t['x-entry'], 1)}, ${fmt(t['y-entry'], 1)} µm`],
    ];
    // The three numbers used to compare events stay visible; the rest is in Event details.
    el('sumCharge').textContent = c ? `${Math.round(c.stats.total).toLocaleString('en-US')} e⁻` : '—';
    el('sumPixels').textContent = c ? String(c.stats.nAbove) : '—';
    el('sumAngles').textContent = `${fmt(t.cotAlpha, 2)} · ${fmt(t.cotBeta, 2)}`;
    el('eventReadout').replaceChildren(...rows.map(([label, value]) => {
      const div = document.createElement('div');
      div.className = 'metric';
      const l = document.createElement('label');
      l.textContent = label;
      const s = document.createElement('strong');
      s.textContent = value;
      div.append(l, s);
      return div;
    }));
    el('sliceInput').max = String(ev.slices.length - 1);
    el('sliceLabel').textContent = c ? `slice ${c.slice} / ${ev.slices.length - 1}` : 'before impact';
    el('sliceInput').value = String(c?.slice ?? 0);
    renderLegend();
  }

  function writeUrl() {
    const params = new URLSearchParams(location.search);
    params.delete('mode'); // older links carried mode=data
    params.set('file', `${state.event.file.split}/${state.event.file.name}`); // stable across manifest rebuilds
    params.set('event', String(state.event.eventIndex));
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  }

  /** File id from a numeric id or a "split/name" permalink; 0 if unknown. */
  function resolveFile(src, ref) {
    if (ref === null || ref === undefined || ref === '') return 0;
    if (/^\d+$/.test(String(ref))) return Number(ref);
    const id = src.manifest.files.findIndex((f) => `${f.split}/${f.name}` === ref);
    return id >= 0 ? id : 0;
  }

  async function loadEvent(fileRef, eventIndex) {
    const token = ++loadToken;
    let stage = 'source';
    try {
      const src = await ensureSource();
      const fileId = resolveFile(src, fileRef);
      const file = src.manifest.files[fileId];
      if (!file) throw new RangeError(`No file #${fileId}`);
      const index = Math.min(Math.max(0, Math.trunc(eventIndex) || 0), file.events - 1);
      requested = { fileId, index };
      setStatus(`Loading ${file.split}/${file.name} #${index}…`);
      const ev = await src.getEvent(fileId, index);
      if (token !== loadToken) return; // a newer request won
      stage = 'apply';
      // Compute everything before mutating state, so a bad record leaves the old event intact.
      const params = truthToParticle(ev.truth, state.dataZ0);
      stopSlices();
      stopParticle();
      state.event = ev;
      state.slice = ev.slices.length - 1;
      computeCharge();
      applyParticle(params);
      el('dataFile').value = String(fileId);
      el('eventIndex').value = String(index);
      el('eventIndex').max = String(file.events - 1);
      state.progress = 1;
      setStatus(''); // loaded: nothing to report
      writeUrl();
      renderReadout();
      update();
    } catch (error) {
      if (token !== loadToken) return;
      const hint = stage === 'source' ? ' Run `npm run sample` for 6 example events, or see docs/SETUP.md to convert the dataset.' : '';
      setStatus(`${error.message}${hint}`, 'error');
      update();
    }
  }

  /** Animation range inside the silicon, over which locked slices are spread. */
  function siliconRange() {
    const volume = intersectVolume(state);
    if (!volume) return { enter: 0, leave: 1 };
    const trace = traceParticle(state);
    return { enter: progressAtZ(trace, volume.entry.z), leave: progressAtZ(trace, volume.exit.z) };
  }

  /** With the lock on, the animation position decides the charge slice. Called before each redraw. */
  function syncLockedSlice() {
    if (!state.lockCharge || !state.event) return;
    const { enter, leave } = siliconRange();
    const t = lockedSlice(state.progress, enter, leave, state.event.slices.length);
    if (t === null) {
      if (state.charge) { state.charge = null; renderReadout(); }
      return;
    }
    if (t === state.charge?.slice) return;
    state.slice = t;
    computeCharge();
    renderReadout();
  }

  /** The chain between the Particle and Charge sliders: closed = locked, open = independent. */
  function showLock() {
    const button = el('lockCharge');
    const locked = state.lockCharge;
    button.setAttribute('aria-pressed', String(locked));
    button.setAttribute('aria-label', locked ? 'Particle and charge locked. Unlock' : 'Particle and charge independent. Lock');
    button.title = locked
      ? 'Locked: particle and charge move together (a display mapping, not physical time). Click to unlock.'
      : 'Unlocked: particle and charge move independently. Click to lock.';
    el('playSlices').hidden = locked;
  }

  function setLock(locked) {
    state.lockCharge = locked;
    showLock();
    stopSlices();
    if (locked && state.event) {
      // Keep the slice on screen: move the particle to it.
      stopParticle();
      const { enter, leave } = siliconRange();
      state.progress = lockedProgress(state.slice, enter, leave, state.event.slices.length);
    } else if (state.event && !state.charge) {
      computeCharge();
    }
    if (state.event) renderReadout();
    update();
  }

  function setSlice(t) {
    if (!state.event) return;
    state.slice = Math.max(0, Math.min(state.event.slices.length - 1, t));
    if (state.lockCharge) {
      stopParticle();
      const { enter, leave } = siliconRange();
      state.progress = lockedProgress(state.slice, enter, leave, state.event.slices.length);
    }
    computeCharge();
    renderReadout();
    update();
  }

  function stopSlices() {
    if (sliceTimer !== null) cancelAnimationFrame(sliceTimer);
    sliceTimer = null;
    el('playSlices').textContent = '▶ Charge vs time';
  }

  function playSlices() {
    if (!state.event) return;
    if (sliceTimer !== null) { stopSlices(); return; }
    const last = state.event.slices.length - 1;
    const started = performance.now();
    el('playSlices').textContent = '❚❚ Pause';
    const step = (now) => {
      const t = Math.min(last, Math.floor(((now - started) / SLICE_ANIMATION_MS) * (last + 1)));
      if (t !== state.charge?.slice) setSlice(t);
      if (t >= last) { stopSlices(); return; }
      sliceTimer = requestAnimationFrame(step);
    };
    setSlice(0);
    sliceTimer = requestAnimationFrame(step);
  }

  function bind() {
    el('dataFile').addEventListener('change', () => loadEvent(Number(el('dataFile').value), 0));
    el('eventIndex').addEventListener('change', () => loadEvent(Number(el('dataFile').value), Number(el('eventIndex').value)));
    const step = (delta) => () => {
      const base = requested ?? { fileId: Number(el('dataFile').value), index: state.event?.eventIndex ?? 0 };
      // Record the target synchronously so several quick clicks accumulate
      // (loadEvent clamps it to the file and re-records it).
      requested = { fileId: base.fileId, index: base.index + delta };
      loadEvent(requested.fileId, requested.index);
    };
    el('eventPrev').addEventListener('click', step(-1));
    el('eventNext').addEventListener('click', step(1));
    el('eventRandom').addEventListener('click', () => {
      const file = source?.manifest.files[Number(el('dataFile').value)];
      if (file) loadEvent(Number(el('dataFile').value), Math.floor(Math.random() * file.events));
    });
    el('sliceInput').addEventListener('input', (event) => { stopSlices(); setSlice(Number(event.target.value)); });
    el('playSlices').addEventListener('click', playSlices);
    showLock();
    el('lockCharge').addEventListener('click', () => setLock(!state.lockCharge));
    el('barsToggle').checked = state.showChargeBars;
    el('barsToggle').addEventListener('change', (event) => { state.showChargeBars = event.target.checked; update(); });
    el('threshold').addEventListener('change', () => {
      const v = Number(el('threshold').value);
      state.threshold = Number.isFinite(v) && v >= 0 ? v : 0;
      el('threshold').value = String(state.threshold);
      computeCharge();
      renderReadout();
      update();
    });
    // z0 stays editable in data mode: it only moves the start point along the truth line.
    el('z0').addEventListener('change', () => {
      if (!state.event) return;
      state.dataZ0 = state.z0;
      applyParticle(truthToParticle(state.event.truth, state.dataZ0));
      update();
    });
    const params = new URLSearchParams(location.search);
    loadEvent(params.get('file'), Number(params.get('event') ?? 0));
  }

  return { bind, syncLockedSlice, get source() { return source; } };
}

export const DATA_DEFAULTS = Object.freeze({
  mode: 'data',
  event: null,
  charge: null,
  slice: 19,
  threshold: 0,
  showChargeBars: true,
  lockCharge: true, // Play and the Time slider also drive the charge time slice
  dataZ0: DATA_MODE_DEFAULT_Z0,
});
