// AR 경로 카드 시험 (가짜 ARCore, A4 시트): 경로 기록 중 카드(마커 20, 3cm)를 도로 가운데 6곳에 차례로 멈춰 두면
// 자리마다 점이 하나씩 자동으로 찍히는지, 위치가 맞는지, 저장 후 주행하는지
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta-card.json', import.meta.url)));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'card'; window.__mockHold = 3;\n${mock}`);
await page.goto('http://localhost:8765/index.html?lite=0');
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ pathCard: { id: 20, size: 3 } })); });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 20000 });
// 장면 처음부터 시작하도록 프레임 번호가 0 근처일 때 기록 시작
await page.waitForFunction(() => window.__mockFrame < 3, null, { timeout: 30000 });
await page.click('#btnRecord');
const msgs = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  const st = await page.textContent('#status');
  if (/점 \d+ 찍었어요|카드 보임/.test(st)) msgs.add(st.replace(/\d+/g, 'n'));
  if (await page.evaluate(() => window.__mockFrame) > meta.N - 3) break;
  await page.waitForTimeout(150);
}
await page.waitForTimeout(300); // 마지막 자리 처리 시간
const pts = (await page.evaluate(() => window.__raimAR.state)).recPts;
console.log(`찍힌 점 ${pts.length}개 (카드 자리 ${meta.card.spots.length}곳)`);
const errsCm = meta.card.spots.map((s) => Math.min(...pts.map((p) => Math.hypot(p[0] - s[0], p[1] - s[1]))));
console.log('자리마다 가장 가까운 점까지 오차(cm):', errsCm.map((e) => e.toFixed(2)).join(', '));
console.log('나온 안내:', [...msgs].join(' / '));
await page.click('#recDone');
const a = (await page.evaluate(() => window.__raimAR.state)).s; await page.waitForTimeout(1000);
const st = await page.evaluate(() => window.__raimAR.state);
console.log('저장된 경로 점', st.path.length, '개 · 주행 거리 증가', (st.s - a).toFixed(2), 'cm · errors:', errs);
await browser.close();
