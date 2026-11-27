// AR 화면이 멈칫거리는 원인 측정 (가짜 ARCore, 전시 디오라마, 태블릿 가로 1280x800 · 화면 배율 2)
// 관람 모드로 AR을 켜고 6초 동안: 화면 스레드가 한 일(스크립트·스타일 계산·배치), 50ms 넘는 막힘, 프레임 간격
// ADMIN=1: 관리자 모드(인식 표시 켬)로 잼
// 먼저: node test/xr-mock/make-frames-dio.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { MARKERS, truthLoop } from './diorama-scene.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.addInitScript(`window.__mockScene = 'dio'; window.__mockHold = 3;${process.env.ADMIN ? "window.__raimAutoAdmin = '4300';" : ''}
window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
\n${mock}`);
await page.goto(`http://localhost:8765/ar.html?lite=${process.env.LITE ? 1 : 0}`);
await page.evaluate(({ markers, path }) => { localStorage.clear(); localStorage.setItem('raim-ar-marker-config-v1', JSON.stringify({ roadMarkers: markers, path, pathStale: false })); }, { markers: MARKERS, path: truthLoop(4) });
await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const m0 = await metrics();
await page.evaluate(() => { window.__long = []; window.__coverage = []; window.__t0 = performance.now(); });
await page.waitForTimeout(6000);
const m1 = await metrics();
const r = await page.evaluate(() => ({ long: window.__long, frames: window.__coverage.length, secs: (performance.now() - window.__t0) / 1000, perf: window.__raimAR.state.perf || null }));
const d = (k) => m1[k] - m0[k];
const per = (k) => (d(k) / r.secs * 1000).toFixed(0);
console.log(`${process.env.ADMIN ? '관리자' : '관람'} 모드 · ${r.secs.toFixed(1)}초`);
console.log(`  1초마다 화면 스레드: 스크립트 ${per('ScriptDuration')}ms · 스타일 ${per('RecalcStyleDuration')}ms(${(d('RecalcStyleCount') / r.secs).toFixed(0)}번) · 배치 ${per('LayoutDuration')}ms(${(d('LayoutCount') / r.secs).toFixed(0)}번) · 전체 일 ${per('TaskDuration')}ms`);
console.log(`  50ms 넘는 막힘 ${r.long.length}번 · AR 프레임 ${(r.frames / r.secs).toFixed(1)}fps${r.perf ? ` · 앱 측정 ${JSON.stringify(r.perf)}` : ''}`);
await browser.close();
