// 차 도안 PDF 고치기: 원본(sheet-src/차도안-원본.pdf) 위에 바뀐 부분만 덮어 그려 ../RAIM-AR-차도안.pdf를 만든다.
//  - 쪽마다 제목 → '나의 자율주행 자동차 디자인 ① 겉모습' 등으로 통일
//  - ① 겉모습의 '내 차 이름' 칸 좌우를 줄임 (NAME_BOX)
// 나머지(표식·차 그림·글씨)는 원본 그대로. 글꼴은 원본과 같은 Noto Sans CJK KR (설치 필요: fonts-noto-cjk)
// 사용: node tools/edit-car-sheet.mjs && node tools/extract-car-templates.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { TITLE, PAGE_SUBTITLES, NAME_BOX } from './car-sheet-edits.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SRC = process.argv[2] || 'sheet-src/차도안-원본.pdf';
const OUT = process.argv[3] || '../RAIM-AR-차도안.pdf';

const PAGES = PAGE_SUBTITLES.map((sub) => ({ sub, ext: sub.startsWith('①') }));
// 원본 치수 (mm): 제목 기준선 18.14, 7mm 굵게 #333. 이름 칸 x 30~180, y 33.0~56.74, 모서리 4, 테두리 0.7 점선 3/2
const FONT = '"Noto Sans CJK KR", "Noto Sans KR", sans-serif';

function overlay({ sub, ext }) {
  const nb = NAME_BOX;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">`;
  // 제목: 원본 제목을 흰색으로 덮고 새로 씀 (네 귀퉁이 표식은 x 8~20, 190~202라 건드리지 않음)
  s += `<rect x="21.5" y="8.4" width="167" height="12.8" fill="#fff"/>`;
  s += `<text x="105" y="18.14" text-anchor="middle" font-family='${FONT}' font-weight="700" font-size="7" fill="#333">${TITLE} ${sub}</text>`;
  if (ext) {
    s += `<rect x="28.6" y="31.6" width="152.8" height="26.6" fill="#fff"/>`;
    s += `<rect x="${nb.x0}" y="${nb.y0}" width="${nb.x1 - nb.x0}" height="${nb.y1 - nb.y0}" rx="4" fill="rgb(255,253,242)" stroke="rgb(224,168,0)" stroke-width="0.7" stroke-dasharray="3 2"/>`;
    s += `<text x="${nb.x0 + 4}" y="38.61" font-family='${FONT}' font-weight="700" font-size="3.6" fill="rgb(176,125,0)">내 차 이름</text>`;
    s += `<text x="${nb.x1 - 4}" y="38.61" text-anchor="end" font-family='${FONT}' font-weight="400" font-size="3" fill="rgb(176,125,0)">여기 쓴 글씨가 차 옆면에 그대로 들어가요</text>`;
    s += `<text x="105" y="51.1" text-anchor="middle" font-family='${FONT}' font-weight="700" font-size="5" fill="rgb(232,220,176)">크고 진하게 써요</text>`;
  }
  return s + '</svg>';
}

const b = await chromium.launch();
const p = await b.newPage();
const html = `<!doctype html><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:0}html,body{margin:0}.pg{width:210mm;height:297mm;break-after:page;overflow:hidden}.pg svg{display:block}</style>` +
  PAGES.map((pg) => `<div class="pg">${overlay(pg)}</div>`).join('');
await p.setContent(html, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
const ovBytes = await p.pdf({ preferCSSPageSize: true, printBackground: true });
await b.close();

const doc = await PDFDocument.load(readFileSync(SRC));
const ov = await PDFDocument.load(ovBytes);
const pages = doc.getPages();
const embedded = await doc.embedPdf(ov, PAGES.map((_, i) => i));
pages.forEach((page, i) => {
  const { width, height } = page.getSize();
  page.drawPage(embedded[i], { x: 0, y: 0, width, height });
});
doc.setTitle(TITLE);
writeFileSync(OUT, await doc.save());
console.log(OUT, pages.length, '쪽');
