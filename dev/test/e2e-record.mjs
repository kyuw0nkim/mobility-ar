import puppeteer from 'puppeteer-core';
import { lookAt } from './render.mjs';
import { project, makeK } from '../src/geometry.js';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=/home/claude/marker-proto/test/cam.y4m', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8765/index.html');
await page.click('#btnCamera');
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 1500));
await page.click('#btnRecord');
const targets = [[8, 7], [21, 7], [21, 14], [8, 14]];
const K = makeK(1024, 640, 360);
for (const [x, y] of targets) {
  const t = ((Date.now() - t0) / 1000) % 12;
  const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
  const u = project(K, lookAt(pos, [14, 10, 0]).R, lookAt(pos, [14, 10, 0]).t, [x, y, 0]);
  const rect = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(rect.l + (u[0] / 1280) * rect.w, rect.t + (u[1] / 720) * rect.h);
  await new Promise((r) => setTimeout(r, 150));
}
const pts = await page.evaluate(() => window.__raim.state.recPts);
console.log('기록된 점:', JSON.stringify(pts));
console.log('목표 점:', JSON.stringify(targets));
console.log('오차(cm):', pts.map((p, i) => Math.hypot(p[0] - targets[i][0], p[1] - targets[i][1]).toFixed(2)).join(', '));
await page.screenshot({ path: 'test/e2e-record.png' });
await page.click('#recDone');
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'test/e2e-newpath.png' });
console.log('errors:', errs);
await browser.close();
