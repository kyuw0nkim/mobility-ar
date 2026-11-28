// AR 버전 화면 스레드 막힘 측정 (가짜 ARCore): 위치 맞춘 뒤 5초 동안 50ms 넘게 막힌 일(long task)과 프레임 간격
// 먼저: node test/xr-mock/make-frames.mjs && node build.mjs, test/xr-mock을 dist/xr-mock으로 복사, dist/를 8765 포트로
// REC=1: 경로 기록(도로 영상 모으기) 중에 잼
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const mock = readFileSync(new URL('./xr-mock/mock-webxr.js', import.meta.url), 'utf8');
const port = process.env.PORT || 8765;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
await page.addInitScript(mock + `
window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });`);
await page.goto(`http://localhost:${port}/index.html?lite=${process.env.LITE ? 1 : 0}`);
await page.evaluate(() => localStorage.clear()); await page.reload();
await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
await page.click('#btnStart');
await page.waitForFunction(() => window.__raimAR.state.ready, null, { timeout: 20000 });
if (process.env.REC) await page.click('#btnRecord');
await page.waitForTimeout(1500); // 처음 보이는 3D 물체의 셰이더 준비 등이 끝난 뒤부터 잼
await page.evaluate(() => { window.__long = []; window.__coverage = []; window.__t0 = performance.now(); });
await page.waitForTimeout(5000);
const r = await page.evaluate(() => ({ long: window.__long, frames: window.__coverage.length, secs: (performance.now() - window.__t0) / 1000, mode: window.__raimAR.state.detectMode || 'main(예전)', dbg: document.getElementById('debug').textContent }));
const tot = r.long.reduce((a, b) => a + b, 0);
console.log(`${r.mode}${process.env.REC ? ' · 경로 기록 중' : ''}: 5초 동안 50ms 넘게 막힌 일 ${r.long.length}번 (합 ${tot.toFixed(0)}ms, 최대 ${Math.max(0, ...r.long).toFixed(0)}ms) · 프레임 ${(r.frames / r.secs).toFixed(1)}fps · ${r.dbg}`);
await browser.close();
