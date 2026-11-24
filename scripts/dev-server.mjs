/**
 * Tiny dependency-free static server for native ES modules.
 *
 *  - Streams files (never reads a whole file into memory).
 *  - Supports single HTTP Range requests (206), used to fetch one pixelAV event
 *    at a time from large *.events.bin files.
 *  - Serves converted pixelAV data under /data/pixelav/ from PIXELAV_DATA
 *    (default: <project>/data/pixelav). Paths cannot escape either root.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --sample serves the 6 real events kept in the repository, so a fresh clone works without the dataset.
const defaultData = process.argv.includes('--sample')
  ? resolve(projectRoot, 'tests', 'fixtures', 'pixelav')
  : resolve(projectRoot, 'data', 'pixelav');
const dataRoot = resolve(process.env.PIXELAV_DATA ?? defaultData);
const DATA_PREFIX = '/data/pixelav/';
const port = Number.parseInt(process.env.PORT ?? '5173', 10);
const host = process.env.HOST ?? '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
};

const inside = (root, file) => file === root || file.startsWith(root + sep);

/** Resolve a URL path inside `root`; null if it would escape. */
export function safeResolve(root, relativePath) {
  const file = resolve(root, `.${relativePath}`);
  return inside(root, file) ? file : null;
}

/** Dot-files and dot-directories (.git, .claude, .omc, .env…) are never served. */
export function isHiddenPath(pathname) {
  return pathname.split('/').some((segment) => segment.startsWith('.'));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** DNS-rebinding guard: on a loopback bind, only accept loopback Host headers. */
export function hostAllowed(bindHost, hostHeader) {
  if (!LOOPBACK.has(bindHost)) return true;
  const name = String(hostHeader ?? '').replace(/:\d+$/, '');
  return LOOPBACK.has(name);
}

/** Parse a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range; null = ignore, 'invalid' = 416. */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null; // multi-range or junk: send whole file
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (!hostAllowed(host, request.headers.host)) {
      response.writeHead(421).end('Misdirected request');
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (isHiddenPath(pathname)) throw new Error('hidden path');
    const isData = pathname.startsWith(DATA_PREFIX);
    const root = isData ? dataRoot : projectRoot;
    const file = isData
      ? safeResolve(dataRoot, `/${pathname.slice(DATA_PREFIX.length)}`)
      : safeResolve(projectRoot, pathname === '/' ? '/index.html' : pathname);
    // Also refuse symlinks that point outside the served root.
    if (!file || !inside(await realpath(root), await realpath(file))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const headers = {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    const range = parseRange(request.headers.range, info.size);
    if (range === 'invalid') {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    if (range) {
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`, 'Content-Length': range.end - range.start + 1 });
    } else {
      response.writeHead(200, { ...headers, 'Content-Length': info.size });
    }
    if (request.method === 'HEAD') { response.end(); return; }
    // pipeline() destroys the file stream when the client disconnects (no fd leak).
    pipeline(createReadStream(file, range ? { start: range.start, end: range.end } : undefined), response, () => {});
  } catch {
    if (!response.headersSent) response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    else response.destroy();
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    process.stdout.write(`Pixel Sensor Simulator: http://${host}:${port}/\n`);
    process.stdout.write(`pixelAV data: ${dataRoot} → ${DATA_PREFIX}\n`);
    if (!LOOPBACK.has(host)) process.stderr.write(`WARNING: HOST=${host} serves ${projectRoot} to the network.\n`);
  });
}

export { server };
