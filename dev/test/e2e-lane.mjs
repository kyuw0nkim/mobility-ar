// 경로 기록 → 차선 맞추기 → 저장 → 주행 (A4 시트 합성 영상, 헤드리스 Chromium)
// 먼저: node tools/make-sheet.mjs && node test/make-video.mjs && node build.mjs, dist/에서 http 서버(8765)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { lookAt } from './render-lite.mjs';
import { project, makeK } from '../src/geometry.js';
import { ROAD } from '../src/config.js';
import { roundedRectPath, smoothPath } from '../src/logic.js';
const video = new URL('./cam.y4m', import.meta.url).pathname;
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8765/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('#btnCamera');
const t0 = Date.now();
await page.waitForTimeout(1500);
await page.click('#btnRecord');
// 도로 중심선을 따라 16번, ±0.5cm 정도 어긋나게 탭
const center = roundedRectPath(ROAD.x0, ROAD.y0, ROAD.x1, ROAD.y1, ROAD.r, 8);
const dense = smoothPath(center, true, 0.2);
const K = makeK(1024, 640, 360);
let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const rect = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
for (let i = 0; i < 16; i++) {
  const p = dense[Math.floor((i / 16) * dense.length)];
  const tgt = [p[0] + rnd(), p[1] + rnd(), 0];
  const t = ((Date.now() - t0) / 1000) % 12;
  const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
  const L = lookAt(pos, [14, 10, 0]);
  const u = project(K, L.R, L.t, tgt);
  await page.mouse.click(rect.l + (u[0] / 1280) * rect.w, rect.t + (u[1] / 720) * rect.h);
  await page.waitForTimeout(250);
}
await page.click('#recSnap');
await page.waitForTimeout(300);
const st = await page.evaluate(() => window.__raim.state);
const status = await page.textContent('#status');
console.log('상태 문구:', status);
console.log('모은 장면', st.mosaicFrames, '· 차선 맞추기', st.lastSnap && st.lastSnap.ok, st.lastSnap && st.lastSnap.reason || '',
  st.lastSnap && st.lastSnap.laneWidth ? `차선 폭 ${st.lastSnap.laneWidth.toFixed(2)}cm · 구간 ${(st.lastSnap.validFrac * 100).toFixed(0)}%` : '');
// 도로 중심선에서의 가로 거리 (+ 바깥)
const sd = (x, y) => {
  const cx = (ROAD.x0 + ROAD.x1) / 2, cy = (ROAD.y0 + ROAD.y1) / 2, hx = (ROAD.x1 - ROAD.x0) / 2 - ROAD.r, hy = (ROAD.y1 - ROAD.y0) / 2 - ROAD.r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - ROAD.r;
};
const lat = (pts) => { const d = smoothPath(pts, true, 0.2).map((p) => sd(p[0], p[1])); const m = d.reduce((a, b) => a + b, 0) / d.length; return `가로 위치 평균 ${m.toFixed(2)}cm · 범위 ${Math.min(...d).toFixed(2)}~${Math.max(...d).toFixed(2)}cm`; };
console.log('탭 그대로  :', lat(st.recPts));
if (st.snapped) console.log('차선 맞춤  :', lat(st.snapped), '(반 차선 가운데 = ±0.75cm)');
await page.screenshot({ path: new URL('./e2e-lane-snap.png', import.meta.url).pathname });
await page.click('#recDone');
await page.waitForTimeout(400);
const s0 = (await page.evaluate(() => window.__raim.state)).s;
await page.click('#carBigger');
await page.waitForTimeout(1600);
const s1 = await page.evaluate(() => window.__raim.state);
console.log('저장된 경로 = 맞춘 경로:', JSON.stringify(s1.path) === JSON.stringify(st.snapped || st.recPts), '· 주행 거리 증가', (s1.s - s0).toFixed(2), 'cm · 차 크기 ×', s1.carScale);
await page.screenshot({ path: new URL('./e2e-lane-drive.png', import.meta.url).pathname });
console.log('errors:', errs);
await browser.close();
