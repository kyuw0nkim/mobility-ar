// 관람 모드 / 관리자 모드 시험 (가짜 ARCore, 전시 디오라마 장면, 태블릿 가로 1280x800)
//  - 처음엔 관람 모드: 관리자 버튼·전시 설정·디버그 줄이 안 보임
//  - 설정(⚙) → 틀린 암호는 거부, 4300이면 관리자 모드 → 관람 모드로 돌아가기
//  - 관람 모드로 AR: 정해진 경로로 차가 달리고 관람객 안내 문구, AR 안에서도 ⚙ → 4300 → 관리자 버튼
//  - 관리자 모드에서 경로 기록 중 관람 모드로 바꾸면 기록이 취소됨
// 화면 사진: test/ui-*.png (또는 인자로 준 폴더)
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const out = process.argv[2] || new URL('.', import.meta.url).pathname;
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3;\n${mock}`);
await page.goto('http://localhost:8765/ar.html');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.waitForTimeout(400);
const isAdmin = () => page.evaluate(() => document.body.classList.contains('admin'));
const pin = async (digits) => { for (const k of digits) await page.click(`.keypad button[data-k="${k}"]`); };
console.log('[시작 화면]');
ok(!(await isAdmin()) && !(await page.isVisible('#adminStart')) && !(await page.isVisible('#btnExport')), '처음엔 관람 모드 (전시 설정 버튼 숨김)');
await page.screenshot({ path: `${out}/ui-1-start.png` });
await page.click('#btnGear');
await pin('12');
await page.screenshot({ path: `${out}/ui-2-pin.png` });
await pin('34');
await page.waitForTimeout(100);
ok(!(await isAdmin()) && (await page.textContent('.pin-msg')).includes('맞지 않아요'), '틀린 암호(1234)는 거부');
await page.waitForTimeout(500);
await pin('4300');
ok(await isAdmin() && await page.isVisible('#btnExport'), '4300 → 관리자 모드 (전시 설정 버튼 보임)');
await page.screenshot({ path: `${out}/ui-3-admin-start.png` });
await page.click('#btnLeaveAdmin');
ok(!(await isAdmin()), '[관람 모드로] → 관람 모드');
console.log('[AR · 관람 모드]');
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 });
const s0 = (await page.evaluate(() => window.__raimAR.state)).s;
await page.waitForTimeout(1500);
const st = await page.evaluate(() => window.__raimAR.state);
await page.screenshot({ path: `${out}/ui-4-ar-visitor.png` });
ok(st.s !== s0, `차가 정해진 경로로 달림 (${(st.s - s0).toFixed(1)}cm)`);
ok(!(await page.isVisible('#mainButtons')) && !(await page.isVisible('#debug')), '관리자 버튼·디버그 줄 숨김');
ok((await page.textContent('#status')).includes('자율주행차가 달리고 있어요'), `관람객 안내: "${await page.textContent('#status')}"`);
console.log('[AR · 관리자 모드]');
await page.click('#btnGearAR');
await pin('4300');
await page.waitForTimeout(600);
ok(await page.isVisible('#mainButtons'), 'AR 안에서 ⚙ → 4300 → 관리자 버튼 보임');
await page.screenshot({ path: `${out}/ui-5-ar-admin.png` });
await page.click('#btnRecord');
ok(await page.isVisible('#recordBar'), '경로 기록 화면');
await page.click('#btnGearAR'); // 관리자 모드에서 ⚙ = 관람 모드로
await page.waitForTimeout(200);
const after = await page.evaluate(() => ({ admin: document.body.classList.contains('admin'), rec: !document.getElementById('recordBar').hidden }));
ok(!after.admin && !after.rec && !(await page.isVisible('#mainButtons')), '관람 모드로 바꾸면 경로 기록 취소, 관리자 버튼 숨김');
ok(!errs.length, `오류 없음 ${errs.join(' | ')}`);
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exitCode = fails ? 1 : 0;
await browser.close();
