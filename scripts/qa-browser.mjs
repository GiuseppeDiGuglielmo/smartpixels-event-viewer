#!/usr/bin/env node
// Headless-Chrome UI check over the DevTools protocol (no npm packages).
//
//   npm run dev &                                   # in another shell
//   STEPS='[{"wait":2500,"shot":"default"},
//           {"set":{"dataMode":"data"},"wait":2000,"js":"pixelSensorDebug.event?.eventIndex","shot":"data"}]' \
//     node scripts/qa-browser.mjs http://127.0.0.1:5173/ /tmp/qa-out
//
// Each step runs, in this order: set (input values, fires change+input), check
// (checkboxes), click (element id), wait (ms, default 600), js (expression,
// printed), shot (PNG of the viewport panel into <outdir>). Console messages and
// uncaught exceptions are printed at the end; the exit code is 1 if any
// exception was thrown.
// WebGL runs on SwiftShader, so no GPU is needed. CHROME=/path/to/chrome overrides the binary.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url = 'http://127.0.0.1:5173/', out = 'qa-out'] = process.argv.slice(2);
const steps = JSON.parse(process.env.STEPS ?? '[{"wait":2500,"shot":"default"}]');
const port = Number(process.env.CDP_PORT ?? 9333);
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'pixel-qa-'));

const chrome = spawn(process.env.CHROME ?? 'google-chrome', [
  '--headless=new', '--no-sandbox', `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars',
  '--window-size=1400,1250', `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });
const chromeExited = new Promise((r) => chrome.once('exit', r));
// Wait for Chrome to exit before deleting its profile (it keeps writing until then).
const cleanup = async () => {
  try { chrome.kill(); } catch { /* already gone */ }
  await Promise.race([chromeExited, new Promise((r) => setTimeout(r, 3000))]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, harmless */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 40 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* Chrome not up yet */ }
  if (!ws) await sleep(250);
}
if (!ws) { await cleanup(); console.error('Could not reach Chrome DevTools; is google-chrome installed (or CHROME set)?'); process.exit(2); }
await new Promise((r) => ws.addEventListener('open', r));

let id = 0; let exceptions = 0;
const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') { exceptions++; logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
// Screenshots cover the viewport panel (SHOT_SELECTOR overrides it, e.g. "body").
const shot = async (name) => {
  const sel = process.env.SHOT_SELECTOR ?? '.viewport-panel';
  const rect = await evaluate(`(()=>{const r=document.querySelector(${q(sel)}).getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};})()`);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.result.data, 'base64'));
};
const q = JSON.stringify;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(1500);
for (const step of steps) {
  for (const [k, v] of Object.entries(step.set ?? {})) {
    await evaluate(`(()=>{const e=document.getElementById(${q(k)});e.value=${q(String(v))};e.dispatchEvent(new Event('change'));e.dispatchEvent(new Event('input'));})()`);
  }
  for (const [k, v] of Object.entries(step.check ?? {})) {
    await evaluate(`(()=>{const e=document.getElementById(${q(k)});e.checked=${Boolean(v)};e.dispatchEvent(new Event('change'));})()`);
  }
  // click: an element id, or a CSS selector (e.g. "#axisUnits [data-value=px]").
  if (step.click) await evaluate(`(document.getElementById(${q(step.click)}) ?? document.querySelector(${q(step.click)})).click()`);
  await sleep(step.wait ?? 600);
  if (step.js) console.log(step.js.slice(0, 70), '=>', JSON.stringify(await evaluate(step.js)));
  if (step.shot) await shot(step.shot);
}
console.log(logs.join('\n') || '(no console output)');
ws.close();
await cleanup();
process.exit(exceptions ? 1 : 0);
