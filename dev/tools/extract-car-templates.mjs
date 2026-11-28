// 차 도안 PDF(6쪽: PBV·로보택시·배송 트럭 × ①겉모습·②앞뒤와 실내)에서 앱이 쓰는 치수를 뽑는다
//  → src/car-templates.js (종이 mm 좌표: 표식, 실루엣, 창문·지붕 띠, 바퀴, 이름 칸, 앞·뒤 모습, 지붕 색 칸, 실내 칸)
//  → assets/car-<차>-<쪽>.png (빈 도안 그림, 4px/mm: 스캔하지 않은 쪽의 기본 그림)
// 사용: node tools/extract-car-templates.mjs [원본 PDF] [인쇄용 PDF]   (pdftocairo·pdftotext·pdftoppm 필요)
//  치수는 원본(sheet-src/차도안-원본.pdf)에서 읽고 바꾼 것(car-sheet-edits.mjs: 이름 칸)을 반영,
//  빈 도안 그림은 인쇄용(../RAIM-AR-차도안.pdf, edit-car-sheet.mjs가 만듦)에서
// 도안을 바꾸면: node tools/edit-car-sheet.mjs && node tools/extract-car-templates.mjs && npm run publish-site
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NAME_BOX } from './car-sheet-edits.mjs';
const PDF = process.argv[2] || 'sheet-src/차도안-원본.pdf';
const PRINT_PDF = process.argv[3] || '../RAIM-AR-차도안.pdf';
const tmp = mkdtempSync(join(tmpdir(), 'cartpl-'));
const PT = 25.4 / 72;
const r2 = (v) => Math.round(v * 100) / 100;

// 쪽 순서 = 도안 PDF 순서. 표식 번호: 쪽마다 4개(왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래 = 기준 +0~3)
const PAGES = [
  { vehicle: 'pbv', page: 'ext', base: 200 }, { vehicle: 'pbv', page: 'int', base: 204 },
  { vehicle: 'taxi', page: 'ext', base: 208 }, { vehicle: 'taxi', page: 'int', base: 212 },
  { vehicle: 'truck', page: 'ext', base: 224 }, { vehicle: 'truck', page: 'int', base: 228 },
];
const VEHICLES = {
  pbv: { name: 'PBV', both: true, roof: '#2a3444' }, // 앞뒤 구분 없음
  taxi: { name: '로보택시', both: false, roof: '#f5b700' },
  truck: { name: '배송 트럭', both: false, roof: '#3aa655' },
};

const col = (s) => {
  if (!s || s === 'none') return null;
  const m = s.match(/rgb\(([\d.]+)%,\s*([\d.]+)%,\s*([\d.]+)%\)/);
  return m ? [1, 2, 3].map((i) => Math.round(+m[i] * 2.55)) : null;
};
const same = (a, b, tol = 6) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const NAVY = [42, 52, 68], GLASS = [159, 179, 200], GREY = [138, 145, 155], TIRE = [68, 68, 68], HUB = [204, 204, 204], INK = [34, 34, 34], ORANGE = [224, 168, 0], BLACK = [0, 0, 0], WHITE = [255, 255, 255];

function parseD(d, M) {
  const subs = []; let cur = null;
  const tok = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/g);
  let i = 0, cmd = null;
  const pt = (x, y) => { const X = M ? M[0] * x + M[2] * y + M[4] : x, Y = M ? M[1] * x + M[3] * y + M[5] : y; return [X * PT, Y * PT]; };
  while (i < tok.length) {
    if (/[MLCZ]/.test(tok[i])) { cmd = tok[i++]; if (cmd === 'Z') { cur = null; continue; } }
    if (cmd === 'M') { cur = []; subs.push(cur); cur.push(pt(+tok[i], +tok[i + 1])); i += 2; cmd = 'L'; } else if (cmd === 'L') { cur.push(pt(+tok[i], +tok[i + 1])); i += 2; } else if (cmd === 'C') {
      // 베지어: 끝점만 다각형으로, 조절점은 외곽 상자 계산에만
      const p0 = cur[cur.length - 1];
      const ps = [0, 2, 4].map((k) => pt(+tok[i + k], +tok[i + k + 1]));
      for (let t = 1; t <= 6; t++) {
        const u = t / 6, a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, e = u ** 3;
        cur.push([a * p0[0] + b * ps[0][0] + c * ps[1][0] + e * ps[2][0], a * p0[1] + b * ps[0][1] + c * ps[1][1] + e * ps[2][1]]);
      }
      i += 6;
    } else i++;
  }
  return subs.filter((s) => s.length);
}
const bboxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
};
const isect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const R = (b) => b.map(r2);

