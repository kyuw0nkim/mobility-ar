// 나만의 차: 도안 스캔 → 미리보기 → AR 주행 → 가까이 가면 지붕 열림 (가짜 ARCore, 전시 디오라마)
//  1) 칸마다 다른 색으로 칠한 도안을 비스듬히·누런 조명으로 찍은 사진을 만들고, 앱이 표식 4개를 찾아 펴는지
//  2) 편 그림의 칸 색이 칠한 색과 맞는지 (조명 보정 포함)
//  3) 미리보기(3D 차, 안쪽 보기) → [이 차로 달리기] → AR에서 차가 달림
//  4) 지붕 열리는 거리를 크게/작게 바꿔 가며 지붕이 열리고 닫히는지
// 시작 화면 제목·버튼, 스캔 화면도 확인. 화면 사진: test/car-*.png (또는 인자로 준 폴더)
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
import { carSheetSVG } from '../tools/car-sheet-svg.mjs';
import { REGIONS, SHEET } from '../src/car-template.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const out = process.argv[2] || new URL('.', import.meta.url).pathname;
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

// 1) 색칠한 도안 사진 만들기: 책상 위에 비스듬히 놓고, 누런 조명
const FILLS = { side: '#e53935', front: '#fdd835', back: '#8e24aa', top: '#1e88e5', interior: '#43a047' };
const font = resolve('node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2');
const shot = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
await shot.setContent(`<!doctype html><style>@font-face{font-family:"Pretendard Variable";src:url("file://${font}")}
  body{margin:0;background:#7b6a55;width:1600px;height:1200px;overflow:hidden;perspective:1500px}
  .p{position:absolute;left:250px;top:250px;width:1100px;height:${1100 * SHEET.h / SHEET.w}px;transform:rotateX(28deg) rotateZ(-7deg) rotateY(-10deg);box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .p svg{width:100%;height:100%;display:block}
  .tint{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,200,120,.28),rgba(80,60,20,.25));mix-blend-mode:multiply;pointer-events:none}</style>
  <div class="p">${carSheetSVG({ fills: FILLS })}</div><div class="tint"></div>`);
await shot.evaluate(() => document.fonts.ready);
const photo = await shot.screenshot({ type: 'png' });
await shot.screenshot({ path: `${out}/car-0-photo.png` });
await shot.close();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__raimSkipScan = false;\n${mock}`);
await page.goto('http://localhost:8765/?lite=0');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);

console.log('[시작 화면]');
const title = await page.evaluate(() => { const h = document.querySelector('.start-title'), b = document.getElementById('btnStart'); const hr = h.getBoundingClientRect(), br = b.getBoundingClientRect(); return { text: h.textContent, above: hr.bottom <= br.top + 1, doc: document.title }; });
ok(title.text === '도로 위의 상상' && title.above, `제목 '${title.text}'이 [시작하기] 위에`);
ok(title.doc === '도로 위의 상상', `페이지 제목 '${title.doc}'`);
await page.screenshot({ path: `${out}/car-1-start.png` });

console.log('[스캔 화면]');
await page.click('#btnStart');
await page.waitForFunction(() => !document.getElementById('scan').hidden);
await page.waitForTimeout(800);
const guide = await page.textContent('#scanGuide');
ok(guide.length > 3, `스캔 안내: ${guide}`);
await page.screenshot({ path: `${out}/car-2-scan.png` });

console.log('[사진에서 도안 펴기]');
const res = await page.evaluate(async (b64) => {
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  return window.__raimAR.carFlow().scanImageData(ctx.getImageData(0, 0, cv.width, cv.height));
}, photo.toString('base64'));
ok(res.ok && res.found.length === 4, `표식 ${res.found && res.found.join(',')} 찾음 · 귀퉁이 오차 ${res.err && res.err.toFixed(2)}px`);
await page.waitForFunction(() => !document.getElementById('preview').hidden);
// 칸 가운데 색 = 칠한 색? (펴진 그림에서)
const cols = await page.evaluate(({ regions, sheet }) => {
  const cv = window.__raimAR.carFlow().canvas, ctx = cv.getContext('2d'), k = cv.width / sheet.w;
  const at = (x, y) => { const d = ctx.getImageData(Math.round(x * k) - 3, Math.round(y * k) - 3, 7, 7).data; const s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) s[j] += d[i + j]; return s.map((v) => Math.round(v / 49)); };
  const o = {};
  // 칸 안 빈 자리 (안내 점선·좌석을 피한 곳)
  const spots = { side: [0.12, 0.3], front: [0.5, 0.15], back: [0.5, 0.9], top: [0.1, 0.2], interior: [0.12, 0.5] };
  for (const [k2, [a, b]] of Object.entries(spots)) { const r = regions[k2]; o[k2] = at(r.x + a * r.w, r.y + (1 - b) * r.h); }
  o.paper = at(150, 100); // 칸 밖 흰 종이
  return o;
}, { regions: REGIONS, sheet: SHEET });
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
for (const [k, want] of Object.entries(FILLS)) {
  const got = cols[k], w = hex(want), d = Math.hypot(...got.map((v, i) => v - w[i]));
  ok(d < 90, `${REGIONS[k].label}: 칠한 색 ${want} → 펴진 그림 rgb(${got.join(',')}) (차이 ${d.toFixed(0)})`);
}
ok(cols.paper.every((v) => v > 215), `흰 종이는 흰색으로 보정 rgb(${cols.paper.join(',')})`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/car-3-preview.png` });
await page.click('#btnInside');
await page.waitForTimeout(2000);
const pvOpen = await page.evaluate(() => window.__raimAR.carFlow().previewOpen);
ok(pvOpen > 0.9, `미리보기 [안쪽 보기] → 지붕 열림 ${pvOpen.toFixed(2)}`);
await page.screenshot({ path: `${out}/car-4-preview-inside.png` });

