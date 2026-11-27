// [속도 +/−] 버튼: 목표 속도가 바뀌고, 바리케이드 앞에서 여전히 멈추는지 (A4 합성 영상, 2~7초에 바리케이드)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const video = new URL('./cam.y4m', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript("window.__raimAutoAdmin = '4300';"); // 관리자 모드로 시작 (조정 버튼을 쓰는 시험)
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8765/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('#btnCamera');
await page.waitForTimeout(500);
for (let i = 0; i < 3; i++) await page.click('#speedUp');
const st = () => page.evaluate(() => window.__raim.state);
const log = [];
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(500);
  const s = await st();
  log.push(`${(i * 0.5 + 0.5).toFixed(1)}s ${s.carState} v=${s.v.toFixed(2)}${s.gap !== null ? ` gap=${s.gap.toFixed(2)}` : ''}`);
}
const s = await st();
console.log('속도 배율', s.speedScale, '· 목표 속도', s.cruise.toFixed(2), 'cm/s');
console.log(log.join('\n'));
await page.click('#speedDown');
console.log('한 번 낮춤 →', (await st()).speedScale, '· 상태 문구:', await page.textContent('#status'));
console.log('errors:', errs);
await browser.close();
