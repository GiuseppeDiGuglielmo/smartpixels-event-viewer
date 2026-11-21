import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseRange, safeResolve, isHiddenPath, hostAllowed } from '../scripts/dev-server.mjs';

test('Range parsing: explicit, open-ended, suffix, clamped, invalid, multi-range ignored', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(parseRange('bytes=1000-1001', 1000), 'invalid');
  assert.equal(parseRange('bytes=50-10', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
});

test('paths cannot escape the served roots', () => {
  const root = resolve('/srv/app');
  assert.equal(safeResolve(root, '/index.html'), resolve('/srv/app/index.html'));
  assert.equal(safeResolve(root, '/../etc/passwd'), null);
  assert.equal(safeResolve(root, '/a/../../x'), null);
});

test('dot-paths are hidden and loopback binds reject foreign Host headers (DNS rebinding)', () => {
  assert.equal(isHiddenPath('/.claude/CLAUDE.md'), true);
  assert.equal(isHiddenPath('/data/pixelav/.secret'), true);
  assert.equal(isHiddenPath('/src/main.js'), false);
  assert.equal(hostAllowed('127.0.0.1', '127.0.0.1:5173'), true);
  assert.equal(hostAllowed('127.0.0.1', 'localhost:5173'), true);
  assert.equal(hostAllowed('127.0.0.1', 'evil.example:5173'), false);
  assert.equal(hostAllowed('0.0.0.0', 'anything'), true);
});
