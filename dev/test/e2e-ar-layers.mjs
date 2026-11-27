// WebXR 층(layers)을 지원하는 Chrome + CPU 방식 깊이 인식에서 AR이 멈추지 않는지 (가짜 ARCore, 전시 디오라마)
//  three.js(r170)는 binding이 있으면 매 프레임 GPU 방식 깊이를 읽어 오류를 내고, 프레임 오류가 나면 다음 프레임을 요청하지 않아 화면이 멈췄다
//  - 깊이를 켠 가벼운 모드 / 가벼운 모드 끔 모두: 5초 동안 프레임이 계속 오고 차가 달림, 프레임 오류 0
//  - 일부러 프레임 오류를 내도 다음 프레임이 이어지고 '지난 AR'에 오류가 남음
// 먼저: node test/xr-mock/make-frames-dio.mjs && node test/xr-mock/make-depth-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const lite of ['1', '0']) {
  console.log(`[WebXR 층 + CPU 깊이 · 가벼운 모드 ${lite === '1' ? '켬(가림 켬)' : '끔'}]`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__mockDepth = 1; window.__mockLayers = 1; window.__raimAutoAdmin = '4300';\n${mock}`);
  await page.goto(`http://localhost:8765/ar.html?lite=${lite}`);
  await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); localStorage.setItem('raim-ar-lite-depth', '1'); }, { markers: MARKERS, path: truthLoop(4) });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  const ready = await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 }).then(() => true, () => false);
  ok(ready, '위치 맞춤 (프레임이 계속 옴)');
  const a = await page.evaluate(() => ({ s: window.__raimAR.state.s, n: window.__raimAR.detections(), f: window.__mockFrame }));
  await page.waitForTimeout(4000);
  let s = await page.evaluate(() => window.__raimAR.state);
  const n = await page.evaluate(() => window.__raimAR.detections());
  ok(s.s > a.s + 1 && n > a.n, `4초 동안 차가 달림 (${(s.s - a.s).toFixed(1)}cm) · 인식 ${n - a.n}번`);
  ok(s.occlusionStatus === 'on', `가림 ${s.occlusionStatus}`);
  ok(s.frameErrors === 0, `프레임 오류 ${s.frameErrors}번`);
  // 일부러 프레임 오류: 한 프레임에서 예외
  await page.evaluate(() => window.__raimAR.injectFrameError());
  const s0 = (await page.evaluate(() => window.__raimAR.state)).s;
  await page.waitForTimeout(1500);
  s = await page.evaluate(() => window.__raimAR.state);
  ok(s.frameErrors === 1 && s.s > s0 + 0.5, `프레임 오류 1번 뒤에도 계속 달림 (${(s.s - s0).toFixed(1)}cm)`);
  await page.click('#btnExit');
  await page.waitForFunction(() => !document.getElementById('start').hidden);
  const lr = await page.textContent('#lastRun');
  ok(lr.includes('시험 오류') && lr.includes('깊이 cpu-optimized') && lr.includes('WebXR 층 있음'), `지난 AR: …${lr.slice(lr.indexOf('오류'), lr.indexOf('오류') + 90)}`);
  ok(!errs.length, `페이지 오류 없음 ${errs.join(' / ')}`);
  await page.close();
}
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
