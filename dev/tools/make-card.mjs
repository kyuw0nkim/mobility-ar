// AR 경로 기록용 경로 카드(마커 20, 검은 사각형 5cm) A4 한 장 SVG — 카드 2장(예비 포함)
// 사용: node tools/make-card.mjs <출력 폴더> && node tools/svg-to-pdf.cjs <출력 폴더> 경로카드.pdf
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
const { AR } = createRequire(import.meta.url)('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const OUT = process.argv[2] || 'dist/card';
const ID = 20, SIZE = 50; // mm
const FONT = 'Noto Sans CJK KR, sans-serif';
const PW = 210, PH = 297;
const text = (x, y, s, size = 4, extra = '') => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="#333" text-anchor="middle" ${extra}>${s}</text>`;
const marker = (cx, cy) => {
  const inner = dict.generateSVG(ID).replace(/<\/?svg[^>]*>/g, '');
  const unit = SIZE / 8, half = unit * 5;
  const cut = half + 4;
  return `<rect x="${cx - cut}" y="${cy - cut}" width="${2 * cut}" height="${2 * cut}" fill="none" stroke="#999" stroke-width="0.3" stroke-dasharray="2 1.5"/>` +
    `<g transform="translate(${cx - half} ${cy - half}) scale(${unit})">${inner}</g>`;
};
let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}mm" height="${PH}mm" viewBox="0 0 ${PW} ${PH}"><rect width="${PW}" height="${PH}" fill="#fff"/>`;
s += text(PW / 2, 26, `경로 카드 (마커 ${ID})`, 9, 'font-weight="700"');
s += text(PW / 2, 35, `검은 사각형 한 변 ${SIZE / 10}cm · 실제 크기(100%)로 인쇄`, 4);
s += marker(60, 95) + marker(150, 95);
s += text(60, 140, '카드 1', 3.6, 'fill="#666"') + text(150, 140, '카드 2 (예비)', 3.6, 'fill="#666"');
const lines = [
  '쓰는 법 (AR 버전 · 경로 기록)',
  '1. 점선을 따라 자르고, 두꺼운 종이에 붙여 평평하게 만드세요. 흰 테두리는 남겨 두세요.',
  '2. AR에서 위치를 맞춘 뒤 [경로 기록]을 누르세요.',
  '3. 카드를 차가 달릴 차선의 가운데에 평평하게 놓고, 손을 뗀 채 40~60cm 거리에서 비추세요.',
  '4. 1초 그대로 두면 점이 찍혀요(화면에 "점 n 찍었어요"). 카드를 다음 자리로 옮기세요.',
  '   곡선은 5~10cm마다, 직선은 20~30cm마다. 차가 갈 방향 순서대로 한 바퀴.',
  '5. 한 바퀴 돌면 [완료·저장]. 잘못 찍힌 점은 [되돌리기].',
  '카드 방향은 상관없어요. 바리케이드 마커(10·11)·도로 마커와 헷갈리지 않는 번호(20)예요.',
];
lines.forEach((l, i) => { s += `<text x="24" y="${170 + i * 10}" font-family="${FONT}" font-size="${i === 0 ? 4.6 : 3.8}" fill="#333" ${i === 0 ? 'font-weight="700"' : ''}>${l}</text>`; });
s += '</svg>';
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/page-01.svg`, s);
console.log('card page ok');
