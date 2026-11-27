// 전시 디오라마를 본뜬 가상 장면 (사진 2장 참고, 단위 cm, 도로 좌표: x 오른쪽, y 안쪽(뒤), z 위)
//  - 테이블 480 x 190, 흰 바닥. 경기장 모양 고리 도로(흰 가장자리까지 30, 검은 차로 바깥 끝끼리 24):
//    흰 가장자리 3 + 검은 차로 11 + 흰 중앙선 2 + 검은 차로 11 + 흰 가장자리 3 (실측값)
//  - 뒤쪽 직선 가운데가 안쪽으로 12cm 구불(S), 오른쪽 끝 안쪽은 어두운 회색 광장(흰 가장자리 없음)
//  - 고리 안쪽: 흰 화살표(≫)가 그려진 검은 직선 도로, 회색 골목, 어두운 주차장(흰 칸 선)과 파란 띠, 나무(초록 점), 이음매(검은 줄)
//  - 세운 물체: 돔(구), 탑, 오른쪽 끝 도로를 가로지르는 게이트, 앞 도로 중앙선 위에 놓인 검은 레고 차
//  - 마커 6개(8cm, 흰 테두리)를 테이블 가장자리에
//  - 천장 조명(긴 LED 줄)이 검은 노면에 비치는 반사(보는 위치에 따라 움직임)
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
const { AR } = createRequire(import.meta.url)('js-aruco2');

export const TABLE = { w: 480, h: 190 };
export const ROAD = { half: 15, black: 12, center: 1 }; // 중앙선 반폭 1, 차로 1~12, 가장자리 12~15
const E1 = 95, E2 = 385, CY = 95, R = 63; // 양 끝 반원 중심·반지름 (앞 직선 y=32, 뒤 직선 y=158)
const wig = (x) => (x > 170 && x < 310 ? -12 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (x - 170)) / 140)) : 0);
const wigD = (x) => (x > 170 && x < 310 ? -12 * 0.5 * Math.sin((2 * Math.PI * (x - 170)) / 140) * ((2 * Math.PI) / 140) : 0);

// 중앙선까지의 부호 거리 (+ 고리 바깥)
export function centerDist(x, y) {
  if (x < E1) return Math.hypot(x - E1, y - CY) - R;
  if (x > E2) return Math.hypot(x - E2, y - CY) - R;
  if (y < CY) return 32 - y;
  const yc = 158 + wig(x);
  return (y - yc) / Math.sqrt(1 + wigD(x) ** 2);
}
// 정답 중앙선 (반시계, 0.5cm 간격 근처)
export function truthLoop(step = 0.5) {
  const pts = [];
  for (let x = E1; x < E2; x += step) pts.push([x, 32]);
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += step / R) pts.push([E2 + R * Math.cos(a), CY + R * Math.sin(a)]);
  for (let x = E2; x > E1; x -= step) pts.push([x, 158 + wig(x)]);
  for (let a = Math.PI / 2; a < (3 * Math.PI) / 2; a += step / R) pts.push([E1 + R * Math.cos(a), CY + R * Math.sin(a)]);
  return pts;
}

// 마커 (8cm, 테이블 가장자리 흰 바닥)
export const MARKERS = [
  { id: 0, x: 30, y: 8, rot: 0 }, { id: 1, x: 240, y: 8, rot: 0 }, { id: 2, x: 450, y: 8, rot: 0 },
  { id: 3, x: 450, y: 182, rot: 180 }, { id: 4, x: 240, y: 182, rot: 180 }, { id: 5, x: 30, y: 182, rot: 180 },
].map((m) => ({ ...m, size: 8 }));
const markerTex = new Map();
for (const m of MARKERS) {
  const r = new Resvg(new AR.Dictionary('ARUCO_MIP_36h12').generateSVG(m.id), { fitTo: { mode: 'width', value: 120 } }).render();
  markerTex.set(m.id, { w: r.width, h: r.height, data: r.pixels });
}
function markerAt(x, y) {
  for (const m of MARKERS) {
    const half = (m.size * 10) / 8 / 2; // 흰 테두리 포함
    const dx = x - m.x, dy = y - m.y;
    if (Math.abs(dx) > half * 1.5 || Math.abs(dy) > half * 1.5) continue;
    const a = (-m.rot * Math.PI) / 180, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) > half || Math.abs(ly) > half) continue;
    const t = markerTex.get(m.id);
    const u = (lx + half) / (2 * half), v = (half - ly) / (2 * half);
    const i = (Math.min(t.h - 1, Math.floor(v * t.h)) * t.w + Math.min(t.w - 1, Math.floor(u * t.w))) * 4;
    return [t.data[i], t.data[i + 1], t.data[i + 2]];
  }
  return null;
}

