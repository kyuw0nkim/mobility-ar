// 건물 등록 가림 시험 (가짜 ARCore, 전시 디오라마)
//  - 높이 재기 계산(시선과 세로줄), 네모(탭 3번)·둘레·천막(아래 뚫림)·나무 모양
//  - [건물 등록] → 점 찍기 → 높이 → 저장 → 디오라마 전체를 덮는 큰 건물 뒤의 차·경로는 안 보임, 지우면 다시 보임
//  - 건물이 있으면 깊이 인식은 요청하지 않음, 전시 설정(diorama.json)에 건물이 들어감
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
import { heightOnVertical, rectFrom3 } from '../src/buildings.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? '통과' : '실패'} ${msg}`); if (!c) fails++; };

console.log('[계산]');
const z = heightOnVertical([0, 0, 50], [Math.SQRT1_2, 0, -Math.SQRT1_2], 30, 0);
ok(Math.abs(z - 20) < 1e-9, `45° 아래로 본 시선 · 30cm 앞 세로줄 → 높이 ${z.toFixed(2)} (정답 20)`);
const r = rectFrom3([0, 0], [10, 0], [3, 6]);
ok(JSON.stringify(r) === JSON.stringify([[0, 0], [10, 0], [10, 6], [0, 6]]), `탭 3번 → 네모 ${JSON.stringify(r)}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript("window.__raimAutoAdmin = '4300';");
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 4; window.__mockDepth = true;\n${mock}`);
await page.goto('http://localhost:8765/?lite=0');
await page.evaluate(({ markers, path }) => {
  localStorage.clear();
  localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false, car: { scale: 3 }, drive: { speedScale: 0.0001 }, occlusion: { enabled: false } }));
}, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 });
const cover = async () => {
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__coverageTB = []; });
  await page.waitForTimeout(800);
  const tb = await page.evaluate(() => window.__coverageTB);
  return tb.reduce((s, v) => s + v[0] + v[1], 0) / Math.max(1, tb.length);
};
const base = await cover();
console.log('[등록]');
ok(base > 100, `건물 없음: 차·경로 보임 (${base.toFixed(0)})`);
await page.click('#btnBuild');
ok(await page.isVisible('#buildBar'), '[건물 등록] → 등록 화면, 조준점 ' + (await page.isVisible('#aim') ? '보임' : '안 보임'));
// 디오라마 전체(마커 범위 + 여유)를 덮는 네모: 탭 3번
const ext = MARKERS.reduce((a, m) => [Math.min(a[0], m.x), Math.min(a[1], m.y), Math.max(a[2], m.x), Math.max(a[3], m.y)], [1e9, 1e9, -1e9, -1e9]);
const pad = 60;
await page.evaluate(([x0, y0, x1, y1]) => { window.__raimAR.addBuildPointAt(x0, y0); window.__raimAR.addBuildPointAt(x1, y0); window.__raimAR.addBuildPointAt(x0, y1); }, [ext[0] - pad, ext[1] - pad, ext[2] + pad, ext[3] + pad]);
await page.fill('#buildH', '40');
await page.dispatchEvent('#buildH', 'input');
ok(!(await page.isDisabled('#buildSave')), '점 3개 + 높이 → 저장 가능');
await page.click('#buildSave');
let b = await page.evaluate(() => window.__raimAR.buildings());
ok(b.count === 1 && b.cfg[0].kind === 'building', `저장: ${b.count}개`);
await page.click('#buildClose');
const hidden = await cover();
ok(hidden < base * 0.05, `큰 건물 뒤(안)의 차·경로는 안 보임 (${hidden.toFixed(0)} / ${base.toFixed(0)})`);
await page.click('#btnShowBuild');
ok(await cover() > hidden + 50, '[건물 표시] → 반투명 모양 보임');
await page.click('#btnShowBuild');

console.log('[천막·나무 모양]');
await page.click('#btnBuild');
await page.click('#buildKinds button[data-kind="canopy"]');
ok(await page.isVisible('#buildUnder') && !(await page.isVisible('#buildR')), '천막: 아래 빈 높이 칸 보임');
await page.evaluate(() => { for (const [x, y] of [[0, 0], [20, 0], [20, 10], [10, 15], [0, 10]]) window.__raimAR.addBuildPointAt(x, y); });
await page.fill('#buildH', '12'); await page.fill('#buildUnder', '7'); await page.fill('#buildPeak', '3');
await page.dispatchEvent('#buildPeak', 'input');
await page.click('#buildSave');
await page.click('#buildKinds button[data-kind="tree"]');
await page.evaluate(() => window.__raimAR.addBuildPointAt(50, 50));
await page.fill('#buildH', '15'); await page.fill('#buildR', '3');
await page.dispatchEvent('#buildR', 'input');
await page.click('#buildSave');
b = await page.evaluate(() => window.__raimAR.buildings());
const rh = await page.evaluate(() => window.__raimAR.state.roadHeight);
const [cz0, cz1] = [b.boxes[1][2], b.boxes[1][5]];
ok(Math.abs(cz0 - (rh + 7)) < 0.05 && Math.abs(cz1 - (rh + 15)) < 0.05, `천막: 아래 ${cz0} ~ 꼭대기 ${cz1} (아래 7cm는 뚫림, 뾰족 지붕 3cm 포함)`);
const t = b.boxes[2];
ok(Math.abs(t[0] - 47) < 0.1 && Math.abs(t[3] - 53) < 0.1 && Math.abs(t[5] - (rh + 15)) < 0.05, `나무: 반지름 3 · 높이 15 (${t})`);
console.log('  ', await page.textContent('#buildStat'));
await page.click('#buildDelLast');
b = await page.evaluate(() => window.__raimAR.buildings());
ok(b.count === 2, `[마지막 건물 지우기] → ${b.count}개`);
await page.click('#buildClose');

console.log('[깊이 인식·전시 설정]');
const shared = await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('raim-ar-marker-config-v1')); return c.buildings.length; });
ok(shared === 2, `이 기기에 저장 (${shared}개)`);
await page.click('#btnExit');
await page.waitForFunction(() => !document.getElementById('start').hidden);
await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('raim-ar-marker-config-v1')); c.occlusion = { enabled: true }; localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify(c)); });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
const dl = page.waitForEvent('download');
await page.click('#btnExport');
const json = JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
ok(Array.isArray(json.buildings) && json.buildings.length === 2, `diorama.json에 건물 ${json.buildings && json.buildings.length}개`);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 60000 });
const st = await page.evaluate(() => window.__raimAR.state);
ok(!st.depthRequested, `건물이 있으면 깊이 인식 요청 안 함 (깊이 가림 버튼: ${await page.textContent('#btnOcclusion')})`);
ok(errs.length === 0, `페이지 오류 없음 ${errs.slice(0, 3).join(' | ')}`);
await browser.close();
console.log(fails ? `실패 ${fails}개` : '모두 통과');
process.exit(fails ? 1 : 0);
