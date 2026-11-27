import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/home/claude/marker-proto/test/cam.y4m', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8765/marker.html');
await page.click('#btnCamera'); await new Promise((r) => setTimeout(r, 1000));
await page.click('#btnSettings');
const txt = await page.$eval('#cfgText', (e) => e.value);
const cfg = JSON.parse(txt); cfg.drive.cruise = 4;
await page.$eval('#cfgText', (e, v) => { e.value = v; }, JSON.stringify(cfg));
await page.click('#cfgSave');
const hidden = await page.$eval('#settings', (e) => e.hidden);
await page.click('#btnSettings'); await page.$eval('#cfgText', (e) => { e.value = '{bad'; }); await page.click('#cfgSave');
const msg = await page.$eval('#cfgMsg', (e) => e.textContent);
console.log('저장 후 닫힘:', hidden, '| 잘못된 JSON 메시지:', msg, '| errors:', errs);
await browser.close();
