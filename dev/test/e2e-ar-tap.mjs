// 조준점 탭 시험 (가짜 ARCore, 전시 디오라마를 본뜬 가상 장면): 저장된 지도로 위치 맞춤 → [경로 기록] →
// 걸으며 조준점(화면 가운데)이 가리키는 곳을 탭(중앙선에서 0~11cm 빗나가게) → 탭마다 중앙선에 붙임 → [중앙선 맞추기] → 저장 → 정답과 비교
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { roadToWorld, worldToRoad } from '../src/xr-align.js';
import { smoothPath } from '../src/logic.js';
import { centerDist, MARKERS } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta-dio.json', import.meta.url)));
const TRUE = meta.TRUE, HOLD = 6;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } }); // 태블릿 가로
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = ${HOLD};\n${mock}`);
await page.goto('http://localhost:8765/ar.html');
// 지도는 정답 마커 배치 그대로 (한 바퀴 설치나 지도 만들기를 마친 상태)
await page.evaluate((markers) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, pathStale: true })); }, MARKERS);
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 10000 });
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 });
await page.click('#btnRecord');
console.log('조준점:', (await page.evaluate(() => window.__raimAR.state.aimOn)) ? '켬' : '끔', '· 보임:', await page.isVisible('#aim'));
// 한 바퀴 걸으며 장면이 바뀔 때마다 탭 (조준점이 가리키는 곳 = 걷는 사람이 보는 곳, 중앙선에서 빗나감)
const f0 = await page.evaluate(() => window.__mockFrame);
let last = -1, taps = 0;
const tapsTrue = [];
while (true) {
  const f = await page.evaluate(() => window.__mockFrame);
  const walked = (f - f0 + meta.N) % meta.N;
  if (taps > 10 && walked > meta.N - 4) break;
  if (f !== last && f % 4 === 0) {
    last = f;
    await page.evaluate(() => { const ev = new Event('select'); ev.inputSource = {}; ev.frame = {}; window.__mockSession.dispatchEvent(ev); });
    taps++;
  }
  await page.waitForTimeout(60);
}
await page.waitForTimeout(800); // 마지막 탭 붙이기 결과
let st = await page.evaluate(() => window.__raimAR.state);
const A = st.align;
const toTrue = ([x, y]) => { const r = worldToRoad(TRUE, roadToWorld(A, [x, y, 0])); return [r[0], r[1]]; };
const rawNow = st.recPts.map(toTrue);
const d = rawNow.map((p) => Math.abs(centerDist(p[0], p[1])));
const okIdx = st.recFlags.map((f, i) => [f, i]).filter(([f]) => f === 'ok').map(([, i]) => i);
console.log('틀린 점(정답 좌표):', rawNow.map((p, i) => [p, d[i], st.recFlags[i], i]).filter((r) => r[1] > 2).map(([p, dd, f, i]) => `#${i} (${p[0].toFixed(0)},${p[1].toFixed(0)}) ${dd.toFixed(1)}cm ${f}`).join(' / '));
console.log(`탭 ${st.recPts.length}개 · 중앙선에 붙음 ${okIdx.length}개 · 붙은 점의 중앙선 거리 최대 ${Math.max(0, ...okIdx.map((i) => d[i])).toFixed(2)}cm · 못 붙은 점 거리 ${st.recFlags.map((f, i) => [f, i]).filter(([f]) => f !== 'ok').map(([, i]) => d[i].toFixed(1)).join(', ') || '-'}cm`);
await page.click('#recSnap');
await page.waitForFunction(() => window.__raimAR.state.snapped, null, { timeout: 10000 }).catch(() => {});
st = await page.evaluate(() => ({ ...window.__raimAR.state, status: document.getElementById('status').textContent }));
console.log('중앙선 맞추기:', st.status);
await page.screenshot({ path: new URL('./e2e-ar-tap.png', import.meta.url).pathname });
await page.click('#recDone');
await page.waitForTimeout(500);
st = await page.evaluate(() => window.__raimAR.state);
const e = smoothPath(st.path, true, 0.5).map(toTrue).map((p) => Math.abs(centerDist(p[0], p[1]))).sort((a, b) => a - b);
console.log(`저장된 경로: 흰 중앙선에서 벗어남 평균제곱근 ${Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length).toFixed(2)}cm · 95% ${e[Math.floor(e.length * 0.95)].toFixed(2)}cm · 최대 ${e[e.length - 1].toFixed(2)}cm`);
const s0 = st.s; await page.waitForTimeout(1000);
console.log(`주행 거리 증가 ${((await page.evaluate(() => window.__raimAR.state.s)) - s0).toFixed(2)}cm · errors:`, errs);
await browser.close();
