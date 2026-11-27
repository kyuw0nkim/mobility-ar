// 한 바퀴 설치 시험 (가짜 ARCore, 전시 디오라마를 본뜬 가상 장면): [한 바퀴 설치] → 테이블 둘레를 걸으며 비춤(탭·카드 없음)
// → 마커 6개 저절로 등록 + 흰 중앙선 고리 찾기 → [완료·저장] → 정답(디오라마 좌표)과 비교 → 주행
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
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = ${HOLD};\n${mock}`);
await page.goto('http://localhost:8765/ar.html');
await page.evaluate(() => localStorage.clear()); // A4 시트 기본 지도에서 시작
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 10000 });
await page.click('#btnStart');
await page.waitForTimeout(500);
await page.click('#btnSetup');
const t0 = Date.now();
let st = null, lastLog = 0;
while (Date.now() - t0 < 90000) {
  st = await page.evaluate(() => ({ ...window.__raimAR.state, frame: window.__mockFrame, stat: document.getElementById('status').textContent }));
  if (Date.now() - lastLog > 6000) { lastLog = Date.now(); console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s · 장면 ${st.frame}/${meta.N} · ${st.stat}`); }
  if (st.setup && st.setup.loop && st.setup.loop.ok && st.mapping && st.mapping.confirmed.length >= 6 && st.frame >= meta.N - 3) break;
  await page.waitForTimeout(500);
}
const walked = (Date.now() - t0) / 1000;
console.log(`한 바퀴 걷기 ${walked.toFixed(0)}초 · 마커 등록 ${st.mapping ? st.mapping.confirmed.length : 0}개 · 고리 ${st.setup && st.setup.loop ? (st.setup.loop.ok ? '찾음' : '덜 찾음') : '없음'}`);
await page.screenshot({ path: new URL('./e2e-ar-setup.png', import.meta.url).pathname });
await page.click('#setupDone');
await page.waitForFunction(() => document.getElementById('setupBar').hidden, null, { timeout: 15000 }).catch(() => {});
const after = await page.evaluate(() => ({ ...window.__raimAR.state, status: document.getElementById('status').textContent }));
console.log('완료 후 안내:', after.status);
if (after.pathStale === false || after.path.length > 50) {
  const A = after.align;
  const toTrue = ([x, y]) => { const r = worldToRoad(TRUE, roadToWorld(A, [x, y, 0])); return [r[0], r[1]]; };
  const dense = smoothPath(after.path, true, 0.5).map(toTrue);
  const e = dense.map((p) => Math.abs(centerDist(p[0], p[1]))).sort((a, b) => a - b);
  const rms = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);
  console.log(`경로: 점 ${after.path.length}개 · 흰 중앙선에서 벗어남 평균제곱근 ${rms.toFixed(2)}cm · 95% ${e[Math.floor(e.length * 0.95)].toFixed(2)}cm · 최대 ${e[e.length - 1].toFixed(2)}cm`);
  const mErr = after.roadMarkers.map((m) => { const q = MARKERS.find((t) => t.id === m.id); const p = toTrue([m.x, m.y]); return Math.hypot(p[0] - q.x, p[1] - q.y); });
  console.log(`마커 ${after.roadMarkers.length}개 위치 오차 최대 ${Math.max(...mErr).toFixed(2)}cm`);
  const s0 = after.s; await page.waitForTimeout(1500);
  const s1 = (await page.evaluate(() => window.__raimAR.state)).s;
  console.log(`저장 후 주행 거리 증가 ${(s1 - s0).toFixed(2)}cm · 위치 맞춤 ${after.ready}`);
} else console.log('경로가 저장되지 않았어요');
// 다른 태블릿처럼: 저장된 지도·경로로 새로 AR 시작 → 마커로 위치 맞춤 → 그 정렬로 본 경로가 실제 중앙선 위인지
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 10000 });
await page.click('#btnStart');
const t1 = Date.now();
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000); // 마커를 더 보며 위치가 다듬어짐
const re = await page.evaluate(() => window.__raimAR.state);
if (re.ready) {
  const toTrue = ([x, y]) => { const r = worldToRoad(TRUE, roadToWorld(re.align, [x, y, 0])); return [r[0], r[1]]; };
  const e = smoothPath(re.path, true, 0.5).map(toTrue).map((p) => Math.abs(centerDist(p[0], p[1]))).sort((a, b) => a - b);
  const rms = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);
  console.log(`다른 태블릿: 마커로 위치 맞춤 ${((Date.now() - t1) / 1000).toFixed(1)}초 · 그 위치로 본 경로가 흰 중앙선에서 벗어남 평균제곱근 ${rms.toFixed(2)}cm · 최대 ${e[e.length - 1].toFixed(2)}cm`);
} else console.log('다른 태블릿: 위치 맞춤 실패');
console.log('errors:', errs);
await browser.close();