console.log('[이 차로 달리기 → AR]');
await page.click('#btnGo');
await page.waitForFunction(() => document.getElementById('start').hidden && document.getElementById('preview').hidden && !document.getElementById('ui').hidden, null, { timeout: 15000 });
const st = () => page.evaluate(() => window.__raimAR.state);
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 });
let s = await st();
const s0 = s.s;
await page.waitForTimeout(2500);
s = await st();
ok(s.s > s0 + 1, `차가 달림 (${(s.s - s0).toFixed(1)}cm)`);
const usesScan = await page.evaluate(() => !!window.__raimAR.carFlow().canvas);
ok(usesScan, '스캔한 도안으로 만든 차');
let pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.dist > 0 && pk.near > 0 && pk.far > pk.near, `카메라–차 거리 ${pk.dist && pk.dist.toFixed(2)}m · 지붕 열림 ${pk.near.toFixed(2)}~${pk.far.toFixed(2)}m · 지금 ${pk.open.toFixed(2)}`);
// 지붕 열리는 거리를 크게(5~6m) → 지금 거리에서 열림, 아주 작게 → 닫힘 (설정 car.peekNear·peekFar)
await page.evaluate(() => window.__raimAR.setPeekRange(5, 6));
await page.waitForTimeout(1500);
pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.open > 0.95, `가까이(열림 거리 안) → 지붕 열림 ${pk.open.toFixed(2)}`);
await page.screenshot({ path: `${out}/car-5-ar-open.png` });
await page.evaluate(() => window.__raimAR.setPeekRange(0.01, 0.02));
await page.waitForTimeout(1500);
pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.open < 0.05, `멀리 → 지붕 닫힘 ${pk.open.toFixed(2)}`);
await page.screenshot({ path: `${out}/car-6-ar-closed.png` });

console.log('[끝내기 → 처음 화면, 다음 관람객은 새 도안]');
await page.click('#btnExit');
await page.waitForFunction(() => !document.getElementById('start').hidden);
ok(!(await page.evaluate(() => window.__raimAR.carFlow().canvas)), '끝내면 스캔한 도안을 비움');
ok(errs.length === 0, `페이지 오류 없음 ${errs.slice(0, 3).join(' | ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