function parsePage(svg) {
  const clips = {};
  for (const m of svg.matchAll(/<clipPath id="([^"]+)">\s*<path[^>]* d="([^"]*)"/g)) clips[m[1]] = parseD(m[2])[0];
  const body = svg.slice(svg.indexOf('</defs>'));
  const els = []; const stack = [];
  for (const m of body.matchAll(/<(\/?)(g|path)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m;
    if (tag === 'g') { if (close) stack.pop(); else if (!selfClose) stack.push(attrs); continue; }
    const at = (k) => { const r = attrs.match(new RegExp(`\\b${k}="([^"]*)"`)); return r ? r[1] : null; };
    const inh = (k) => { for (let i = stack.length - 1; i >= 0; i--) { const r = stack[i].match(new RegExp(`\\b${k}="([^"]*)"`)); if (r) return r[1]; } return null; };
    const d = at('d'); if (!d) continue;
    const tr = at('transform'); const M = tr ? tr.match(/matrix\(([^)]*)\)/)[1].split(/[ ,]+/).map(Number) : null;
    const clipIds = stack.map((s) => (s.match(/clip-path="url\(#([^)]+)\)"/) || [])[1]).filter(Boolean);
    const subs = parseD(d, M);
    const pts = subs.flat();
    els.push({ fill: col(at('fill') || inh('fill')), stroke: col(at('stroke')), sw: (+(at('stroke-width') || 0)) * PT * (M ? M[0] : 1), dash: !!at('stroke-dasharray'), subs, bb: bboxOf(pts), clips: clipIds.map((c) => clips[c]) });
  }
  return els;
}

function lines(html, pageNo) {
  const page = html.split('<page ')[pageNo];
  return [...page.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/line>/gs)].map((m) => ({
    bb: [+m[1] * PT, +m[2] * PT, +m[3] * PT, +m[4] * PT], text: [...m[5].matchAll(/>([^<]+)<\/word>/g)].map((w) => w[1]).join(' '),
  }));
}

// 다각형 고르게 다시 찍기 (실루엣: 3D 압출용)
function resample(poly, n) {
  const P = poly.slice();
  if (Math.hypot(P[0][0] - P.at(-1)[0], P[0][1] - P.at(-1)[1]) < 1e-6) P.pop();
  const seg = P.map((p, i) => Math.hypot(P[(i + 1) % P.length][0] - p[0], P[(i + 1) % P.length][1] - p[1]));
  const total = seg.reduce((a, b) => a + b, 0), out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * total;
    while (acc + seg[i] < t) { acc += seg[i]; i++; }
    const u = seg[i] ? (t - acc) / seg[i] : 0, a = P[i], b = P[(i + 1) % P.length];
    out.push([r2(a[0] + (b[0] - a[0]) * u), r2(a[1] + (b[1] - a[1]) * u)]);
  }
  return out;
}

