// SVG 페이지들(A4) → PDF 한 파일 (Chromium 인쇄, 실제 크기 그대로)
// 사용: node tools/svg-to-pdf.cjs <svg 폴더> <출력 pdf>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [dir, out] = process.argv.slice(2);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
  const body = files.map((f) => `<div class="pg">${fs.readFileSync(path.join(dir, f), 'utf8')}</div>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:0}html,body{margin:0}.pg{width:210mm;height:297mm;break-after:page;overflow:hidden}.pg svg{display:block;width:210mm;height:297mm}</style>${body}`;
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  await b.close();
  console.log(out, files.length, 'pages');
})();
