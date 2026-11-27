// AR 가벼운 모드 + 지난 AR 기록 시험 (가짜 ARCore, 전시 디오라마)
//  - 기본은 가벼운 모드: 안티에일리어싱 끔, 해상도 0.5배, 깊이 인식 요청 안 함, 인식 초당 약 3번, 차 재질 Lambert
//  - 가벼운 모드에서도 위치 맞춤 → 차가 달림
//  - 지난 AR 기록: 정상 종료 / AR 도중 페이지가 멈추거나 닫히면 '끝내기 전에 멈춤'과 어디까지 갔는지
//  - [가벼운 모드] 버튼으로 끄면 원래 설정 (해상도 0.75배, 깊이 요청)
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__mockDepth = 'dio'; window.__raimAutoAdmin = '4300';\n${mock}`);
await page.goto('http://localhost:8765/index.html');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
const st = () => page.evaluate(() => window.__raimAR.state);
const start = async () => {
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 });
};
console.log('[가벼운 모드 (기본)]');
ok((await page.textContent('#btnLite')) === '가벼운 모드 켬', '시작 화면 버튼: 가벼운 모드 켬');
const t0 = Date.now();
await start();
console.log(`  위치 맞춤 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
let s = await st();
ok(s.lite && !s.antialias && s.fbScale === 0.5, `가벼운 모드 · 안티에일리어싱 끔 · 해상도 ×${s.fbScale}`);
ok(s.occlusionStatus === 'unsupported' && !s.depthRequested, `깊이 인식 요청 안 함 (가림 상태 ${s.occlusionStatus})`);
const mats = await page.evaluate(() => window.__raimAR.carMaterials());
ok(mats.length && !mats.includes('MeshStandardMaterial'), `차 재질 단순화 (${[...new Set(mats)].join(', ')})`);
const s0 = s.s;
await page.waitForTimeout(2500);
s = await st();
ok(s.s > s0 + 1, `차가 달림 (${(s.s - s0).toFixed(1)}cm)`);
const n0 = await page.evaluate(() => window.__raimAR.detections());
await page.waitForTimeout(3000);
const rate = ((await page.evaluate(() => window.__raimAR.detections())) - n0) / 3;
ok(rate > 2 && rate < 4, `인식 초당 ${rate.toFixed(1)}번 (가벼운 모드 3번)`);
await page.click('#btnExit');
await page.waitForFunction(() => !document.getElementById('start').hidden);
let lr = await page.innerHTML('#lastRun');
ok(lr.includes('정상 종료') && lr.includes('위치 맞춤') && lr.includes('가벼운 모드'), `지난 AR: ${(await page.textContent('#lastRun')).slice(0, 120)}…`);

console.log('[AR 도중 멈춤(페이지가 닫힘)]');
await start();
await page.waitForTimeout(2200);
await page.reload(); // 멈춰서 강제로 닫은 것과 같음 (끝내기 없이)
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
lr = await page.textContent('#lastRun');
ok(lr.includes('끝내기 전에 멈춤') && lr.includes('카메라 영상') && lr.includes('첫 인식'), `지난 AR: ${lr.slice(0, 160)}…`);
ok(/\d+초: \d+fps/.test(lr), '마지막 몇 초의 프레임 상태가 남음');

console.log('[가벼운 모드 + 가림만 켬]');
ok(await page.isVisible('#btnLiteDepth') && (await page.textContent('#btnLiteDepth')) === '가벼운 모드 가림 끔', '가림 버튼 (기본 끔)');
await page.click('#btnLiteDepth');
ok((await page.textContent('#btnLiteDepth')) === '가벼운 모드 가림 켬', '누르면 켬');
await start();
await page.waitForTimeout(800);
s = await st();
ok(s.lite && s.fbScale === 0.5 && s.depthRequested && s.occlusionStatus === 'on', `가벼운 모드 그대로 · 깊이 인식 · 가림 ${s.occlusionStatus}`);
await page.click('#btnExit');
await page.waitForFunction(() => !document.getElementById('start').hidden);
lr = await page.textContent('#lastRun');
ok(lr.includes('깊이 인식'), '지난 AR 기록에 깊이 인식 단계');
console.log('[가벼운 모드 끔]');
await page.click('#btnLite');
await page.waitForFunction(() => document.getElementById('btnLite') && document.getElementById('btnLite').textContent === '가벼운 모드 끔');
await start();
await page.waitForTimeout(800);
s = await st();
ok(!s.lite && s.antialias && s.fbScale === 0.75, `원래 설정 · 해상도 ×${s.fbScale}`);
ok(s.occlusionStatus === 'on', `깊이 인식 · 가림 ${s.occlusionStatus}`);
ok(!errs.length, `페이지 오류 없음 ${errs.join(' / ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