execFileSync('pdftotext', ['-bbox-layout', PDF, join(tmp, 'bbox.html')]);
const bboxHtml = readFileSync(join(tmp, 'bbox.html'), 'utf8');
const out = { pbv: {}, taxi: {}, truck: {} };
const markersFor = (els, base) => {
  const sq = els.filter((e) => same(e.fill, BLACK, 1) && e.bb[2] - e.bb[0] > 10 && e.bb[2] - e.bb[0] < 14).map((e) => e.bb);
  const order = [(b) => b[0] < 105 && b[1] < 148, (b) => b[0] > 105 && b[1] < 148, (b) => b[0] > 105 && b[1] > 148, (b) => b[0] < 105 && b[1] > 148];
  return order.map((f, k) => { const b = sq.find(f); return { id: base + k, c: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map((p) => p.map(r2)) }; });
};
PAGES.forEach((pg, idx) => {
  const n = idx + 1;
  execFileSync('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), PDF, join(tmp, `p${n}.svg`)]);
  execFileSync('pdftoppm', ['-r', '101.6', '-f', String(n), '-l', String(n), '-png', '-singlefile', PRINT_PDF, join(tmp, `p${n}`)]);
  copyFileSync(join(tmp, `p${n}.png`), `assets/car-${pg.vehicle}-${pg.page}.png`);
  const els = parsePage(readFileSync(join(tmp, `p${n}.svg`), 'utf8'));
  const txt = lines(bboxHtml, n);
  const T = (re) => txt.filter((l) => re.test(l.text)).map((l) => R(l.bb));
  const spec = { markers: markersFor(els, pg.base) };
  if (pg.page === 'ext') {
    const nameBox = els.find((e) => e.stroke && same(e.stroke, ORANGE) && e.dash && e.bb[2] - e.bb[0] > 120);
    const half = (nameBox.bb[2] - nameBox.bb[0] - 150) / 2; // 테두리 두께 절반 (원본 칸 150mm)
    spec.nameBox = R([NAME_BOX.x0 - half, nameBox.bb[1], NAME_BOX.x1 + half, nameBox.bb[3]]);
    spec.namePlaceholder = T(/크고 진하게/)[0];
    const outlines = els.filter((e) => e.stroke && same(e.stroke, INK) && !e.fill && e.sw > 0.6 && e.bb[2] - e.bb[0] > 100).sort((a, b) => a.bb[1] - b.bb[1]);
    spec.sides = outlines.map((o, k) => {
      const ob = o.bb, inSide = (e) => { const cy = (e.bb[1] + e.bb[3]) / 2; return cy > ob[1] - 12 && cy < ob[3] + 14; };
      const mine = els.filter(inSide);
      const clipped = (c) => mine.filter((e) => e.fill && same(e.fill, c) && e.clips.length).map((e) => R(e.clips.reduce((b, cp) => (cp.length > 5 ? b : isect(b, bboxOf(cp))), e.bb)));
      const sil = mine.find((e) => e.clips.some((cp) => cp.length > 20)).clips.find((cp) => cp.length > 20);
      const circles = (c) => mine.filter((e) => e.fill && same(e.fill, c) && !e.clips.length && Math.abs((e.bb[2] - e.bb[0]) - (e.bb[3] - e.bb[1])) < 1.5)
        .map((e) => ({ cx: r2((e.bb[0] + e.bb[2]) / 2), cy: r2((e.bb[1] + e.bb[3]) / 2), r: r2((e.bb[2] - e.bb[0]) / 2) })).sort((a, b) => a.cx - b.cx);
      const sensor = mine.find((e) => e.fill && same(e.fill, NAVY) && !e.clips.length);
      const divider = mine.find((e) => e.stroke && same(e.stroke, INK) && !e.fill && e.bb[2] - e.bb[0] < 1 && e.bb[3] - e.bb[1] > 20);
      const slot = mine.find((e) => e.stroke && same(e.stroke, ORANGE) && e.dash);
      const tl = (re) => txt.filter((l) => re.test(l.text) && (l.bb[1] + l.bb[3]) / 2 > ob[1] - 2 && (l.bb[1] + l.bb[3]) / 2 < ob[3] + 2).map((l) => R(l.bb));
      return {
        side: k === 0 ? 'right' : 'left',
        bbox: R(ob), ground: r2(Math.max(...circles(TIRE).map((c) => c.cy + c.r))),
        silhouette: resample(sil, 220),
        roof: clipped(NAVY), window: clipped(GLASS), pillar: clipped(WHITE).filter((b) => b[2] - b[0] < 12), lower: clipped(GREY),
        tires: circles(TIRE), hubs: circles(HUB),
        sensor: sensor ? R(sensor.bb) : null, divider: divider ? r2((divider.bb[0] + divider.bb[2]) / 2) : null,
        nameSlot: R(slot.bb), hint: tl(/자유롭게/), labels: [...tl(/^창문/), ...tl(/들어갈 자리/)],
      };
    });
  } else {
    const views = els.filter((e) => e.stroke && same(e.stroke, INK) && !e.fill && e.sw > 0.5 && e.bb[3] - e.bb[1] > 30 && e.bb[2] - e.bb[0] < 70).sort((a, b) => a.bb[0] - b.bb[0]);
    spec.views = views.map((v, k) => {
      const vb = v.bb, inV = (e) => { const cx = (e.bb[0] + e.bb[2]) / 2, cy = (e.bb[1] + e.bb[3]) / 2; return cx > vb[0] - 1 && cx < vb[2] + 1 && cy > vb[1] - 1 && cy < vb[3] + 1; };
      const mine = els.filter(inV);
      const band = (c) => mine.filter((e) => e.fill && same(e.fill, c) && e.clips.length).map((e) => R(e.clips.reduce((b, cp) => isect(b, bboxOf(cp)), e.bb)));
      return { view: k === 0 ? 'front' : 'back', bbox: R(vb), roof: band(NAVY), window: band(GLASS), lower: band(GREY) };
    });
    spec.swatches = els.filter((e) => e.fill && e.stroke && Math.abs(e.bb[2] - e.bb[0] - 9) < 1 && e.bb[0] > 150 && e.bb[1] < 100).map((e) => {
      const cx = (e.bb[0] + e.bb[2]) / 2, cy = (e.bb[1] + e.bb[3]) / 2;
      const box = els.find((b) => !b.fill && b.stroke && Math.abs(b.bb[2] - b.bb[0] - 5) < 0.6 && Math.abs((b.bb[1] + b.bb[3]) / 2 - cy) < 1 && b.bb[0] > cx && b.bb[0] < cx + 12);
      return { color: hex(e.fill), circle: R(e.bb), box: R(box.bb) };
    });
    const inter = els.filter((e) => e.fill && e.stroke && same(e.stroke, INK) && e.bb[2] - e.bb[0] > 50 && e.bb[1] > 100 && e.bb[3] < 230).sort((a, b) => (b.bb[2] - b.bb[0]) - (a.bb[2] - a.bb[0]));
    spec.interior = R(inter[0].bb);
    spec.frontRoom = inter[1] ? R(inter[1].bb) : null; // 배송 트럭: 앞칸(센서·컴퓨터)
    spec.hints = T(/짐칸 윗부분|짐칸 문/); // 앞·뒤 모습 위의 연한 안내 글씨 (3D에서는 지움)
  }
  out[pg.vehicle][pg.page] = spec;
  console.log(`쪽 ${n} ${pg.vehicle}/${pg.page} 표식 ${spec.markers.map((m) => m.id).join(',')}${spec.sides ? ` 옆 ${spec.sides.length} (바퀴 ${spec.sides.map((s) => s.tires.length).join('/')}, 창 ${spec.sides.map((s) => s.window.length).join('/')}, 지붕 ${spec.sides.map((s) => s.roof.length).join('/')})` : ` 앞뒤 ${spec.views.length} 색 ${spec.swatches.length}`}`);
});
for (const k of Object.keys(out)) Object.assign(out[k], VEHICLES[k]);
const js = `// 자동 생성: node tools/extract-car-templates.mjs (도안 PDF → 치수). 손으로 고치지 마세요.
// 단위: 종이 mm (A4 세로 210×297, 원점 왼쪽 위, y 아래쪽). 쪽: ext = ① 겉모습, int = ② 앞·뒤와 실내
export const PAPER = { w: 210, h: 297 };
export const CAR_TEMPLATES = ${JSON.stringify(out)};
`;
writeFileSync('src/car-templates.js', js);
console.log('src/car-templates.js', (js.length / 1024).toFixed(0) + ' KB');
