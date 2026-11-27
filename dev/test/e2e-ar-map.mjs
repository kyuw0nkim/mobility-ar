// AR 지도 만들기 시험 (가짜 ARCore, A4 시트 마커 6개·3cm): 지도 만들기 → 실제 배치와 비교 → 자동 경로 → 저장 → 주행
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { roadToWorld, worldToRoad, CM } from '../src/xr-align.js';
import { DEFAULT_CONFIG, ROAD } from '../src/config.js';
import { smoothPath } from '../src/logic.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const TRUE = JSON.parse(readFileSync(new URL('./xr-mock/meta.json', import.meta.url))).TRUE;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(mock);
await page.goto('http://localhost:8765/ar.html');
// 일부러 엉뚱한 지도(디오라마 마커 번호 30·31)로 시작: 지도 없이도 [지도 만들기]가 되는지
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('raim-ar-aim', '0'); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: [{ id: 30, x: 0, y: 0, size: 8, rot: 0 }, { id: 31, x: 100, y: 0, size: 8, rot: 0 }] })); });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForTimeout(800);
await page.click('#btnMapAR');
await page.fill('#arMapSize', '3');
await page.click('#mapReset'); // 크기 반영해 다시 시작
const t0 = Date.now();
await page.waitForFunction(() => { const m = window.__raimAR.state.mapping; return m && m.confirmed.length >= 6; }, null, { timeout: 20000 }).catch(() => {});
console.log(`등록까지 ${((Date.now() - t0) / 1000).toFixed(1)}초 · 상태: ${await page.textContent('#mapStat')}`);
await page.screenshot({ path: new URL('./e2e-ar-map.png', import.meta.url).pathname });
await page.click('#mapDone');
await page.waitForTimeout(300);
const st = await page.evaluate(() => window.__raimAR.state);
const res = st.lastMapResult;
console.log(`지도: 마커 ${res.markers.length}개 · 추정 오차 ${res.estErrCm.toFixed(2)}cm · 높이 차 ${res.heightSpreadCm.toFixed(2)}cm · 바로 위치 맞춤 ${st.ready} · 경로 기록 화면 ${await page.isVisible('#recordBar')}`);
// 실제 배치와 비교: 지도 좌표 → 세계(지도 정렬) → 참 도로 좌표
const truthById = new Map(DEFAULT_CONFIG.roadMarkers.map((m) => [m.id, m]));
let worst = 0, worstRot = 0;
const rot0 = res.markers[0].rot;
for (const m of res.markers) {
  const w = roadToWorld(res.align, [m.x, m.y, 0]);
  const r = worldToRoad(TRUE, w);
  const tm = truthById.get(m.id);
  const e = Math.hypot(r[0] - tm.x, r[1] - tm.y);
  // 방향: 지도 정렬의 yaw 차이만큼 돌려 참 좌표계 rot와 비교
  const dyaw = ((res.align.yaw - TRUE.yaw) * 180) / Math.PI;
  let dr = m.rot + dyaw - tm.rot; dr = ((dr + 540) % 360) - 180;
  worst = Math.max(worst, e); worstRot = Math.max(worstRot, Math.abs(dr));
}
console.log(`마커 위치 오차 최대 ${worst.toFixed(2)}cm · 방향 오차 최대 ${worstRot.toFixed(2)}° (6개)`);
// 새 지도로 자동 경로
await page.waitForTimeout(2500);
const tap = (x, y) => page.evaluate(({ x, y, TRUE }) => {
  const v = window.__lastViewMatrix, o = [v[12], v[13], v[14]];
  const c = Math.cos(TRUE.yaw), sn = Math.sin(TRUE.yaw);
  const w = [TRUE.p[0] + (c * x - sn * y) * 0.01, TRUE.p[1], TRUE.p[2] + (-sn * x - c * y) * 0.01];
  const d = [w[0] - o[0], w[1] - o[1], w[2] - o[2]]; const L = Math.hypot(...d); const z = d.map((q) => -q / L);
  let xa = [z[2], 0, -z[0]]; const xl = Math.hypot(...xa); xa = xa.map((q) => q / xl);
  const ya = [z[1] * xa[2] - z[2] * xa[1], z[2] * xa[0] - z[0] * xa[2], z[0] * xa[1] - z[1] * xa[0]];
  const ev = new Event('select');
  ev.inputSource = { targetRaySpace: { matrix: new Float32Array([...xa, 0, ...ya, 0, ...z, 0, ...o, 1]) } };
  ev.frame = { getPose: (s) => ({ transform: { matrix: s.matrix } }) };
  window.__mockSession.dispatchEvent(ev);
}, { x, y, TRUE });
await tap(12, ROAD.y0); await page.waitForTimeout(80);
await tap(15, ROAD.y0); await page.waitForTimeout(80);
await page.click('#recAuto'); await page.waitForTimeout(300);
const s2 = await page.evaluate(() => window.__raimAR.state);
if (s2.snapped) {
  const sd = (x, y) => { const cx = (ROAD.x0 + ROAD.x1) / 2, cy = (ROAD.y0 + ROAD.y1) / 2, hx = (ROAD.x1 - ROAD.x0) / 2 - ROAD.r, hy = (ROAD.y1 - ROAD.y0) / 2 - ROAD.r; const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - ROAD.r; };
  const d = smoothPath(s2.snapped, true, 0.2).map((p) => { const r = worldToRoad(TRUE, roadToWorld(s2.align, [p[0], p[1], 0])); return sd(r[0], r[1]); });
  console.log(`새 지도로 자동 경로: 한 바퀴 · 실제 도로 가운데에서 범위 ${Math.min(...d).toFixed(2)}~${Math.max(...d).toFixed(2)}cm`);
} else console.log('자동 경로 실패:', s2.lastSnap && s2.lastSnap.reason);
await page.click('#recDone');
const a = (await page.evaluate(() => window.__raimAR.state)).s; await page.waitForTimeout(1000);
console.log('저장 후 주행 거리 증가', ((await page.evaluate(() => window.__raimAR.state)).s - a).toFixed(2), 'cm · errors:', errs);
await browser.close();
