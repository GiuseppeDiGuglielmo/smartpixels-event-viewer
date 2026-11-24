/**
 * Memory-bounded access to converted PixelAV events.
 *
 *  - manifest.json is fetched once (a few KB);
 *  - a file's index (~0.9 MB for 5000 events: offsets + truth) is fetched only
 *    when that file is opened and kept in a small LRU (default 4 files);
 *  - each event is fetched alone with an HTTP Range request (~3 KB) and kept
 *    in an LRU of decoded events (default 64).
 * So browsing never downloads or holds a whole events file. `fetchImpl` is
 * injectable for tests.
 */
import { validateManifest, decodeIndex, decodeEvent } from './pixelav.js';

class LRU {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
  get size() { return this.map.size; }
}

export async function createEventSource({
  baseUrl = './data/pixelav/',
  fetchImpl = (...args) => fetch(...args),
  maxIndexes = 4,
  maxEvents = 64,
  maxFallbackBytes = 64e6,
} = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const stats = { indexFetches: 0, eventFetches: 0, bytes: 0, fullFileFallbacks: 0 };

  async function fetchBuffer(path, range) {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : undefined;
    const response = await fetchImpl(base + path, headers ? { headers } : undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    let buffer = await response.arrayBuffer();
    if (range && response.status !== 206) {
      // Server ignored Range: still correct, but the whole file was transferred.
      // Refuse absurd fallbacks instead of buffering huge files in the tab.
      stats.fullFileFallbacks++;
      if (buffer.byteLength > maxFallbackBytes) {
        throw new Error(`Server ignored the Range request (${(buffer.byteLength / 1e6).toFixed(0)} MB); use a Range-capable server (npm run dev).`);
      }
      buffer = buffer.slice(range[0], range[1]);
    }
    stats.bytes += buffer.byteLength;
    return buffer;
  }

  const manifestResponse = await fetchImpl(`${base}manifest.json`);
  if (!manifestResponse.ok) throw new Error(`No converted PixelAV data at ${base} (HTTP ${manifestResponse.status}).`);
  const manifest = validateManifest(await manifestResponse.json());
  const indexes = new LRU(maxIndexes);
  const pendingIndexes = new Map();
  const events = new LRU(maxEvents);

  function fileEntry(fileId) {
    const entry = manifest.files[fileId];
    if (!entry) throw new RangeError(`No file #${fileId} in manifest.`);
    return entry;
  }

  async function loadIndex(fileId) {
    const cached = indexes.get(fileId);
    if (cached) return cached;
    if (pendingIndexes.has(fileId)) return pendingIndexes.get(fileId);
    const promise = (async () => {
      stats.indexFetches++;
      const index = decodeIndex(await fetchBuffer(fileEntry(fileId).index), manifest.truthColumns);
      if (index.nEvents !== fileEntry(fileId).events) throw new Error('Index event count differs from manifest.');
      indexes.set(fileId, index);
      return index;
    })();
    pendingIndexes.set(fileId, promise);
    try { return await promise; } finally { pendingIndexes.delete(fileId); }
  }

  async function getEvent(fileId, eventIndex) {
    const key = `${fileId}:${eventIndex}`;
    const cached = events.get(key);
    if (cached) return cached;
    const index = await loadIndex(fileId);
    const range = index.range(eventIndex);
    stats.eventFetches++;
    const decoded = decodeEvent(await fetchBuffer(fileEntry(fileId).data, range));
    if (decoded.eventIndex !== eventIndex) throw new Error(`Record holds event ${decoded.eventIndex}, expected ${eventIndex}.`);
    const event = {
      fileId,
      file: fileEntry(fileId),
      eventIndex,
      truth: index.truthOf(eventIndex),
      slices: decoded.slices,
    };
    events.set(key, event);
    return event;
  }

  return {
    manifest,
    stats,
    files: () => manifest.files.map((f, id) => ({ id, ...f })),
    loadIndex,
    getEvent,
    cacheSizes: () => ({ indexes: indexes.size, events: events.size }),
  };
}
