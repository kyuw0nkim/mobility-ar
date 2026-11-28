// AR 버전 시험 (가짜 ARCore): 카메라 영상 읽기 → 마커 인식 → 위치 맞춤 → 경로 기록(탭) → 주행
// 먼저: node test/xr-mock/make-frames.mjs && node build.mjs, dist/를 8765 포트로 띄우고 test/xr-mock을 dist/xr-mock으로 복사
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { roadToWorld, CM } from '../src/xr-align.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta.json', import.meta.url)));
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const TRUE = meta.TRUE;

async function run(flip) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
  const errs = []; page.on('pageerror', (e) => errs.push(e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | '))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript(`window.__mockFlip = ${flip};\n${mock}`);
  await page.goto('http://localhost:8765/index.html?lite=0');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('raim-ar-aim', '0'); }); // 손가락 탭 흉내 (조준점 끔)
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 5000 });
  await page.click('#btnStart');
  const t0 = Date.now();
  await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 20000 }).catch(() => {});
  const st = await page.evaluate(() => window.__raimAR.state);
  const tReady = (Date.now() - t0) / 1000;
  console.log(`\n[카메라 텍스처 ${flip ? '위아래 뒤집힘' : '정방향'}] 맞춤 완료: ${st.ready} (${tReady.toFixed(1)}초, 추정 ${st.count}개) · 상단 글: ${await page.textContent('#debug')}`);
  if (!st.ready) { console.log('status:', await page.textContent('#status'), 'errors:', errs); await browser.close(); return; }
  // 깜빡임: 위치 맞춘 뒤 프레임마다 AR 층에 그려진 픽셀 수. 0이면 그 프레임에 차가 안 보인 것
  await page.evaluate(() => { window.__coverage = []; });
  await page.waitForTimeout(2500);
  const cov = await page.evaluate(() => window.__coverage);
  const blank = cov.filter((n) => n === 0).length;
  console.log(`깜빡임: 위치 맞춘 뒤 ${cov.length}프레임 중 ${blank}프레임에서 AR 층이 비어 있음 (차가 안 보임)`);
  const A = (await page.evaluate(() => window.__raimAR.state)).align;
  const pts = [[2, 2], [27, 2], [27, 19], [2, 19], [15, 10]];
  const errsCm = pts.map((X) => { const a = roadToWorld(A, [...X, 0]), b = roadToWorld(TRUE, [...X, 0]); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / CM; });
  const yawErr = Math.abs(Math.atan2(Math.sin(A.yaw - TRUE.yaw), Math.cos(A.yaw - TRUE.yaw))) * 180 / Math.PI;
  console.log(`위치 오차(시트 네 모서리·가운데): ${errsCm.map((e) => e.toFixed(2)).join(', ')} cm · 방향 오차 ${yawErr.toFixed(2)}°`);
  // 경로 기록: 카메라 위치에서 도로 점으로 쏜 광선을 탭으로 보냄
  await page.click('#btnRecord');
  const targets = [[8, 7], [21, 7], [21, 14], [8, 14], [14, 7.5]];
  for (const [x, y] of targets) {
    await page.evaluate(({ x, y, TRUE }) => {
      const s = window.__mockSession;
      const meta = window.__mockMeta;
      // 현재 프레임 카메라 위치 (뷰 행렬 평행이동)
      const v = window.__lastViewMatrix;
      const o = [v[12], v[13], v[14]];
      const c = Math.cos(TRUE.yaw), sn = Math.sin(TRUE.yaw);
      const w = [TRUE.p[0] + (c * x - sn * y) * 0.01, TRUE.p[1], TRUE.p[2] + (-sn * x - c * y) * 0.01];
      const d = [w[0] - o[0], w[1] - o[1], w[2] - o[2]]; const L = Math.hypot(...d); const f = d.map((q) => q / L);
      const z = f.map((q) => -q); // 광선 방향 = -Z
      let up = [0, 1, 0]; let xa = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
      const xl = Math.hypot(...xa); xa = xa.map((q) => q / xl);
      const ya = [z[1] * xa[2] - z[2] * xa[1], z[2] * xa[0] - z[0] * xa[2], z[0] * xa[1] - z[1] * xa[0]];
      const m = new Float32Array([...xa, 0, ...ya, 0, ...z, 0, ...o, 1]);
      const ev = new Event('select');
      ev.inputSource = { targetRaySpace: { matrix: m } };
      ev.frame = { getPose: (space) => ({ transform: { matrix: space.matrix } }) };
      s.dispatchEvent(ev);
    }, { x, y, TRUE });
    await page.waitForTimeout(80);
  }
  const rec = (await page.evaluate(() => window.__raimAR.state)).recPts;
  console.log('탭 기록 오차(cm):', rec.map((p, i) => Math.hypot(p[0] - targets[i][0], p[1] - targets[i][1]).toFixed(2)).join(', '));
  await page.click('#recDone');
  const s0 = (await page.evaluate(() => window.__raimAR.state)).s;
  await page.waitForTimeout(1500);
  const s1 = (await page.evaluate(() => window.__raimAR.state)).s;
  console.log('저장 후 주행 거리 증가:', (s1 - s0).toFixed(2), 'cm · 상태:', await page.textContent('#status'));
  await page.screenshot({ path: new URL(`./e2e-ar-${flip ? 'flip' : 'normal'}.png`, import.meta.url).pathname });
  await page.click('#btnExit');
  await page.waitForTimeout(200);
  console.log('끝낸 뒤 시작 화면 보임:', await page.isVisible('#start'), '· errors:', errs);
  await browser.close();
}
await run(false);
await run(true);
