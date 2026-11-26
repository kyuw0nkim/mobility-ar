// A4 테스트 시트(도로 + 도로 마커)와 미니 바리케이드 접이식 도안 생성
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DEFAULT_CONFIG, ROAD, SHEET } from '../src/config.js';

const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const FONT = "Noto Sans CJK KR, sans-serif";

// 마커 SVG 내부(10x10 단위)를 mm 크기로 배치. sizeCm = 검은 사각형 한 변.
function markerGroup(id, cxMm, cyMm, sizeCm, rotDeg = 0) {
  const inner = dict.generateSVG(id).replace(/<\/?svg[^>]*>/g, '');
  const unit = (sizeCm * 10) / 8; // mm per unit
  const half = unit * 5;
  return `<g transform="translate(${cxMm} ${cyMm}) rotate(${rotDeg}) translate(${-half} ${-half}) scale(${unit})">${inner}</g>`;
}

// ---------- 1쪽: 도로 시트 (A4 가로) ----------
const W = SHEET.width * 10, H = SHEET.height * 10; // mm
const X = (x) => x * 10, Y = (y) => H - y * 10;
let s1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`;
s1 += `<rect width="${W}" height="${H}" fill="#fff"/>`;
// 도로
const rx = X(ROAD.x0), ry = Y(ROAD.y1), rw = (ROAD.x1 - ROAD.x0) * 10, rh = (ROAD.y1 - ROAD.y0) * 10, rr = ROAD.r * 10;
const lw = ROAD.laneWidth * 10;
s1 += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${rr}" fill="none" stroke="#5a606a" stroke-width="${lw}"/>`;
s1 += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${rr}" fill="none" stroke="#fff" stroke-width="0.8" stroke-dasharray="5 4"/>`;
for (const d of [-1, 1]) {
  const o = d * (lw / 2 - 2);
  s1 += `<rect x="${rx - o}" y="${ry - o}" width="${rw + 2 * o}" height="${rh + 2 * o}" rx="${Math.max(1, rr + o)}" fill="none" stroke="#fff" stroke-width="0.8"/>`;
}
// 진행 방향 화살표 (아래쪽 직선 구간, 오른쪽으로)
const ay = Y(ROAD.y0), axm = X((ROAD.x0 + ROAD.x1) / 2);
s1 += `<path d="M ${axm - 12} ${ay} H ${axm + 8}" stroke="#ffd400" stroke-width="2.2"/><path d="M ${axm + 8} ${ay - 4} L ${axm + 15} ${ay} L ${axm + 8} ${ay + 4} Z" fill="#ffd400"/>`;
// 마커
for (const m of DEFAULT_CONFIG.roadMarkers) {
  s1 += markerGroup(m.id, X(m.x), Y(m.y), m.size, -(m.rot || 0));
  const below = m.y < SHEET.height / 2;
  s1 += `<text x="${X(m.x) + (m.x < SHEET.width / 2 ? 22 : -22)}" y="${Y(m.y) + 2}" font-family="${FONT}" font-size="4" fill="#888" text-anchor="${m.x < SHEET.width / 2 ? 'start' : 'end'}">${m.id}</text>`;
  void below;
}
// 안내 문구 (도로 안쪽)
const cx = X((ROAD.x0 + ROAD.x1) / 2), cy = Y((ROAD.y0 + ROAD.y1) / 2);
s1 += `<text x="${cx}" y="${cy - 14}" font-family="${FONT}" font-size="6" font-weight="700" fill="#222" text-anchor="middle">RAIM AR 자율주행 · 마커 테스트 시트</text>`;
s1 += `<text x="${cx}" y="${cy - 5}" font-family="${FONT}" font-size="3.6" fill="#555" text-anchor="middle">실제 크기(100%)로 인쇄하세요. 아래 선이 정확히 10cm여야 해요.</text>`;
s1 += `<path d="M ${cx - 50} ${cy + 4} H ${cx + 50} M ${cx - 50} ${cy + 1} V ${cy + 7} M ${cx + 50} ${cy + 1} V ${cy + 7}" stroke="#222" stroke-width="0.6"/>`;
s1 += `<text x="${cx}" y="${cy + 12}" font-family="${FONT}" font-size="3.4" fill="#555" text-anchor="middle">10cm</text>`;
s1 += `<text x="${cx}" y="${cy + 21}" font-family="${FONT}" font-size="3.4" fill="#555" text-anchor="middle">평평한 책상에 테이프로 고정 · 마커가 접히거나 가려지지 않게</text>`;
s1 += `</svg>`;

