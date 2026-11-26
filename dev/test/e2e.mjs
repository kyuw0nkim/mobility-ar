import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=/home/claude/marker-proto/test/cam.y4m', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8765/index.html');
await page.click('#btnCamera');
const t0 = Date.now();
const shots = { 1.5: 'e2e-a', 5.5: 'e2e-b', 7.5: 'e2e-c', 11: 'e2e-d' };
const done = new Set();
while (Date.now() - t0 < 12000) {
  const t = (Date.now() - t0) / 1000;
  const s = await page.evaluate(() => {
    const st = window.__raim.state; return { tr: st.tracking, rc: st.roadCount, b: st.barricade && [st.barricade.x.toFixed(1), st.barricade.y.toFixed(1)].join(','), seen: st.barricadeSeenNow, cs: st.carState, v: st.v && st.v.toFixed(2), gap: st.gap == null ? null : st.gap.toFixed(1), f: st.focal && st.focal.toFixed(0), hud: [document.getElementById('hudSense').textContent, document.getElementById('hudJudge').textContent, document.getElementById('hudControl').textContent, document.getElementById('debug').textContent].join(' | ') };
  });
  console.log(t.toFixed(1) + 's', JSON.stringify(s));
  for (const k of Object.keys(shots)) if (t >= +k && !done.has(k)) { done.add(k); await page.screenshot({ path: `test/${shots[k]}.png` }); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('errors:', errs);
await browser.close();
