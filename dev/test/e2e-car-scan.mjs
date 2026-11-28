// 나만의 차: 도안 두 장 스캔 → 미리보기 → AR 주행 → 가까이 가면 지붕 열림 (가짜 ARCore, 전시 디오라마)
//  1) 실제 도안 PDF(로보택시 ①·②)를 그림으로 바꿔 아이가 꾸민 것처럼 칠하고(옆면 빨강, 실내 파랑, 이름 쓰기, 분홍 지붕 ✓),
//     비스듬히·누런 조명으로 찍은 사진을 만든다
//  2) 앱이 두 장을 찾아 펴고: 차 종류, 고른 지붕 색, 이름, 칠한 색, 창문(유리색)을 확인
//  3) 미리보기(3D, 안쪽 보기) → [이 차로 달리기] → AR에서 차가 달림 → 지붕 열리는 거리 안/밖에서 열림/닫힘
//  4) 다른 차 도안을 비추면 그 차로 새로 시작
// 화면 사진: test/car-*.png (또는 인자로 준 폴더)
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로 (pdftoppm 필요)
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
import { CAR_TEMPLATES } from '../src/car-templates.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const out = process.argv[2] || new URL('.', import.meta.url).pathname;
const PDF = fileURLToPath(new URL('../../RAIM-AR-차도안.pdf', import.meta.url));
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };
// 가짜 카메라: 스캔 화면이 '카메라를 열 수 없어요'가 아니라 평소 첫 안내를 보이게
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

// 1) 도안 쪽 그림 (200dpi) → 꾸미기 → 비스듬히 찍은 사진
const tmp = mkdtempSync(join(tmpdir(), 'carscan-'));
const pagePng = (n) => { execFileSync('pdftoppm', ['-r', '200', '-f', String(n), '-l', String(n), '-png', '-singlefile', PDF, join(tmp, `p${n}`)]); return readFileSync(join(tmp, `p${n}.png`)).toString('base64'); };
const T = CAR_TEMPLATES.taxi;
async function photo(b64, decorate, file) {
  const p = await browser.newPage({ viewport: { width: 1200, height: 1500 } });
  await p.setContent('<body style="margin:0;background:#7b6a55"></body>');
  const url = await p.evaluate(async ({ b64, decorate, T }) => {
    const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(bm, 0, 0);
    const k = bm.width / 210; // px/mm
    ctx.scale(k, k);
    new Function('ctx', 'T', decorate)(ctx, T);
    return cv.toDataURL('image/png');
  }, { b64, decorate, T });
  await p.setContent(`<style>body{margin:0;background:#7b6a55;width:1200px;height:1500px;overflow:hidden;perspective:1600px}
    img{position:absolute;left:190px;top:170px;width:820px;transform:rotateX(18deg) rotateZ(5deg) rotateY(8deg);box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .tint{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,200,120,.25),rgba(80,60,20,.22));mix-blend-mode:multiply}</style>
    <img src="${url}"><div class="tint"></div>`);
  await p.waitForTimeout(300);
  const buf = await p.screenshot({ type: 'png' });
  await p.screenshot({ path: `${out}/${file}` });
  await p.close();
  return buf.toString('base64');
}
// ① 겉모습: 옆면 아래쪽 빨강 칠, 이름 '하늘 택시'
const R0 = T.ext.sides[0], L0 = T.ext.sides[1];
const RED = [214, 40, 40];
const decoExt = `
  ctx.fillStyle = 'rgb(${RED})';
  for (const s of T.ext.sides) { const y = s.window[0][3] + 13; ctx.beginPath(); ctx.ellipse((s.bbox[0] + s.bbox[2]) / 2 + 30, y, 10, 4.5, 0, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#111'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('하늘 택시', 105, 47.5);`;
// ② 앞·뒤와 실내: 분홍 지붕 칸에 ✓, 실내에 파란 상자
const pink = T.int.swatches.findIndex((s) => s.color === '#ff9fb2');
const BLUE = [40, 90, 220];
const decoInt = `
  const b = T.int.swatches[${pink}].box;
  ctx.strokeStyle = '#222'; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(b[0] + 0.8, b[1] + 2.6); ctx.lineTo(b[0] + 2.2, b[3] - 0.8); ctx.lineTo(b[2] - 0.6, b[1] + 0.6); ctx.stroke();
  ctx.fillStyle = 'rgb(${BLUE})'; const I = T.int.interior; ctx.fillRect(I[0] + 40, I[1] + 20, 50, 30);`;
