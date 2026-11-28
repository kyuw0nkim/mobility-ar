// 전시 설정 공유: 사이트의 diorama.json 자동 불러오기 · 로컬 변경 유지 · 새 파일이면 다시 덮어쓰기 · 내보내기 · AR 버전 · 파일 없을 때
// 먼저: node build.mjs, dist/를 8765 포트로 띄우기 (이 시험이 dist/diorama.json을 만들고 지움)
import { createRequire } from 'node:module';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const file = new URL('../dist/diorama.json', import.meta.url).pathname;
const shared = (savedAt, x0) => ({
  kind: 'raim-diorama', savedAt,
  roadMarkers: [{ id: 0, x: x0, y: 0, size: 8, rot: 0 }, { id: 1, x: 100, y: 0, size: 8, rot: 0 }, { id: 2, x: 100, y: 60, size: 8, rot: 90 }],
  path: [[20, 20], [80, 20], [80, 40], [20, 40]], pathStale: false, roadHeight: 0.5,
  car: { length: 12, width: 6, height: 4.3, color: '#e2453c', scale: 1.2 }, drive: { cruise: 10, speedScale: 1 },
  tracking: { focalFactor: 9.99 }, // 공유하면 안 되는 값: 무시돼야 함
});
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
await ctx.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (전시 설정 내보내기는 관리자만)
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const st = () => page.evaluate(() => window.__raim.state);
const cfgRaw = () => page.evaluate(() => JSON.parse(localStorage.getItem('raim-ar-marker-config-v1') || 'null'));
const ok = (c, msg) => console.log(c ? '  통과' : '  실패', msg);

// 0) 파일이 없을 때
rmSync(file, { force: true });
await page.goto('http://localhost:8765/marker.html');
await page.evaluate(() => localStorage.clear());
await page.reload(); await page.waitForTimeout(500);
console.log('0) diorama.json 없음');
ok((await st()).roadMarkers.length === 6 && !(await page.textContent('#sharedMsg')), 'A4 기본 지도 그대로, 안내 문구 없음');

// 1) 처음 열 때 불러오기
writeFileSync(file, JSON.stringify(shared('2026-11-25T05:00:00.000Z', 0)));
await page.reload(); await page.waitForTimeout(600);
console.log('1) 처음 열기');
let c = await cfgRaw();
ok(c.roadMarkers.length === 3 && c.roadMarkers[2].rot === 90 && c.path.length === 4 && c.roadHeight === 0.5, '지도·경로·도로 높이 불러옴');
ok(c.car.scale === 1.2 && c.drive.cruise === 10 && c.drive.accel === 2.5, '차 설정 불러옴 (빠진 값은 기본값으로 채움)');
ok(c.tracking.focalFactor !== 9.99, '기기별 카메라 보정값은 공유 안 함');
console.log('   안내:', await page.textContent('#sharedMsg'));

// 2) 기기에서 바꾼 값은 같은 파일이면 유지
await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('raim-ar-marker-config-v1')); c.car.scale = 2; localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify(c)); });
await page.reload(); await page.waitForTimeout(600);
console.log('2) 다시 열기 (같은 파일)');
ok((await cfgRaw()).car.scale === 2 && !(await page.textContent('#sharedMsg')), '기기에서 바꾼 차 크기 유지');

// 3) 새 파일이면 덮어쓰기
writeFileSync(file, JSON.stringify(shared('2026-11-26T05:00:00.000Z', 5)));
await page.reload(); await page.waitForTimeout(600);
console.log('3) 새 diorama.json');
c = await cfgRaw();
ok(c.roadMarkers[0].x === 5 && c.car.scale === 1.2, '새 지도로 바뀌고 차 크기도 파일 값으로');

// 4) 내보내기
await page.click('#btnCamera').catch(() => {});
await page.evaluate(() => { document.getElementById('start').hidden = true; document.getElementById('ui').hidden = false; });
await page.click('#btnSettings');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cfgExport')]);
const out = JSON.parse(readFileSync(await dl.path(), 'utf8'));
console.log('4) 내보내기:', dl.suggestedFilename());
ok(out.kind === 'raim-diorama' && out.roadMarkers.length === 3 && !('tracking' in out) && typeof out.savedAt === 'string', '지도·경로 포함, 카메라 보정값 제외');

// 5) AR 버전도 같은 설정
const ar = await ctx.newPage();
ar.on('pageerror', (e) => errs.push('AR: ' + e.message));
await ar.goto('http://localhost:8765/index.html?lite=0'); await ar.waitForTimeout(600);
console.log('5) AR 버전');
const as = await ar.evaluate(() => window.__raimAR.state);
ok(as.roadMarkers.length === 3 && as.roadMarkers[0].x === 5, 'AR 버전도 같은 지도');
console.log('   시작 화면:', (await ar.textContent('#mapInfo')).replace(/\s+/g, ' '));
const [dl2] = await Promise.all([ar.waitForEvent('download'), ar.click('#btnExport')]);
ok(JSON.parse(readFileSync(await dl2.path(), 'utf8')).roadMarkers.length === 3, 'AR 버전에서도 내보내기');
await ar.click('#btnShared'); await ar.waitForTimeout(300);
console.log('   다시 불러오기:', await ar.textContent('#sharedMsg'));

rmSync(file, { force: true });
console.log('errors:', errs);
await browser.close();
