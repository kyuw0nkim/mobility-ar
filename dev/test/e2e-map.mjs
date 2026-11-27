import puppeteer from 'puppeteer-core';
import { GT } from './make-video-big.mjs';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/home/claude/marker-proto/test/big.y4m', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8765/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('#btnCamera');
await new Promise((r) => setTimeout(r, 300));
await page.click('#btnMap');
const t0 = Date.now();
let shot = false;
while (Date.now() - t0 < 16500) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await page.evaluate(() => ({ st: window.__raim.state.mapping, info: document.getElementById('mapInfo').textContent, status: document.getElementById('status').textContent }));
  console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', s.info, '|', s.status);
  if (!shot && Date.now() - t0 > 7000) { shot = true; await page.screenshot({ path: 'test/e2e-map.png' }); }
}
await page.click('#mapDone');
await new Promise((r) => setTimeout(r, 2500));
const res = await page.evaluate(() => ({ r: window.__raim.state.lastMapResult, status: document.getElementById('status').textContent, st: window.__raim.state, car: JSON.parse(localStorage.getItem('raim-ar-marker-config-v1')).car }));
console.log('상태 문구:', res.status);
const m = res.r.markers, refId = m.find((q) => q.x === 0 && q.y === 0).id;
const ref = GT.find((g) => g.id === refId);
const toRef = (g) => { const a = (-ref.rot * Math.PI) / 180, dx = g.x - ref.x, dy = g.y - ref.y; return { x: Math.cos(a) * dx - Math.sin(a) * dy, y: Math.sin(a) * dx + Math.cos(a) * dy, rot: g.rot - ref.rot }; };
const e = m.map((q) => { const g = toRef(GT.find((z) => z.id === q.id)); return `${q.id}:${Math.hypot(q.x - g.x, q.y - g.y).toFixed(2)}cm/${(((((q.rot - g.rot) % 360) + 540) % 360) - 180).toFixed(1)}°`; });
console.log('기준', refId, '· 오차', e.join(' '), '· 재투영', res.r.errorPx.toFixed(2), 'px · 초점', res.r.focal.toFixed(0), '· 자동차 크기', JSON.stringify(res.car));
console.log('새 지도로 추적:', res.st.tracking, '· 보이는 도로 마커', res.st.roadCount);
await page.screenshot({ path: 'test/e2e-map-done.png' });
// 새 지도에서 경로 기록: 화면 가운데 근처 6곳 탭 → 저장 → 차가 다시 보이고 달리는지
const rect = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
for (const [u, v] of [[0.35, 0.45], [0.5, 0.4], [0.65, 0.45], [0.65, 0.6], [0.5, 0.65], [0.35, 0.6]]) {
  await page.mouse.click(rect.l + u * rect.w, rect.t + v * rect.h); await new Promise((r) => setTimeout(r, 60));
}
const nPts = await page.evaluate(() => window.__raim.state.recPts.length);
await page.click('#recDone');
await new Promise((r) => setTimeout(r, 1500));
const after = await page.evaluate(() => ({ stale: JSON.parse(localStorage.getItem('raim-ar-marker-config-v1')).pathStale, v: window.__raim.state.v, status: document.getElementById('status').textContent }));
console.log('경로 점', nPts, '개 기록 → 저장 후 pathStale', after.stale, '· 속도', after.v && after.v.toFixed(1), '· 상태', after.status);
console.log('errors:', errs);
await browser.close();
