// 가림 처리 시험 (가짜 ARCore + 깊이 인식, 전시 디오라마 장면)
//  A. 일부러 만든 깊이로 방향·동작 확인: 모두 멀리 → 차·경로 보임 / 모두 가까이 → 안 보임 / 위쪽 절반만 가까이 → 위쪽만 안 보임 /
//     깊이 모름(0) → 보임 / [가림 끔]이면 가까워도 보임
//  B. 장면의 실제 깊이(돔·탑·건물·게이트)로 주행하며 가림 켬·끔 그림 비교 (test/occl-*.png)
// 먼저: node test/xr-mock/make-frames-dio.mjs && node test/xr-mock/make-depth-dio.mjs && node build.mjs,
//       test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const out = process.argv[2] || new URL('.', import.meta.url).pathname;
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript("window.__raimAutoAdmin = '4300';");
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 4; window.__mockDepth = true;\n${mock}`);
await page.goto('http://localhost:8765/ar.html');
await page.evaluate(({ markers, path }) => {
  localStorage.clear();
  localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false, car: { scale: 3 }, drive: { speedScale: 0.0001 } }));
}, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 });
// 측정: 0.8초 동안 AR 층의 [위, 아래] 픽셀 수 평균
const measure = async (fn) => {
  await page.evaluate((src) => { window.__mockDepthFn = src === null ? null : new Function('nx', 'ny', src); }, fn);
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__coverageTB = []; });
  await page.waitForTimeout(800);
  const tb = await page.evaluate(() => window.__coverageTB);
  const avg = (k) => tb.reduce((s, v) => s + v[k], 0) / Math.max(1, tb.length);
  return [avg(0), avg(1)];
};
console.log('[A. 일부러 만든 깊이]');
const far = await measure('return 10;');
console.log(`  모두 10m: 위 ${far[0].toFixed(0)} · 아래 ${far[1].toFixed(0)}`);
ok(far[0] + far[1] > 100, '모두 멀리: 차·경로가 보임');
const near = await measure('return 0.12;');
ok(near[0] + near[1] < (far[0] + far[1]) * 0.02, `모두 12cm: 거의 안 보임 (${(near[0] + near[1]).toFixed(0)})`);
const half = await measure('return ny < 0.5 ? 0.12 : 10;');
ok(half[0] < far[0] * 0.05 + 1 && half[1] > far[1] * 0.7, `위쪽 절반만 가까이: 위 ${half[0].toFixed(0)}(가려짐) · 아래 ${half[1].toFixed(0)}(보임)`);
const unknown = await measure('return 0;');
ok(unknown[0] + unknown[1] > (far[0] + far[1]) * 0.7, '깊이 모름(0): 가리지 않음');
await page.click('#btnOcclusion');
const off = await measure('return 0.12;');
ok(off[0] + off[1] > (far[0] + far[1]) * 0.7, '[가림 끔]이면 가까워도 보임');
await page.click('#btnOcclusion');
console.log('  상단 글:', await page.textContent('#debug'));
console.log('[B. 장면의 실제 깊이: 건물·게이트 뒤로 지나갈 때]');
await page.evaluate(() => { window.__mockDepthFn = null; });
// 장면(카메라 자리)과 차 자리를 골라 가며 가림 켬·끔의 AR 층 픽셀 수를 비교 (차는 멈춘 채)
const L = await page.evaluate(() => window.__raimAR.pathLength());
const sweep = async (frames, steps) => {
  const rows = [];
  for (const occl of [true, false]) {
    const cur = await page.evaluate(() => window.__raimAR.state.occlusion);
    if (cur !== occl) await page.click('#btnOcclusion');
    for (const f of frames) {
      await page.evaluate((f) => { window.__mockForceFrame = f; }, f);
      for (let k = 0; k < steps; k++) {
        await page.evaluate((s) => window.__raimAR.setCarS(s), (k / steps) * L);
        await page.waitForTimeout(110);
        const cov = await page.evaluate(() => window.__coverage.at(-1));
        rows.push({ f, k, occl, cov });
      }
    }
  }
  return rows;
};
const frames = [10, 40, 70, 80, 90, 120, 150, 170];
const STEPS = 24;
const rows = await sweep(frames, STEPS);
const diffs = [];
for (const r of rows.filter((q) => q.occl)) {
  const o = rows.find((q) => !q.occl && q.f === r.f && q.k === r.k);
  diffs.push({ f: r.f, k: r.k, on: r.cov, off: o.cov, d: o.cov - r.cov });
}
diffs.sort((a, b) => b.d - a.d);
const hidden = diffs.filter((d) => d.d > 150);
const falseHide = diffs.filter((d) => d.d > 0 && d.d <= 150).length;
console.log(`  장면 ${frames.length}곳 × 차 자리 ${STEPS}곳: 가림으로 눈에 띄게 가려진 경우 ${hidden.length}번, 조금(150픽셀 이하) 줄어든 경우 ${falseHide}번`);
ok(hidden.length > 0, '건물·게이트 뒤에서 차(또는 경로)가 가려지는 경우가 있음');
// 가장 많이 가려진 세 경우를 그림으로 (가림 켬 / 끔)
const b64 = (d) => Buffer.from(d.split(',')[1], 'base64');
for (const [n, h] of hidden.slice(0, 3).entries()) {
  await page.evaluate((f) => { window.__mockForceFrame = f; }, h.f);
  await page.evaluate((s) => window.__raimAR.setCarS(s), (h.k / STEPS) * L);
  for (const occl of [true, false]) {
    const cur = await page.evaluate(() => window.__raimAR.state.occlusion);
    if (cur !== occl) await page.click('#btnOcclusion');
    await page.waitForTimeout(200);
    writeFileSync(`${out}/occl-${n}-${occl ? 'on' : 'off'}.png`, b64(await page.evaluate(() => window.__mockSnapshot())));
  }
  console.log(`  occl-${n}: 장면 ${h.f}, 차 자리 ${h.k}/${STEPS} · AR 픽셀 가림 켬 ${h.on} / 끔 ${h.off}`);
}
ok(!errs.length, `오류 없음 ${errs.join(' | ')}`);
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exitCode = fails ? 1 : 0;
await browser.close();
