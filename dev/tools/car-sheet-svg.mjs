// 나만의 차 도안 (A4 가로) SVG. 치수는 src/car-template.js 하나만 따름
// fills: 시험용 색칠 { side, front, back, top, interior: 색 } (없으면 빈 도안)
import { createRequire } from 'node:module';
import { SHEET, MARKERS, MARKER_SIZE, REGIONS, PROFILE, INTERIOR, paperPoint, sideOutline } from '../src/car-template.js';

const { AR } = createRequire(import.meta.url)('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
export const FONT = '"Pretendard Variable", Pretendard, "Noto Sans CJK KR", sans-serif';

const f = (v) => +v.toFixed(2);
const text = (x, y, s, size, extra = '') => `<text x="${f(x)}" y="${f(y)}" font-family='${FONT}' font-size="${size}" fill="#333" text-anchor="middle" ${extra}>${s}</text>`;
function marker(m) {
  const inner = dict.generateSVG(m.id).replace(/<\/?svg[^>]*>/g, '');
  const unit = MARKER_SIZE / 8, half = unit * 5;
  return `<g transform="translate(${m.x - half} ${m.y - half}) scale(${unit})">${inner}</g>`;
}
const poly = (region, pts, attrs) => `<polygon points="${pts.map(([a, b]) => paperPoint(region, a, b).map(f).join(',')).join(' ')}" ${attrs}/>`;
const rectAB = (region, a0, b0, a1, b1, attrs, rx = 0) => {
  const [x0, y1] = paperPoint(region, a0, b0), [x1, y0] = paperPoint(region, a1, b1);
  return `<rect x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}" rx="${rx}" ${attrs}/>`;
};
const LINE = 'fill="none" stroke="#222" stroke-width="0.7" stroke-linejoin="round"';
const THIN = 'fill="none" stroke="#888" stroke-width="0.35" stroke-dasharray="1.6 1.2"';

export function carSheetSVG({ fills = null, title = true } = {}) {
  const R = REGIONS, P = PROFILE;
  const fill = (k) => (fills && fills[k] ? `fill="${fills[k]}"` : 'fill="#fff"');
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm" viewBox="0 0 ${SHEET.w} ${SHEET.h}"><rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>`;
  for (const m of MARKERS) s += marker(m);
  if (title) {
    s += text(SHEET.w / 2, 18, '도로 위의 상상 · 나만의 차 만들기', 7.5, 'font-weight="800" fill="#00448b"');
    s += text(SHEET.w / 2, 27, '선 안을 마음껏 색칠하고 꾸며요. 다 그리면 태블릿으로 네 모서리의 검은 표식이 모두 보이게 찍어요.', 3.6, 'fill="#4d5c6a"');
  }
  for (const k of Object.keys(R)) {
    const r = R[k];
    s += `<text x="${f(r.x)}" y="${f(r.y - 4)}" font-family='${FONT}' font-size="3.8" font-weight="700" fill="#00448b">${r.label}</text>`;
  }
  // 옆모습: 차체 + 지붕, 창문, 문, 바퀴(3D에서는 검은 바퀴가 따로 붙어요)
  const out = sideOutline();
  s += poly('side', out, `${fill('side')} ${LINE}`);
  const [r0, r1, f1, f0] = P.cabin;
  const wb = P.belt + 0.05, wt = P.roof - 0.07, k0 = (wb - P.belt) / (P.roof - P.belt), k1 = (wt - P.belt) / (P.roof - P.belt);
  const lerp = (u, v, t) => u + (v - u) * t;
  const ra = (t) => lerp(r0, r1, t) + 0.03, fa = (t) => lerp(f0, f1, t) - 0.03, pil = (r1 + f1) / 2;
  s += poly('side', [[ra(k0), wb], [pil - 0.012, wb], [pil - 0.012, wt], [ra(k1), wt]], THIN);
  s += poly('side', [[pil + 0.012, wb], [fa(k0), wb], [fa(k1), wt], [pil + 0.012, wt]], THIN);
  for (const a of [0.36, pil, 0.7]) s += `<path d="M ${paperPoint('side', a, P.sill + 0.04).map(f).join(' ')} L ${paperPoint('side', a, P.belt).map(f).join(' ')}" ${THIN}/>`;
  for (const a of P.wheels) {
    const [cx, cy] = paperPoint('side', a, P.wheelR);
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(P.wheelR * R.side.h)}" fill="#fff" stroke="#222" stroke-width="0.6"/>`;
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(P.wheelR * R.side.h * 0.45)}" ${THIN}/>`;
  }
  s += rectAB('side', 0.955, 0.38, 0.995, 0.46, THIN, 0.6) + rectAB('side', 0.005, 0.38, 0.04, 0.46, THIN, 0.6);
  // 앞·뒤: 차체 띠 (전조등·번호판 자리)
  s += rectAB('front', 0, 0, 1, 1, `${fill('front')} ${LINE}`, 1.2);
  s += rectAB('front', 0.06, 0.45, 0.24, 0.8, THIN, 1) + rectAB('front', 0.76, 0.45, 0.94, 0.8, THIN, 1) + rectAB('front', 0.32, 0.3, 0.68, 0.7, THIN, 0.6);
  s += rectAB('back', 0, 0, 1, 1, `${fill('back')} ${LINE}`, 1.2);
  s += rectAB('back', 0.05, 0.5, 0.25, 0.8, THIN, 1) + rectAB('back', 0.75, 0.5, 0.95, 0.8, THIN, 1) + rectAB('back', 0.36, 0.2, 0.64, 0.5, THIN, 0.4);
  // 위에서 본 모습: 차 전체 + 지붕·앞유리·뒷유리 자리
  const ci = P.cabinInset;
  s += rectAB('top', 0, 0, 1, 1, `${fill('top')} ${LINE}`, 3);
  s += rectAB('top', r1, ci, f1, 1 - ci, 'fill="none" stroke="#222" stroke-width="0.5"', 1.5);
  s += poly('top', [[f1, ci], [f0, ci], [f0, 1 - ci], [f1, 1 - ci]], THIN);
  s += poly('top', [[r0, ci], [r1, ci], [r1, 1 - ci], [r0, 1 - ci]], THIN);
  s += text(...paperPoint('top', (r1 + f1) / 2, 0.47), '지붕', 3.2, 'fill="#aaa"');
  s += text(...paperPoint('top', 0.9, 0.47), '보닛', 2.8, 'fill="#bbb"') + text(...paperPoint('top', 0.1, 0.47), '트렁크', 2.8, 'fill="#bbb"');
  // 실내: 바닥 + 좌석·계기판·운전대
  const I = INTERIOR;
  s += rectAB('interior', 0, 0, 1, 1, `${fill('interior')} ${LINE}`, 3);
  s += rectAB('interior', r0, P.wall, f0, 1 - P.wall, 'fill="none" stroke="#222" stroke-width="0.45"', 1.5);
  for (const st of I.seats) {
    s += rectAB('interior', st.a0, st.c0, st.a1, st.c1, 'fill="none" stroke="#222" stroke-width="0.5"', 1.6);
    s += `<path d="M ${paperPoint('interior', st.a0 + st.back, st.c0).map(f).join(' ')} L ${paperPoint('interior', st.a0 + st.back, st.c1).map(f).join(' ')}" fill="none" stroke="#222" stroke-width="0.4"/>`;
  }
  s += rectAB('interior', I.dash.a0, I.dash.c0, I.dash.a1, I.dash.c1, 'fill="none" stroke="#222" stroke-width="0.5"', 1);
  const [wx, wy] = paperPoint('interior', I.wheel.a, I.wheel.c);
  s += `<ellipse cx="${f(wx)}" cy="${f(wy)}" rx="${f(0.012 * R.interior.w)}" ry="${f(I.wheel.r * R.interior.h)}" fill="none" stroke="#222" stroke-width="0.5"/>`;
  s += text(...paperPoint('interior', 0.58, 0.69), '운전석', 2.6, 'fill="#aaa"');
  if (title) {
    s += text(SHEET.w / 2, 186, '검은 네모 표식 4개는 칠하거나 가리지 마세요 · 굵은 선 밖은 차에 쓰이지 않아요', 3.4, 'fill="#4d5c6a"');
    s += text(SHEET.w / 2, 193, '앞모습은 차 앞(전조등), 뒷모습은 차 뒤(브레이크등)예요 · 위에서 본 모습의 위쪽이 차의 왼쪽이에요', 3.0, 'fill="#7d8a96"');
  }
  // 시험용 색칠: 칸 안을 채움 (실제 아이 그림 대신)
  if (fills && fills.scribble) s += fills.scribble;
  return s + '</svg>';
}