const WHITE = [236, 236, 232], BLACK = [38, 38, 42], BASE = [224, 225, 222], PLAZA = [72, 72, 76];
// 바닥 그림 (x, y) → [r,g,b]
export function groundColor(x, y) {
  if (x < 0 || y < 0 || x > TABLE.w || y > TABLE.h) return [150, 150, 155]; // 테이블 테두리 밖(바닥)
  const mk = markerAt(x, y);
  if (mk) return mk;
  const d = centerDist(x, y), ad = Math.abs(d);
  const rightPlaza = x > 375 && d < -ROAD.black && !(y > 118 && x < 400);
  // 이음매: 앞 도로를 가로지르는 검은 줄
  if ((Math.abs(x - 160) < 0.4 || Math.abs(x - 320) < 0.4) && y < 50) return [25, 25, 28];
  if (ad < ROAD.center) return WHITE;
  if (ad < ROAD.black) return BLACK;
  if (ad < ROAD.half) return rightPlaza ? PLAZA : WHITE;
  if (rightPlaza) return PLAZA;
  if (d > 0) return BASE; // 고리 바깥: 흰 바닥
  // ---- 고리 안쪽 ----
  // 화살표(≫) 도로: y 108~122, x 120~300
  if (y > 108 && y < 122 && x > 120 && x < 300) {
    const u = ((x - 120) % 24) - 12, v = y - 115;
    if (Math.abs(Math.abs(u - Math.abs(v) * 0.8) - 0) < 0.8 && Math.abs(v) < 4) return WHITE;
    return BLACK;
  }
  // 회색 골목: x 200~215, y 47~108 (가운데 흰 점선)
  if (x > 200 && x < 215 && y > 47 && y < 108) return Math.abs(x - 207.5) < 0.3 && Math.floor(y / 4) % 2 ? WHITE : [196, 198, 200];
  // 주차장: x 300~375, y 50~104 어두운 회색, 흰 칸 선, 위쪽 파란 띠
  if (x > 300 && x < 375 && y > 50 && y < 110) {
    if (y > 104) return [120, 170, 220];
    if (Math.abs(((x - 300) % 25)) < 0.6 || Math.abs(y - 51) < 0.6) return WHITE;
    return PLAZA;
  }
  // 나무: 초록 점
  const tx = ((x % 23) + 23) % 23 - 11.5, ty = ((y % 19) + 19) % 19 - 9.5;
  if (x > 110 && x < 190 && y > 55 && y < 100 && tx * tx + ty * ty < 9) return [70, 140, 70];
  return BASE;
}

// 세운 물체: 상자 {x0,x1,y0,y1,z0,z1,col}, 구 {c, r, col}
export const BOXES = [
  { x0: 252, x1: 264, y0: 90, y1: 102, z0: 0, z1: 70, col: [110, 60, 50] }, // 탑
  { x0: 424, x1: 474, y0: 74, y1: 118, z0: 24, z1: 27, col: [60, 62, 66] }, // 게이트 지붕 (오른쪽 끝 도로 위)
  { x0: 424, x1: 428, y0: 74, y1: 78, z0: 0, z1: 24, col: [235, 235, 235] }, { x0: 424, x1: 428, y0: 114, y1: 118, z0: 0, z1: 24, col: [235, 235, 235] },
  { x0: 470, x1: 474, y0: 74, y1: 78, z0: 0, z1: 24, col: [235, 235, 235] }, { x0: 470, x1: 474, y0: 114, y1: 118, z0: 0, z1: 24, col: [235, 235, 235] },
  { x0: 240, x1: 258, y0: 26, y1: 38, z0: 0, z1: 11, col: [30, 30, 34] }, // 앞 도로 중앙선 위 검은 레고 차
  { x0: 125, x1: 150, y0: 60, y1: 80, z0: 0, z1: 25, col: [215, 205, 190] }, // 건물
];
export const SPHERES = [{ c: [220, 78, 0], r: 28, col: [228, 228, 228] }]; // 돔

// 천장 LED 줄 (높이 250, x 방향으로 긴 줄 3개): 검은 노면에 비침
const LIGHTS_Y = [20, 95, 170], LIGHT_Z = 250;
function glare(P, d) {
  // 노면에서 반사된 시선이 천장 높이에서 조명 줄 근처를 지나면 밝게
  if (d[2] >= 0) return 0;
  const k = (LIGHT_Z - P[2]) / -d[2];
  const y = P[1] + d[1] * k;
  let g = 0;
  for (const ly of LIGHTS_Y) g = Math.max(g, Math.exp(-(((y - ly) / 6) ** 2)));
  return g;
}

