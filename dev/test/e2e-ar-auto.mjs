// AR 자동 경로 시험 (가짜 ARCore, A4 시트): 경로 기록 → 비추기 → 두 번 탭 → [자동 경로] → 한 바퀴 → 저장 → 주행
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { ROAD } from '../src/config.js';
import { smoothPath } from '../src/logic.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta.json', import.meta.url)));
const TRUE = meta.TRUE;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockFlip = false;\n${mock}`);
await page.goto('http://localhost:8765/index.html?lite=0');
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('raim-ar-aim', '0'); }); // 손가락 탭 흉내 (조준점 끔)
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 5000 });
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 20000 });
await page.click('#btnRecord');
await page.waitForTimeout(3000); // 비추기 (가짜 카메라가 시트 위를 움직임)
console.log('스캔 범위:', (await page.evaluate(() => window.__raimAR.state)).scan + '%', '· 안내:', await page.textContent('#status'));
// 도로 아래쪽 직선에서 두 번 탭 (오른쪽으로)
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
await tap(12, ROAD.y0 + 0.3); await page.waitForTimeout(80);
await tap(15, ROAD.y0 - 0.2); await page.waitForTimeout(80);
await page.click('#recAuto');
await page.waitForTimeout(300);
const st = await page.evaluate(() => window.__raimAR.state);
console.log('자동 경로:', st.lastSnap.ok ? `한 바퀴 닫힘 · 길이 ${st.lastSnap.length.toFixed(1)}cm · 차선 폭 ${st.lastSnap.laneWidth.toFixed(2)}cm` : `실패 ${st.lastSnap.reason}`, '· 안내:', await page.textContent('#status'));
if (st.snapped) {
  const sd = (x, y) => {
    const cx = (ROAD.x0 + ROAD.x1) / 2, cy = (ROAD.y0 + ROAD.y1) / 2, hx = (ROAD.x1 - ROAD.x0) / 2 - ROAD.r, hy = (ROAD.y1 - ROAD.y0) / 2 - ROAD.r;
    const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - ROAD.r;
  };
  const d = smoothPath(st.snapped, true, 0.2).map((p) => sd(p[0], p[1]));
  const trueLen = 2 * (ROAD.x1 - ROAD.x0 + ROAD.y1 - ROAD.y0) - 8 * ROAD.r + 2 * Math.PI * ROAD.r;
  console.log(`  도로 가운데에서 벗어남: 평균 ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2)}cm, 범위 ${Math.min(...d).toFixed(2)}~${Math.max(...d).toFixed(2)}cm · 정답 길이 ${trueLen.toFixed(1)}cm (A4 시트는 가운데 점선이 너무 가늘어 도로 전체를 한 차선으로 봄)`);
}
await page.click('#recDone');
const s0 = (await page.evaluate(() => window.__raimAR.state)).s;
await page.waitForTimeout(1200);
const s1 = await page.evaluate(() => window.__raimAR.state);
console.log('저장 → 경로 점', s1.path.length, '개 · 주행 거리 증가', (s1.s - s0).toFixed(2), 'cm');
console.log('errors:', errs);
await browser.close();
