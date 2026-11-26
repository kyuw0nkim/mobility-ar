// 마커 없이 바리케이드 찾기: 노랑·검정 줄무늬 패널의 '노란 조각들'을 찾는다.
//  1) 노란 픽셀 (채도 높은 노랑만: 베이지 바닥판·연두 나무·주황 안내판은 제외)
//  2) 4px 칸 격자에서 노란 칸끼리 이어 '조각'(줄무늬 하나)을 만들고,
//     칸을 조금 넓혀 가까운 조각들을 한 '덩어리'로 묶는다 (검정 줄무늬 사이를 건너뜀)
//  3) 노란 조각이 2개 이상인 덩어리만 바리케이드 후보 (노란 블록 하나는 무시)
//  4) 덩어리 픽셀을 패널 높이의 수평면에 투영 → 가운데 = 위치, 주축 = 폭 방향
import { mulVec3 } from './geometry.js';

// 채도 높은 노랑: 색상각 38°~68°(빨강 0°, 노랑 60°), 채도 0.42 이상, 너무 어둡지 않음
export function isYellow(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  if (max < 90 || c / max < 0.42) return false;
  let hue;
  if (max === r) hue = 60 * ((g - b) / c);
  else if (max === g) hue = 60 * ((b - r) / c + 2);
  else return false; // 파랑 계열
  return hue >= 38 && hue <= 68;
}

// img: {width, height, data(RGBA)}. 반환: 후보 덩어리 배열 (노란 픽셀 많은 순)
// 노란 조각끼리의 틈이 조각 두께의 1.6배 이내면 같은 덩어리로 묶는다
// (줄무늬는 노랑·검정 폭이 비슷해서, 가까이서 봐 줄무늬가 굵어져도 같은 비율로 묶임)
// all: true면 조각이 1개뿐인 덩어리도 돌려줌(진단 표시용, single: true)
export function findYellowClusters(img, { cell = 4, minCellFill = 4, gapRatio = 1.6, minGap = 2, minPixels = null, minParts = 2, all = false } = {}) {
  const { width: W, height: H, data } = img;
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const cnt = new Uint16Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = (y / cell) | 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isYellow(data[i], data[i + 1], data[i + 2])) cnt[row * gw + ((x / cell) | 0)]++;
    }
  }
  const on = new Uint8Array(gw * gh);
  for (let k = 0; k < on.length; k++) on[k] = cnt[k] >= minCellFill ? 1 : 0;
  // 조각: 노란 칸끼리 8방향 연결
  const { lab, n } = label(on, gw, gh);
  const parts = Array.from({ length: n }, () => ({ cells: [], pixels: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
  for (let k = 0; k < on.length; k++) {
    if (!on[k]) continue;
    const p = parts[lab[k]], x = k % gw, y = (k / gw) | 0;
    p.cells.push(k); p.pixels += cnt[k];
    p.x0 = Math.min(p.x0, x); p.y0 = Math.min(p.y0, y); p.x1 = Math.max(p.x1, x); p.y1 = Math.max(p.y1, y);
  }
  const P = parts.filter((p) => p.cells.length >= 2); // 한 칸짜리는 잡음
  P.forEach((p) => { p.thin = Math.min(p.x1 - p.x0 + 1, p.y1 - p.y0 + 1); });
  // 가까운 조각 묶기 (합집합 찾기)
  const parent = P.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    const gx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) - 1);
    const gy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1);
    const lim = Math.max(minGap, gapRatio * Math.max(a.thin, b.thin));
    if (Math.max(gx, gy) <= lim) parent[find(i)] = find(j);
  }
  const groups = new Map();
  P.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  const minPx = minPixels ?? Math.max(60, W * H * 0.0004);
  const out = [];
  for (const g of groups.values()) {
    const pixels = g.reduce((s, p) => s + p.pixels, 0);
    if (pixels < minPx || (g.length < minParts && !all)) continue;
    const pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g) {
      for (const k of p.cells) pts.push([(k % gw + 0.5) * cell, (((k / gw) | 0) + 0.5) * cell, cnt[k]]);
      x0 = Math.min(x0, p.x0); y0 = Math.min(y0, p.y0); x1 = Math.max(x1, p.x1); y1 = Math.max(y1, p.y1);
    }
    // 노란 조각 하나의 세로 길이(중앙값, px): 패널 높이 확인용
    const hs = g.map((p) => (p.y1 - p.y0 + 1) * cell).sort((a, b) => a - b);
    out.push({ pixels, parts: g.length, single: g.length < minParts, bbox: [x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell], partH: hs[hs.length >> 1], pts });
  }
  out.sort((a, b) => b.pixels - a.pixels);
  return out;
}

