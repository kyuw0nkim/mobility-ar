// [시작하기]를 눌러도 AR이 안 열리던 경우 시험 (가짜 ARCore, 전시 디오라마, 관람 모드)
//  - 누르면 버튼이 'AR 시작 중…'으로 바뀌고 두 번 눌러도 요청은 한 번
//  - AR을 끝낸 직후엔 '잠시만요…'(ARCore 정리 시간), 그 뒤 다시 시작 가능 — 정리 중 요청이 거절되는 기기 흉내에서도 됨
//  - 요청이 거절되면 안내가 나오고 버튼이 다시 눌림
//  - 요청이 응답 없이 멈추면 시간이 지나 안내 + 버튼 다시 눌림, 늦게 열린 세션은 바로 닫힘
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__raimStartTimeout = 3000;\n${mock}`);
await page.goto('http://localhost:8765/index.html?lite=1');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
const btn = () => page.evaluate(() => ({ text: document.getElementById('btnStart').textContent, disabled: document.getElementById('btnStart').disabled, msg: document.getElementById('startMsg').textContent, inAR: document.getElementById('start').hidden }));
const waitIdle = () => page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 20000 });
const exit = async () => { await page.click('#btnExit'); await page.waitForFunction(() => !document.getElementById('start').hidden); };
await waitIdle();

console.log('[보통 시작 · 두 번 눌러도 한 번]');
await page.evaluate(() => { window.__mockReqCount = 0; window.__mockStart = { hangOnce: true, hangMs: 800 }; });
await page.evaluate(() => { const b = document.getElementById('btnStart'); b.click(); b.click(); });
let b = await btn();
ok(b.text === 'AR 시작 중…' && b.disabled, `누르자마자 '${b.text}'`);
await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 10000 });
ok((await page.evaluate(() => window.__mockReqCount)) === 1, `세션 요청 ${await page.evaluate(() => window.__mockReqCount)}번`);
await page.waitForTimeout(500);

console.log('[끝낸 직후 · ARCore 정리 중(1초)엔 요청 거절되는 기기]');
await page.evaluate(() => { window.__mockStart = { busyMs: 1000 }; });
await exit();
b = await btn();
ok(b.text === '잠시만요…' && b.disabled, `끝낸 직후 '${b.text}'`);
await waitIdle();
b = await btn();
ok(b.text === '시작하기', `조금 뒤 '${b.text}'`);
await page.click('#btnStart');
await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 10000 }).catch(() => {});
b = await btn();
ok(b.inAR, `다시 시작 됨 ${b.msg}`);
await page.waitForTimeout(400);
await exit();
await waitIdle();

console.log('[요청 거절]');
await page.evaluate(() => { window.__mockStart = { rejectOnce: 'InvalidStateError' }; });
await page.click('#btnStart');
await waitIdle();
b = await btn();
ok(!b.inAR && b.text === '시작하기' && b.msg.includes('잠시 뒤 다시'), `안내: ${b.msg}`);
await page.click('#btnStart');
await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 10000 });
ok(true, '다시 누르면 시작');
await page.waitForTimeout(400);
await exit();
await waitIdle();

console.log('[응답 없음 → 늦게 열림]');
await page.evaluate(() => { window.__mockStart = { hangOnce: true, hangMs: 4500 }; });
await page.click('#btnStart');
await page.waitForTimeout(3300);
b = await btn();
ok(!b.inAR && !b.disabled && b.msg.includes('열리지 않아요'), `3초 뒤 안내: ${b.msg}`);
await page.waitForTimeout(1800); // 늦게 열린 세션
const late = await page.evaluate(() => ({ ended: window.__mockSession && window.__mockSession.ended, inAR: document.getElementById('start').hidden }));
ok(late.ended && !late.inAR, '늦게 열린 세션은 바로 닫힘');
await page.click('#btnStart');
await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 10000 });
ok(true, '다시 누르면 시작');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 });
ok(true, '위치 맞춤까지 됨');
await exit();
await waitIdle();
const lr = await page.evaluate(() => document.getElementById('lastRun').textContent);
ok(lr.includes('마지막 시작') && lr.includes('세션 열림'), `기록: …${lr.slice(lr.indexOf('마지막 시작'))}`);
ok(!errs.length, `페이지 오류 없음 ${errs.join(' / ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