// ---------- 2쪽: 미니 바리케이드 (A4 세로) ----------
const PW = 210, PH = 297;
const bw = DEFAULT_CONFIG.barricade.width * 10; // 100mm
const face = 55, flap = 12;
const left = (PW - bw) / 2, top = 40;
const ids = DEFAULT_CONFIG.barricade.markerIds;
const msize = DEFAULT_CONFIG.barricade.markerSize;
let s2 = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}mm" height="${PH}mm" viewBox="0 0 ${PW} ${PH}">`;
s2 += `<rect width="${PW}" height="${PH}" fill="#fff"/>`;
s2 += `<defs><pattern id="st" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#f5c400"/><rect width="7" height="14" fill="#111"/></pattern></defs>`;
s2 += `<text x="${PW / 2}" y="18" font-family="${FONT}" font-size="6" font-weight="700" fill="#222" text-anchor="middle">미니 바리케이드 (책상 시험용)</text>`;
s2 += `<text x="${PW / 2}" y="27" font-family="${FONT}" font-size="3.6" fill="#555" text-anchor="middle">바깥 실선을 자르고, 점선을 산 모양으로 접어 텐트처럼 세운 뒤 양쪽 날개를 바닥에 테이프로 붙이세요.</text>`;
const y0 = top, yA = y0 + flap, yFold = yA + face, yB = yFold + face, yEnd = yB + flap;
// 날개
s2 += `<rect x="${left}" y="${y0}" width="${bw}" height="${flap}" fill="#eee" stroke="#000" stroke-width="0.4"/>`;
s2 += `<rect x="${left}" y="${yB}" width="${bw}" height="${flap}" fill="#eee" stroke="#000" stroke-width="0.4"/>`;
s2 += `<text x="${left + bw / 2}" y="${y0 + 8}" font-family="${FONT}" font-size="3.4" fill="#666" text-anchor="middle">날개 (바닥에 테이프)</text>`;
s2 += `<text x="${left + bw / 2}" y="${yB + 8}" font-family="${FONT}" font-size="3.4" fill="#666" text-anchor="middle">날개 (바닥에 테이프)</text>`;
// 두 면: 줄무늬 + 가운데 흰 영역 + 마커
const quiet = (msize * 10 * 10) / 8 + 8; // 마커 전체 + 여백
for (const [i, yy] of [[0, yA], [1, yFold]]) {
  s2 += `<rect x="${left}" y="${yy}" width="${bw}" height="${face}" fill="url(#st)" stroke="#000" stroke-width="0.4"/>`;
  const mcx = left + bw / 2, mcy = yy + face / 2;
  s2 += `<rect x="${mcx - quiet / 2}" y="${mcy - quiet / 2}" width="${quiet}" height="${quiet}" fill="#fff"/>`;
  // 앞면(A)은 접으면 위아래가 뒤집히므로 180도 회전해서 인쇄
  s2 += markerGroup(ids[i], mcx, mcy, msize, i === 0 ? 180 : 0);
}
// 접는 선
for (const yy of [yA, yFold, yB]) s2 += `<path d="M ${left - 6} ${yy} H ${left + bw + 6}" stroke="#000" stroke-width="0.4" stroke-dasharray="2 2"/>`;
s2 += `<text x="${left + bw + 8}" y="${yFold + 1.5}" font-family="${FONT}" font-size="3.2" fill="#000">← 꼭대기 (산 접기)</text>`;
s2 += `<text x="${PW / 2}" y="${yEnd + 16}" font-family="${FONT}" font-size="3.6" fill="#555" text-anchor="middle">세웠을 때 바닥 폭 ${bw / 10}cm · 앞면 마커 ${ids[0]}, 뒷면 마커 ${ids[1]} · 검은 사각형 ${msize}cm</text>`;
s2 += `<text x="${PW / 2}" y="${yEnd + 24}" font-family="${FONT}" font-size="3.6" fill="#555" text-anchor="middle">전시관의 레고 바리케이드에는 앱 [설정 → 마커 인쇄]로 뽑은 마커 ${ids[0]}·${ids[1]}을 패널 앞뒤 가운데에 붙이세요.</text>`;
s2 += `</svg>`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/sheet-road.svg', s1);
writeFileSync('dist/sheet-barricade.svg', s2);
console.log('ok');
