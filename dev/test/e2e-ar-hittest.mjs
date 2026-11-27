// AR 버전 가벼움 설정 시험 (가짜 ARCore, 전시 디오라마)
//  - 바닥 찾기(hit-test)는 처음엔 꺼져 있고, [높이 자동]을 누른 3초 동안만 켜졌다가 다시 꺼짐
//  - AR 화면 해상도 0.75배, AR 중 body.in-ar, 끊김 측정
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
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__raimAutoAdmin = '4300';\n${mock}`);
await page.goto('http://localhost:8765/ar.html?lite=0');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 });
await page.waitForTimeout(600);
const st = () => page.evaluate(() => window.__raimAR.state);
let s = await st();
ok(!s.hitTest, '처음엔 바닥 찾기(hit-test) 꺼짐');
ok(s.fbScale === 0.75, `AR 화면 해상도 ×${s.fbScale}`);
ok(await page.evaluate(() => document.body.classList.contains('in-ar')), 'AR 중 body.in-ar (가벼운 화면 위 층)');
await page.evaluate(() => document.getElementById('btnHeightAuto').click());
await page.waitForTimeout(500);
ok((await st()).hitTest, '[높이 자동] 누르면 켜짐');
await page.waitForTimeout(3200);
ok(!(await st()).hitTest, '3초 잰 뒤 다시 꺼짐');
ok((await page.textContent('#status')).includes('도로 면'), `안내: ${await page.textContent('#status')}`);
s = await st();
ok(s.perf && s.perf.fps > 0, `끊김 측정 ${JSON.stringify(s.perf)}`);
ok((await page.textContent('#debug')).includes('끊김'), '디버그 줄에 끊김 표시');
ok(!errs.length, `페이지 오류 없음 ${errs.join(' / ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
