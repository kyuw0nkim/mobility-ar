// 나만의 차 도안 PDF(A4 가로) + 미리보기 PNG 만들기
// 사용: node tools/make-car-sheet.mjs [출력 pdf] [출력 png]
// 글꼴은 저장소의 Pretendard(assets)를 넣어서 인쇄해요
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { carSheetSVG } from './car-sheet-svg.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] || 'dist/car-sheet.pdf';
const PNG = process.argv[3] || null;
const font = ['node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2', '../assets/PretendardVariable.woff2'].find((p) => existsSync(p));
const svg = carSheetSVG();
mkdirSync('dist', { recursive: true });
writeFileSync('dist/car-sheet.svg', svg);
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Pretendard Variable"; src: url("file://${resolve(font)}") format("woff2-variations"); font-weight: 45 920; }
@page { size: 297mm 210mm; margin: 0 } html, body { margin: 0 } svg { display: block; width: 297mm; height: 210mm }
</style>${svg}`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1123, height: 794 } });
await p.setContent(html, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
await p.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true });
if (PNG) await p.screenshot({ path: PNG });
await b.close();
console.log(OUT, PNG || '');