const photoExt = await photo(pagePng(3), decoExt, 'car-0-photo-ext.png');
const photoInt = await photo(pagePng(4), decoInt, 'car-0-photo-int.png');
const photoTruck = await photo(pagePng(5), '', 'car-0-photo-truck.png');

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3; window.__raimSkipScan = false;\n${mock}`);
await page.goto('http://localhost:8765/?lite=0');
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);

console.log('[시작 화면]');
const title = await page.evaluate(() => { const h = document.querySelector('.start-title'), b = document.getElementById('btnStart'); return { text: h.textContent, above: h.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1, doc: document.title }; });
ok(title.text === '도로 위의 상상' && title.above && title.doc === '도로 위의 상상', `제목 '${title.text}'이 [시작하기] 위에, 페이지 제목 '${title.doc}'`);
await page.screenshot({ path: `${out}/car-1-start.png` });

console.log('[스캔: 두 장]');
await page.click('#btnStart');
await page.waitForFunction(() => !document.getElementById('scan').hidden);
await page.waitForTimeout(600);
// 처음 보는 사람용 안내: 진행 단계 3개(1단계가 지금), 큰 안내 제목, 사진 고르기 버튼 없음
const first = await page.evaluate(() => ({
  steps: [...document.querySelectorAll('#scanSteps .st')].map((li) => `${li.className.replace('st ', '')}:${li.querySelector('.st-label').lastChild.textContent}`),
  title: document.getElementById('scanGuide').textContent,
  titlePx: parseFloat(getComputedStyle(document.getElementById('scanGuide')).fontSize),
  photo: !!document.getElementById('scanPhoto') || !!document.getElementById('scanFile'),
}));
ok(first.steps.join(' > ') === 'current:겉모습 > todo:앞·뒤와 실내 > todo:나만의 차 확인', `진행 단계: ${first.steps.join(' > ')}`);
ok(first.title === '도안 한 장을 비춰 주세요' && first.titlePx >= 24, `큰 안내 '${first.title}' (${first.titlePx}px)`);
ok(!first.photo, '사진 고르기 없음');
await page.screenshot({ path: `${out}/car-2a-scan-first.png` });
const scanPhoto = (b64) => page.evaluate(async (b64) => {
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  return window.__raimAR.carFlow().scanImageData(ctx.getImageData(0, 0, cv.width, cv.height));
}, b64);
// 다른 차(배송 트럭) 한 장을 먼저 → 로보택시를 찍으면 로보택시로 새로 시작
let r = await scanPhoto(photoTruck);
ok(r.ok && r.vehicle === 'truck' && r.page === 'ext', `배송 트럭 ① 찾음 (표식 ${r.found})`);
r = await scanPhoto(photoInt);
ok(r.ok && r.vehicle === 'taxi' && r.page === 'int', `로보택시 ② 찾음 (표식 ${r.found}, 귀퉁이 오차 ${r.err && r.err.toFixed(2)}px) → 로보택시로 새로 시작`);
const steps = await page.evaluate(() => [...document.querySelectorAll('#scanSteps .st')].map((li) => li.className.replace('st ', '')).join(' > '));
const chip = await page.textContent('#scanChip');
ok(steps === 'current > done > todo' && chip === '로보택시 도안', `진행 표시: ${steps} · ${chip}`);
ok(/① 겉모습 장을 비춰/.test(await page.textContent('#scanGuide')), `안내: ${await page.textContent('#scanGuide')}`);
await page.screenshot({ path: `${out}/car-2-scan.png` });
r = await scanPhoto(photoExt);
ok(r.ok && r.vehicle === 'taxi' && r.page === 'ext', `로보택시 ① 찾음 (표식 ${r.found}, 귀퉁이 오차 ${r.err && r.err.toFixed(2)}px)`);
await page.waitForFunction(() => !document.getElementById('preview').hidden, null, { timeout: 15000 });

console.log('[칠한 그림 → 차 그림]');
const info = await page.evaluate(({ R0, L0, I }) => {
  const p = window.__raimAR.carFlow().painted;
  const at = (cv, x, y) => { const d = cv.getContext('2d').getImageData(Math.round(x * 4) - 2, Math.round(y * 4) - 2, 5, 5).data; const s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) s[j] += d[i + j]; return s.map((v) => Math.round(v / 25)); };
  const red = [R0, L0].map((s) => at(p.ext, (s.bbox[0] + s.bbox[2]) / 2 + 30, s.window[0][3] + 13));
  const glass = at(p.ext, (R0.window[0][0] + R0.pillar[0][0]) / 2 + 8, (R0.window[0][1] + R0.window[0][3]) / 2);
  const roof = at(p.ext, 2.5, 145);
  const blue = at(p.int, I[0] + 65, I[1] + 35);
  // 이름 자리: 가운데 줄에 어두운 글씨 점이 있나
  const sl = R0.nameSlot, d = p.ext.getContext('2d').getImageData(sl[0] * 4, sl[1] * 4, (sl[2] - sl[0]) * 4, (sl[3] - sl[1]) * 4).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 250) dark++;
  return { vehicle: p.vehicle, roofColor: p.roof, roofPicked: p.roofPicked, name: p.name, red, glass, roof, blue, nameDark: dark };
}, { R0, L0, I: T.int.interior });
ok(info.vehicle === 'taxi', `차 종류 ${info.vehicle}`);
ok(info.roofPicked && info.roofColor === '#ff9fb2', `✓한 지붕 색 ${info.roofColor} (분홍)`);
ok(info.name && info.nameDark > 200, `이름 글씨를 옆면 이름 자리에 넣음 (어두운 점 ${info.nameDark})`);
const near = (a, b, t) => Math.hypot(...a.map((v, i) => v - b[i])) < t;
info.red.forEach((c, i) => ok(near(c, RED, 95), `${i ? '왼쪽' : '오른쪽'} 옆면 빨강 칠 → rgb(${c})`));
ok(info.glass[2] > info.glass[0] + 15 && info.glass[2] > 190, `창문 → 연한 하늘색 유리 rgb(${info.glass})`);
ok(near(info.roof, [255, 159, 178], 10), `지붕 색 조각 rgb(${info.roof})`);
ok(near(info.blue, BLUE, 95), `실내 파랑 칠 → rgb(${info.blue})`);
ok(/로보택시/.test(await page.textContent('#previewTitle')), `미리보기 제목: ${await page.textContent('#previewTitle')}`);
const pvSteps = await page.evaluate(() => [...document.querySelectorAll('#previewSteps .st')].map((li) => li.className.replace('st ', '')).join(' > '));
ok(pvSteps === 'done > done > current', `미리보기 진행 단계: ${pvSteps}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/car-3-preview.png` });
await page.click('#btnInside');
await page.waitForTimeout(2200);
const pvOpen = await page.evaluate(() => window.__raimAR.carFlow().previewOpen);
ok(pvOpen > 0.9, `미리보기 [안쪽 보기] → 지붕 열림 ${pvOpen.toFixed(2)}`);
await page.screenshot({ path: `${out}/car-4-preview-inside.png` });

const glassMat = await page.evaluate(() => { const p = window.__raimAR.carFlow().painted; return !!(p.extMat && p.intMat); });
ok(glassMat, '유리 재질 지도(창문만 매끈하게) 있음');
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
ok(await page.evaluate(() => window.__raimAR.carVehicle()) === 'taxi', '스캔한 로보택시로 달림');
let pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.dist > 0 && pk.far > pk.near, `카메라–차 거리 ${pk.dist && pk.dist.toFixed(2)}m · 지붕 열림 ${pk.near.toFixed(2)}~${pk.far.toFixed(2)}m · 지금 ${pk.open.toFixed(2)}`);
// 지붕 열리는 거리를 크게(5~6m) → 지금 거리에서 열림, 아주 작게 → 닫힘 (설정 car.peekNear·peekFar)
await page.evaluate(() => window.__raimAR.setPeekRange(5, 6));
await page.waitForTimeout(1500);
pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.open > 0.95, `가까이(열림 거리 안) → 지붕 열림 ${pk.open.toFixed(2)}`);
await page.evaluate(() => window.__raimAR.setPeekRange(0.01, 0.02));
await page.waitForTimeout(1500);
pk = await page.evaluate(() => window.__raimAR.peek());
ok(pk.open < 0.05, `멀리 → 지붕 닫힘 ${pk.open.toFixed(2)}`);

console.log('[끝내기 → 처음 화면, 다음 관람객은 새 도안]');
await page.click('#btnExit');
await page.waitForFunction(() => !document.getElementById('start').hidden);
ok(!(await page.evaluate(() => window.__raimAR.carFlow().painted)), '끝내면 스캔한 도안을 비움');
await page.waitForTimeout(500);
ok(await page.evaluate(() => window.__raimAR.carVehicle()) === 'taxi', '기본 차(빈 로보택시)로 돌아감');
ok(errs.length === 0, `페이지 오류 없음 ${errs.slice(0, 3).join(' | ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
