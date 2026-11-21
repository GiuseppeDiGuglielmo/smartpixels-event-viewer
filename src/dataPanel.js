/**
 * "pixelAV simulated events" mode: event browser, time-slice control and the
 * simulated-event readout. Loads events lazily through eventSource.js (one
 * HTTP Range request per event, small LRU caches) — never whole files.
 *
 * Charge is shown only in data mode, and every label there says "pixelAV
 * simulated"; demo mode is geometry only.
 */
import { createEventSource } from './eventSource.js';
import {
  DATA_MODE_DEFAULT_Z0, sliceToDense, chargeStats, truthToParticle, truthMidplane,
} from './pixelav.js';
import { RAMP_CSS } from './chargeColors.js';

const PARTICLE_KEYS = ['x0', 'y0', 'z0', 'thetaX', 'thetaY'];
const SLICE_ANIMATION_MS = 2400;

export function createDataPanel({ state, el, update, stopParticle, dataUrl = './data/pixelav/' }) {
  let source = null;
  let sourcePromise = null;
  let demoStash = null;
  let loadToken = 0;
  let sliceTimer = null;
  let requested = null; // { fileId, index } of the newest request (rapid ◀/▶ clicks accumulate)
  let lastEvent = null; // restored when re-entering data mode

  const setStatus = (text, kind = '') => {
    el('dataStatus').textContent = text;
    el('dataStatus').className = `data-status ${kind}`;
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
    // Colour/bar scale fixed per event (max over ALL slices) so time evolution is visible
    // and earlier slices never exceed it.
    ev.scale ??= Math.max(...ev.slices.map((sl) => chargeStats(sl).max));
    state.charge = {
      key: `${ev.fileId}:${ev.eventIndex}:${t}`,
      slice: t,
      sparse: ev.slices[t],
      dense: sliceToDense(ev.slices[t]),
      stats: chargeStats(ev.slices[t], state.threshold),
      scale: ev.scale,
      finalTotal: finalStats.total,
    };
  }

  function applyParticle(params) {
    Object.assign(state, params);
    for (const key of PARTICLE_KEYS) el(key).value = String(Number(state[key].toFixed(3)));
  }

  const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const bool = (v) => (v ? 'yes' : 'no');

  function renderReadout() {
    const ev = state.event;
    el('eventPanel').hidden = !(state.mode === 'data' && ev);
    if (!ev) return;
    const t = ev.truth;
    const c = state.charge;
    const mid = truthMidplane(t);
    const residual = c?.stats.centroid && mid
      ? `${fmt(c.stats.centroid.x - mid.x, 1)}, ${fmt(c.stats.centroid.y - mid.y, 1)} µm`
      : '—';
    const rows = [
      ['Event', `${ev.file.split}/${ev.file.name} #${ev.eventIndex}`],
      ['cotα · cotβ', `${fmt(t.cotAlpha, 3)} · ${fmt(t.cotBeta, 3)}`],
      ['pT (truth column)', fmt(t.pt, 4)],
      ['e–h pairs (truth)', fmt(t.number_eh_pairs, 0)],
      [`Σ q>0 @ slice ${c?.slice ?? '—'}`, c ? `${fmt(c.stats.total, 0)} e⁻ (${fmt((100 * c.stats.total) / (c.finalTotal || 1), 0)} %)` : '—'],
      ['Net charge (all entries)', c ? `${fmt(c.stats.net, 0)} e⁻` : '—'],
      [`Pixels > ${state.threshold} e⁻`, c ? String(c.stats.nAbove) : '—'],
      ['Max pixel', c ? `${fmt(c.stats.max, 0)} e⁻` : '—'],
      ['Charge centroid px', c?.stats.centroidPixel ? `(${c.stats.centroidPixel.x}, ${c.stats.centroidPixel.y})` : '—'],
      ['Centroid − truth mid', residual],
      ['offset1 · offset2', `${fmt(t.offset1, 0)} · ${fmt(t.offset2, 0)}`],
      ['at edge (orig · uncent.)', `${bool(t.original_atEdge)} · ${bool(t.uncentered_atEdge)}`],
      ['truth entry (pixelAV)', `${fmt(t['x-entry'], 1)}, ${fmt(t['y-entry'], 1)} µm`],
    ];
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
    el('sliceLabel').textContent = `${c?.slice ?? 0} / ${ev.slices.length - 1}`;
    el('sliceInput').value = String(c?.slice ?? 0);
  }

  function writeUrl() {
    const params = new URLSearchParams(location.search);
    if (state.mode === 'data' && state.event) {
      params.set('mode', 'data');
      params.set('file', `${state.event.file.split}/${state.event.file.name}`); // stable across manifest rebuilds
      params.set('event', String(state.event.eventIndex));
    } else {
      params.delete('mode'); params.delete('file'); params.delete('event');
    }
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
      if (token !== loadToken || state.mode !== 'data') return; // a newer request won
      stage = 'apply';
      // Compute everything before mutating state, so a bad record leaves the old event intact.
      const params = truthToParticle(ev.truth, state.dataZ0);
      stopSlices();
      stopParticle();
      state.event = ev;
      state.slice = ev.slices.length - 1;
      computeCharge();
      applyParticle(params);
      lastEvent = { fileId, index };
      el('dataFile').value = String(fileId);
      el('eventIndex').value = String(index);
      el('eventIndex').max = String(file.events - 1);
      state.progress = 1;
      const kb = (src.stats.bytes / 1024).toFixed(0);
      setStatus(`pixelAV simulated event loaded · ${src.cacheSizes().events} cached · ${kb} KB fetched this session`, 'ok');
      writeUrl();
      renderReadout();
      update();
    } catch (error) {
      if (token !== loadToken) return;
      const hint = stage === 'source' ? ' — convert data first: see docs/PIXELAV_DATA.md' : '';
      setStatus(`${error.message}${hint}`, 'error');
      update();
    }
  }

  function enterData() {
    if (state.mode === 'data') return;
    demoStash = {
      ...Object.fromEntries(PARTICLE_KEYS.map((k) => [k, state[k]])),
      preset: el('preset').value,
    };
    state.mode = 'data';
    el('dataControls').hidden = false;
    lockParticleInputs(true);
    const params = new URLSearchParams(location.search);
    if (lastEvent) loadEvent(lastEvent.fileId, lastEvent.index);
    else loadEvent(params.get('file'), Number(params.get('event') ?? 0));
    update();
  }

  function enterDemo() {
    if (state.mode === 'demo') return;
    loadToken++;
    stopSlices();
    state.mode = 'demo';
    state.event = null;
    state.charge = null;
    el('dataControls').hidden = true;
    lockParticleInputs(false);
    if (demoStash) {
      for (const k of PARTICLE_KEYS) { state[k] = demoStash[k]; el(k).value = String(state[k]); }
      el('preset').value = demoStash.preset;
    }
    state.progress = 1;
    writeUrl();
    renderReadout();
    update();
  }

  function lockParticleInputs(locked) {
    for (const id of ['x0', 'y0', 'thetaX', 'thetaY', 'preset']) {
      el(id).disabled = locked;
      el(id).title = locked ? 'Set by the pixelAV truth of the loaded event' : '';
    }
    el('z0').title = locked ? 'Start height above the surface (display only; the truth line is fixed)' : '';
  }

  function setSlice(t) {
    if (!state.event) return;
    state.slice = Math.max(0, Math.min(state.event.slices.length - 1, t));
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
    el('chargeRampLegend').style.background = RAMP_CSS;
    el('dataMode').addEventListener('change', (event) => (event.target.value === 'data' ? enterData() : enterDemo()));
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
      if (state.mode !== 'data' || !state.event) return;
      state.dataZ0 = state.z0;
      applyParticle(truthToParticle(state.event.truth, state.dataZ0));
      update();
    });
    if (new URLSearchParams(location.search).get('mode') === 'data') {
      el('dataMode').value = 'data';
      enterData();
    }
  }

  return { bind, get source() { return source; } };
}

export const DATA_DEFAULTS = Object.freeze({
  mode: 'demo',
  event: null,
  charge: null,
  slice: 19,
  threshold: 0,
  showChargeBars: true,
  dataZ0: DATA_MODE_DEFAULT_Z0,
});
