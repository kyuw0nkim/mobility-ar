// 버튼을 눌러도 상태를 잃지 않는지 (마커 버전 A4 합성 영상, 2~7초에 바리케이드 / AR 버전 가짜 ARCore 바리케이드 장면)
//  1) 바리케이드 앞에 멈춘 채 [차 +]·[높이 +]를 눌러도 바리케이드를 잊지 않고 계속 멈춰 있음
//  2) 안내 문구가 떠 있는 동안에도 인식·판단·제어 카드가 갱신됨 (마커 버전)
//  3) [차 +/−]를 여러 번 눌러도 GPU 모양(geometry) 수가 늘지 않음
// 먼저: node test/make-video.mjs, node test/xr-mock/make-frames.mjs bar, node build.mjs, test/xr-mock을 dist/로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };

async function pressAndWatch(page, key, label) {
  const st = () => page.evaluate((k) => window[k].state, key);
  const g0 = (await st()).gpu.geometries;
  const b0 = (await st()).barricade;
  await page.click('#carBigger'); await page.click('#heightUp');
  const r = [];
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(100); r.push(await st()); }
  ok(b0 && r.every((s) => s.barricade), `${label}: [차 +]·[높이 +] 뒤에도 바리케이드 기억`);
  ok(r.every((s) => s.carState === 'stop'), `${label}: 계속 멈춰 있음 (${r.map((s) => s.carState).join(',')})`);
  for (let i = 0; i < 5; i++) { await page.click('#carBigger'); await page.click('#carSmaller'); }
  await page.waitForTimeout(300);
  const g1 = (await st()).gpu.geometries;
  ok(g1 <= g0 + 2, `${label}: [차 +/−] 10번 뒤 GPU 모양 ${g0} → ${g1}`);
}

// ---- 마커 버전 ----
{
  const video = new URL('./cam.y4m', import.meta.url).pathname;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:8765/index.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#btnCamera');
  for (let i = 0; i < 3; i++) await page.click('#speedUp');
  console.log('[마커 버전]');
  await page.waitForFunction(() => window.__raim.state.carState === 'stop', null, { timeout: 15000 });
  await pressAndWatch(page, '__raim', '마커');
  // 2) 바리케이드가 사라지고 다시 출발하는 동안 안내 문구를 띄워 둠 → 제어 카드는 계속 바뀌어야 함
  await page.waitForFunction(() => !window.__raim.state.barricade, null, { timeout: 15000 });
  await page.click('#speedDown');
  const msg = await page.textContent('#status');
  const hud = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(100); hud.push(await page.textContent('#hudControl')); }
  ok(new Set(hud).size > 2 && (await page.textContent('#status')) === msg, `안내 문구 유지 중에도 제어 카드 갱신 (${[...new Set(hud)].slice(0, 4).join(' / ')} …)`);
  ok(!errs.length, `오류 없음 ${errs.join(' | ')}`);
  await browser.close();
}

// ---- AR 버전 ----
{
  const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(`window.__mockScene = 'bar'; window.__mockHold = 3;\n${mock}`);
  await page.goto('http://localhost:8765/ar.html');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ drive: { speedScale: 4 }, barricade: { height: 5.5 } })); });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  console.log('[AR 버전]');
  await page.waitForFunction(() => window.__raimAR.state.carState === 'stop', null, { timeout: 20000 });
  console.log('  인식 방식:', (await page.evaluate(() => window.__raimAR.state.detectMode)) === 'worker' ? '별도 스레드(워커)' : '화면 스레드');
  await pressAndWatch(page, '__raimAR', 'AR');
  ok(!errs.length, `오류 없음 ${errs.join(' | ')}`);
  await browser.close();
}
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exitCode = fails ? 1 : 0;