function label(mask, w, h) {
  const lab = new Int32Array(w * h).fill(-1);
  let n = 0;
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    lab[s] = n; stack.push(s);
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] && lab[q] < 0) { lab[q] = n; stack.push(q); }
      }
    }
    n++;
  }
  return { lab, n };
}

// 크기 확인: 그 자리에 실제 바리케이드 패널(높이 panelH cm)이 있다면 화면에서 몇 px로 보여야 하는지와,
// 노란 조각의 실제 세로 길이를 비교. 멀리 있는 노란 의자처럼 '도로 위로 투영하면 디오라마 안에 떨어지지만
// 실제로는 훨씬 큰 물체'를 걸러 낸다. 체크무늬형(두 줄)은 조각이 패널의 절반이라 아래쪽 여유를 둠
export function plausibleSize(cluster, road, K, camPose, zPanel, panelH, lo = 0.25, hi = 4) {
  const r = panelSizeRatio(cluster, road, K, camPose, zPanel, panelH);
  return r !== null && r >= lo && r <= hi;
}
// 노란 조각 세로 길이 ÷ 그 자리 패널이 보여야 할 세로 길이 (계산 불가면 null)
export function panelSizeRatio(cluster, road, K, camPose, zPanel, panelH) {
  const top = project3(K, camPose, [road.x, road.y, zPanel + panelH / 2]);
  const bot = project3(K, camPose, [road.x, road.y, zPanel - panelH / 2]);
  if (!top || !bot) return null;
  const expected = Math.hypot(top[0] - bot[0], top[1] - bot[1]);
  return expected < 1 ? null : cluster.partH / expected;
}
function project3(K, { R, t }, X) {
  const c = mulVec3(R, X);
  const z = c[2] + t[2];
  if (z <= 1e-6) return null;
  return [K[0] * (c[0] + t[0]) / z + K[2], K[4] * (c[1] + t[1]) / z + K[5]];
}

// 덩어리 → 도로 좌표의 바리케이드 {x, y, dx, dy, span}. K: 영상 카메라 행렬, camPose: 도로 → cv(cm), z: 패널 가운데 높이(cm)
export function clusterToRoad(cluster, K, camPose, z) {
  const { R, t } = camPose;
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const C = mulVec3(Rt, t).map((v) => -v); // 카메라 위치 (도로 좌표)
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  const P = [];
  let sw = 0;
  for (const [u, v, w] of cluster.pts) {
    const d = mulVec3(Rt, [(u - cx) / fx, (v - cy) / fy, 1]);
    if (Math.abs(d[2]) < 1e-6) continue;
    const k = (z - C[2]) / d[2];
    if (k <= 0) continue;
    P.push([C[0] + d[0] * k, C[1] + d[1] * k, w]); sw += w;
  }
  if (P.length < 3 || sw === 0) return null;
  let mx = 0, my = 0;
  for (const [x, y, w] of P) { mx += x * w; my += y * w; }
  mx /= sw; my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y, w] of P) { const a = x - mx, b = y - my; sxx += a * a * w; sxy += a * b * w; syy += b * b * w; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // 주축
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of P) { const s = (x - mx) * dx + (y - my) * dy; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  return { x: mx, y: my, dx, dy, span: hi - lo };
}