function hitBox(C, d, b) {
  let t0 = 1e-6, t1 = Infinity;
  for (const [o, dd, lo, hi] of [[C[0], d[0], b.x0, b.x1], [C[1], d[1], b.y0, b.y1], [C[2], d[2], b.z0, b.z1]]) {
    if (Math.abs(dd) < 1e-12) { if (o < lo || o > hi) return Infinity; continue; }
    let a = (lo - o) / dd, c = (hi - o) / dd;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return Infinity;
  }
  return t0;
}
function hitSphere(C, d, s) {
  const oc = [C[0] - s.c[0], C[1] - s.c[1], C[2] - s.c[2]];
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2], c = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - s.r * s.r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 1e-6 ? t : Infinity;
}

// 한 장 그리기. pose: 도로 → 카메라(cv) {R, t}. opts: {gain, noise, seed, ss(한 픽셀 표본 수의 제곱근)}
export function renderDiorama(pose, { f, w, h, gain = 1, noise = 3, seed = 1, ss = 2, objects = true }) {
  const { R, t } = pose;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  const out = new Uint8ClampedArray(w * h * 4);
  let rnd = seed >>> 0;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const dc = [(px + (sx + 0.5) / ss - w / 2) / f, (py + (sy + 0.5) / ss - h / 2) / f, 1];
      let d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      const L = Math.hypot(d[0], d[1], d[2]); d = [d[0] / L, d[1] / L, d[2] / L];
      let best = d[2] < 0 ? -C[2] / d[2] : Infinity, col = null;
      if (objects) {
        for (const b of BOXES) { const s = hitBox(C, d, b); if (s < best) { best = s; col = b.col.map((v) => v * (0.85 + 0.15 * Math.abs(d[2]))); } }
        for (const s of SPHERES) { const k = hitSphere(C, d, s); if (k < best) { best = k; col = s.col; } }
      }
      if (!col) {
        if (best === Infinity) col = [200, 200, 205]; // 벽
        else {
          const P = [C[0] + d[0] * best, C[1] + d[1] * best, 0];
          col = groundColor(P[0], P[1]);
          if (col === BLACK || col === PLAZA) { const g = glare(P, [d[0], d[1], -d[2]]) * 70; col = col.map((v) => v + g); }
        }
      }
      acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2];
    }
    const n = ss * ss, i = (py * w + px) * 4, nz = (rand() - 0.5) * 2 * noise;
    out[i] = (acc[0] / n) * gain + nz; out[i + 1] = (acc[1] / n) * gain + nz; out[i + 2] = (acc[2] / n) * gain + nz; out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

// 테이블 둘레를 걸으며 도로를 비추는 카메라 경로 (도로 좌표, cm). 반환: [{pos, target}]
// 테이블 가장자리에서 out만큼 바깥, 테이블 위 height 높이, 가장 가까운 도로 중앙선보다 ahead만큼 안쪽을 봄
export function walkAround(n, { out = 35, height = 70, inward = 5, wobble = 1 } = {}) {
  const per = 2 * (TABLE.w + TABLE.h);
  const res = [];
  for (let i = 0; i < n; i++) {
    const s = ((i + 0.5) / n) * per;
    let p, nrm; // 테이블 가장자리 점과 바깥 방향
    if (s < TABLE.w) { p = [s, 0]; nrm = [0, -1]; }
    else if (s < TABLE.w + TABLE.h) { p = [TABLE.w, s - TABLE.w]; nrm = [1, 0]; }
    else if (s < 2 * TABLE.w + TABLE.h) { p = [TABLE.w - (s - TABLE.w - TABLE.h), TABLE.h]; nrm = [0, 1]; }
    else { p = [0, TABLE.h - (s - 2 * TABLE.w - TABLE.h)]; nrm = [-1, 0]; }
    const pos = [p[0] + nrm[0] * out + wobble * 4 * Math.sin(i * 0.7), p[1] + nrm[1] * out + wobble * 4 * Math.cos(i * 0.5), height + wobble * 5 * Math.sin(i * 0.3)];
    // 가장 가까운 중앙선 점 쪽, 조금 더 안쪽
    const tl = truthLoop(4);
    let q = tl[0], bd = Infinity;
    for (const c of tl) { const dd = Math.hypot(c[0] - pos[0], c[1] - pos[1]); if (dd < bd) { bd = dd; q = c; } }
    const target = [q[0] - nrm[0] * inward + wobble * 6 * Math.sin(i * 0.9), q[1] - nrm[1] * inward + wobble * 6 * Math.cos(i * 1.1), 0];
    res.push({ pos, target });
  }
  return res;
}
