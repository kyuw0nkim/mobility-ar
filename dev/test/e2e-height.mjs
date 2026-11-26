// [높이 +/−]: 차·경로 표시가 그 높이로 올라가고, 경로 기록 탭이 그 높이의 면 기준으로 계산되는지 (A4 합성 영상)
import { createRequire } from 'node:module';
import { lookAt } from './render-lite.mjs';
import { project, makeK } from '../src/geometry.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const video = new URL('./cam.y4m', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8765/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('#btnCamera');
const t0 = Date.now();
await page.waitForTimeout(1200);
for (let i = 0; i < 20; i++) await page.click('#heightUp');
await page.click('#heightDown');
const st = await page.evaluate(() => window.__raim.state);
const h = st.roadHeight;
console.log('도로 높이', h, 'cm · 표시층 높이', st.worldZ, '· 문구:', await page.textContent('#status'));
await page.click('#btnRecord');
const K = makeK(1024, 640, 360);
const rect = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
const targets = [[8, 7], [21, 7], [21, 14], [8, 14]];
for (const z of [h, 0]) {
  for (const [x, y] of targets) {
    const t = ((Date.now() - t0) / 1000) % 12;
    const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
    const L = lookAt(pos, [14, 10, 0]);
    const u = project(K, L.R, L.t, [x, y, z]);
    await page.mouse.click(rect.l + (u[0] / 1280) * rect.w, rect.t + (u[1] / 720) * rect.h);
    await page.waitForTimeout(150);
  }
}
const pts = (await page.evaluate(() => window.__raim.state)).recPts;
const e = (a, b) => pts.slice(a, b).map((p, i) => Math.hypot(p[0] - targets[i][0], p[1] - targets[i][1]).toFixed(2)).join(', ');
console.log(`높이 ${h}cm 면 위 점을 탭 → 기록 오차(cm):`, e(0, 4), ' (작아야 함)');
console.log('테이블 면(0cm) 점을 탭 → 기록 오차(cm):', e(4, 8), ' (높이만큼 어긋나야 함)');
console.log('errors:', errs);
await browser.close();
