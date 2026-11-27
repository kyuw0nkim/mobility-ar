// 디오라마용 도로 마커(검은 사각형 8cm, 한 장에 1개) + 바리케이드 마커 PDF용 SVG 생성
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const FONT = 'Noto Sans CJK KR, sans-serif';
const PW = 210, PH = 297; // A4 세로 (mm)
// 사용: node tools/make-markers.mjs [출력 폴더] [도로 마커 id 목록(쉼표)] [bar=0이면 바리케이드 쪽 빼기]
// 도로 마커 크기는 환경변수 ROAD_MM(기본 80mm)
// 도로 마커 18개: 가로 변 4개씩 + 세로 변 5개씩. 10·11은 바리케이드 전용이라 건너뜀
const OUT = process.argv[2] || 'dist/markers';
const ROAD_IDS = process.argv[3] ? process.argv[3].split(',').map(Number) : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19];
const WITH_BAR = process.argv[4] !== 'bar=0';
const ROAD_SIZE = +(process.env.ROAD_MM || 80); // 검은 사각형 한 변 (mm)
const BAR_IDS = [10, 11];
const BAR_SIZE = 30;

// 마커 전체(흰 여백 포함 10단위) 배치. size = 검은 사각형 한 변(mm)
function marker(id, cx, cy, size) {
  const inner = dict.generateSVG(id).replace(/<\/?svg[^>]*>/g, '');
  const unit = size / 8;
  const half = unit * 5;
  return `<g transform="translate(${cx - half} ${cy - half}) scale(${unit})">${inner}</g>`;
}
const text = (x, y, s, size = 4, opts = '') => {
  const fill = /fill=/.test(opts) ? '' : 'fill="#333"';
  const fam = /font-family=/.test(opts) ? '' : `font-family="${FONT}"`;
  return `<text x="${x}" y="${y}" ${fam} font-size="${size}" ${fill} text-anchor="middle" ${opts}>${s}</text>`;
};

// 자르는 선(흰 여백 바깥), 중심 표시, 위쪽 화살표
function guides(cx, cy, size, { arrow = true } = {}) {
  const q = (size * 10) / 8 / 2; // 흰 여백 포함 절반
  const cut = q + Math.max(3, size * 0.05);
  let s = `<rect x="${cx - cut}" y="${cy - cut}" width="${2 * cut}" height="${2 * cut}" fill="none" stroke="#999" stroke-width="0.3" stroke-dasharray="2 1.5"/>`;
  const t = Math.max(3, size * 0.06);
  // 각 변 가운데 중심 표시 (자르는 선 바깥)
  s += `<path d="M ${cx} ${cy - cut - 1} v ${-t} M ${cx} ${cy + cut + 1} v ${t} M ${cx - cut - 1} ${cy} h ${-t} M ${cx + cut + 1} ${cy} h ${t}" stroke="#e2453c" stroke-width="0.5"/>`;
  if (arrow) {
    const ay = cy - cut - 12;
    s += `<path d="M ${cx - 9} ${ay - 2} L ${cx} ${ay - 7} L ${cx + 9} ${ay - 2}" fill="none" stroke="#333" stroke-width="0.6"/>`;
  }
  return s;
}

function ruler(cx, y) {
  let s = `<path d="M ${cx - 50} ${y} H ${cx + 50}" stroke="#222" stroke-width="0.5"/>`;
  for (let i = 0; i <= 10; i++) s += `<path d="M ${cx - 50 + i * 10} ${y} v ${i % 5 ? -2 : -4}" stroke="#222" stroke-width="0.4"/>`;
  s += text(cx, y + 5, '10cm — 인쇄 후 자로 확인', 3.4);
  return s;
}

const pages = [];
for (const id of ROAD_IDS) {
  const cx = PW / 2, cy = 140;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}mm" height="${PH}mm" viewBox="0 0 ${PW} ${PH}"><rect width="${PW}" height="${PH}" fill="#fff"/>`;
  s += text(cx, 24, `도로 마커 ${id}`, 9, 'font-weight="700"');
  s += text(cx, 33, `검은 사각형 한 변 ${ROAD_SIZE / 10}cm · 실제 크기(100%)로 인쇄`, 4);
  s += text(cx, 47, "이 화살표 쪽이 마커의 위쪽", 3.4, 'fill="#666"');
  s += marker(id, cx, cy, ROAD_SIZE);
  s += guides(cx, cy, ROAD_SIZE);
  s += ruler(cx, 232);
  s += text(cx, 252, '점선을 따라 자르세요. 흰 테두리는 남겨 두세요 (인식에 필요해요).', 3.6);
  s += text(cx, 259, '위치는 앱의 [마커 지도 만들기]가 자동으로 재요. 따로 잴 필요는 없어요.', 3.6);
  s += text(cx, 266, '마커를 붙이거나 옮긴 뒤에는 [마커 지도 만들기] → [경로 기록]을 다시 해 주세요.', 3.6);
  s += text(cx, 273, '구겨지거나 빛이 반사되지 않게, 도로면과 같은 높이에 평평하게 붙이세요.', 3.6);
  s += `</svg>`;
  pages.push(s);
}

// 바리케이드 마커 페이지
if (WITH_BAR) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}mm" height="${PH}mm" viewBox="0 0 ${PW} ${PH}"><rect width="${PW}" height="${PH}" fill="#fff"/>`;
  s += text(PW / 2, 24, '바리케이드 마커 10 · 11', 9, 'font-weight="700"');
  s += text(PW / 2, 33, `검은 사각형 한 변 ${BAR_SIZE / 10}cm · 실제 크기(100%)로 인쇄`, 4);
  const xs = [60, 150];
  BAR_IDS.forEach((id, i) => {
    const cy = 80;
    s += marker(id, xs[i], cy, BAR_SIZE);
    s += guides(xs[i], cy, BAR_SIZE);
    s += text(xs[i], cy + 34, i === 0 ? `마커 ${id} · 패널 앞면 가운데` : `마커 ${id} · 패널 뒷면 가운데`, 3.8);
  });
  s += text(PW / 2, 140, '레고 바리케이드 노랑·검정 패널의 앞뒤 가운데에, 화살표(위쪽)가 하늘을 향하게 붙이세요.', 3.6);
  s += text(PW / 2, 147, '설정의 barricade.width는 바리케이드가 바닥에서 도로를 막는 실제 폭(cm)으로 바꾸세요.', 3.6);
  s += ruler(PW / 2, 175);
  s += `</svg>`;
  pages.push(s);
}

mkdirSync(OUT, { recursive: true });
pages.forEach((s, i) => writeFileSync(`${OUT}/page-${String(i + 1).padStart(2, '0')}.svg`, s));
console.log(pages.length, 'pages');
