// AR 버전 2단계 시험 (가짜 ARCore): 바리케이드 등장 → 인식 → 경로 위 판단 → 감속·정지 → 치우면 2초 뒤 재출발
// 먼저: node test/xr-mock/make-frames.mjs bar && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
// COLOR=1: 바리케이드 마커를 무시하게 해서 노랑·검정 줄무늬 색으로만 찾는지 시험
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta-bar.json', import.meta.url)));
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const HOLD = 3;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(`window.__mockScene = 'bar'; window.__mockHold = ${HOLD};\n${mock}`);
await page.goto('http://localhost:8765/index.html?lite=0');
// 빨리 바리케이드에 닿도록 속도 4배 (A4 시트 기본 경로)
const COLOR = !!process.env.COLOR, EDGE = !!process.env.EDGE;
console.log((COLOR ? '[색으로만 찾기 — 바리케이드 마커 무시]' : '[마커 + 색]') + (EDGE ? ' [마커는 한 변에만]' : ''));
await page.evaluate(({ COLOR, EDGE }) => {
  localStorage.clear();
  const cfg = { drive: { speedScale: 4 }, barricade: { width: 10, height: 5.5, colorHeight: null, colorPanelHeight: null, colorSizeRange: [0.25, 4] } }; // A4 시트 종이 바리케이드
  if (COLOR) cfg.barricade.markerIds = [98, 99];
  // EDGE=1: 마커를 아래쪽 한 변(0·1·2번)에만 붙인 지도 — 바리케이드는 그 반대쪽 도로(y=15)에 있음
  if (EDGE) cfg.roadMarkers = [{ id: 0, x: 2.4, y: 2.4, size: 3, rot: 0 }, { id: 1, x: 14.85, y: 2.4, size: 3, rot: 0 }, { id: 2, x: 27.3, y: 2.4, size: 3, rot: 0 }];
  localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify(cfg));
}, { COLOR, EDGE });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 5000 });
await page.click('#btnStart');
const log = [];
const sources = new Set();
const verdicts = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 16000) {
  const s = await page.evaluate(() => ({ ...window.__raimAR.state, frame: window.__mockFrame, judge: document.getElementById('hudJudge').textContent }));
  log.push({ t: (Date.now() - t0) / 1000, ...s });
  if (s.barricadeSeenNow) sources.add(s.barricadeSeenNow);
  if (s.yellow && s.yellow.length) s.yellow.forEach((v) => verdicts.add(v.replace(/×[0-9.]+/, '×n')));
  await page.waitForTimeout(100);
}
const shown = (f) => f >= meta.barricade.frames[0] && f < meta.barricade.frames[1];
// 첫 번째 바리케이드 구간
const iOn = log.findIndex((r) => r.ready && shown(r.frame));
const iOff = log.findIndex((r, i) => i > iOn && !shown(r.frame));
const iSeen = log.findIndex((r, i) => i >= iOn && r.barricade);
const iStop = log.findIndex((r, i) => i >= iOn && r.carState === 'stop');
const iGo = log.findIndex((r, i) => i > iOff && r.carState === 'drive' && !r.barricade);
console.log(`위치 맞춤: ${log.find((r) => r.ready) ? '완료' : '실패'} · 바리케이드를 찾은 방법: ${[...sources].join(', ') || '-'}`);
console.log(`바리케이드 등장 → 인식: ${iSeen >= 0 ? (log[iSeen].t - log[iOn].t).toFixed(1) + '초' : '인식 못 함'}`);
if (iSeen >= 0) {
  const b = log[iSeen + 5 < iOff ? iSeen + 5 : iSeen].barricade;
  const ang = Math.abs(Math.atan2(b.dy, b.dx)) * 180 / Math.PI; // 정답: 폭 방향 = y축(90°)
  console.log(`  추정 위치 (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) · 정답 (13, 15) · 오차 ${Math.hypot(b.x - 13, b.y - 15).toFixed(2)}cm · 폭 방향 ${ang.toFixed(1)}° (정답 90°)`);
  console.log(`  판단 카드: "${log[iSeen + 2] ? log[iSeen + 2].judge : ''}"`);
}
console.log(`정지: ${iStop >= 0 ? `등장 후 ${(log[iStop].t - log[iOn].t).toFixed(1)}초, 남은 간격 ${log[iStop].gap.toFixed(2)}cm` : '정지 안 함'}`);
const stopRows = log.filter((r, i) => i >= iStop && i < iOff && iStop >= 0);
console.log(`  정지 중 움직임: ${stopRows.length ? (Math.max(...stopRows.map((r) => r.s)) - Math.min(...stopRows.map((r) => r.s))).toFixed(3) + 'cm' : '-'}`);
console.log(`치움 → 재출발: ${iGo >= 0 ? (log[iGo].t - log[iOff].t).toFixed(1) + '초 (해제 기준 2초 + 확인)' : '재출발 안 함'}`);
console.log('인식 표시에 나온 판정:', [...verdicts].join(' / ') || '-');
console.log('인식 카드 예:', await page.textContent('#hudSense'));
await page.screenshot({ path: new URL('./e2e-ar-barricade.png', import.meta.url).pathname });
console.log('errors:', errs);
await browser.close();
