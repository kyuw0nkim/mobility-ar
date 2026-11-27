// 차선 맞추기: 카메라 영상을 도로 평면(위에서 본 모습)에 모아 붙이고,
// 대충 탭한 경로를 흰 선 사이(어두운 차선 노면)의 가운데로 옮긴다.
import { mul3, inv3 } from './geometry.js';
import { smoothPath, gaussianSmooth, gaussianSmooth1, buildPath } from './logic.js';

// ---------- 도로 평면 영상 (위에서 본 밝기 지도) ----------
export class RoadMosaic {
  // bounds: {x0,y0,x1,y1} (cm), cell: 칸 크기 (cm)
  constructor(bounds, cell) {
    let c = cell;
    const span = (b) => Math.max(1, Math.ceil((b.x1 - b.x0) / c)) * Math.max(1, Math.ceil((b.y1 - b.y0) / c));
    while (span(bounds) > 1500000) c *= 1.25; // 메모리 한도 (매 프레임에는 화면에 보이는 칸만 계산)
    this.cell = c;
    this.x0 = bounds.x0; this.y0 = bounds.y0;
    this.nx = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / c));
    this.ny = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) / c));
    this.sum = new Float32Array(this.nx * this.ny);
    this.wsum = new Float32Array(this.nx * this.ny);
    this.frames = 0;
  }

  // extra: 마커 사각형 바깥으로 더 넓힐 거리(cm). 마커를 한두 변에만 붙이면 마커 사각형이 디오라마의 일부만 덮으므로
  //        AR 버전은 넉넉히(120cm) 넓힌다 (칸 수가 너무 많아지면 칸 크기가 자동으로 커짐)
  static forMarkers(roadMarkers, extra = 0) {
    const { bounds, cell } = RoadMosaic.specForMarkers(roadMarkers, extra);
    return new RoadMosaic(bounds, cell);
  }
  // 만들지 않고 범위·칸 크기만 (AR 버전은 영상 모으기를 인식 워커에서 하므로 설정만 넘김)
  static specForMarkers(roadMarkers, extra = 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, size = 0;
    for (const m of roadMarkers) {
      x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x); y1 = Math.max(y1, m.y);
      size = Math.max(size, m.size);
    }
    const pad = 1.5 * size + extra;
    return { bounds: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }, cell: size / 20 };
  }
  // 다른 스레드에서 받은 값으로 다시 만들기 (snapshot()의 반대)
  static fromSnapshot(d) {
    return Object.assign(Object.create(RoadMosaic.prototype), d);
  }
  snapshot() {
    return { cell: this.cell, x0: this.x0, y0: this.y0, nx: this.nx, ny: this.ny, frames: this.frames, sum: this.sum.slice(), wsum: this.wsum.slice() };
  }
  // 범위 b(도로 좌표 사각형) 안의 칸 중 본 칸의 비율(%) — 한 칸씩 건너 셈
  scannedPercent(b) {
    let seen = 0, all = 0;
    for (let j = 0; j < this.ny; j += 2) {
      const y = this.y0 + (j + 0.5) * this.cell;
      if (y < b.y0 || y > b.y1) continue;
      for (let i = 0; i < this.nx; i += 2) {
        const x = this.x0 + (i + 0.5) * this.cell;
        if (x < b.x0 || x > b.x1) continue;
        all++; if (this.wsum[j * this.nx + i] > 0) seen++;
      }
    }
    return all ? Math.round((seen / all) * 100) : 0;
  }

  // img: ImageData(축소 영상), K: 그 영상 기준 카메라 행렬, pose: 도로 → 카메라 {R,t}
  accumulate(img, K, pose) {
    const { R, t } = pose;
    const H = mul3(K, [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]]);
    const W = img.width, Hh = img.height, d = img.data;
    const f = K[0], c = this.cell;
    let used = 0;
    // 볼 칸의 범위 좁히기: 화면 중 '쓸 만큼 가까운 도로 면'이 보이는 부분만 도로 좌표로 되돌려 그 사각형만 돈다.
    // H·(x,y,1) = z·(u,v,1)이므로 Hi·(u,v,1) = (x,y,1)/z, 셋째 값 w = 1/z.
    // 아래 칸 계산에서 ppc = f·c/z < 0.5인 칸(너무 멀어서 흐림)은 버리므로 w ≥ 1/(2fc)인 곳만 필요하다.
    // 이렇게 화면 사각형을 그 반평면으로 자르면, 지평선이 보일 때도 전체 칸(100만 개 이상)을 돌지 않는다.
    let i0 = 0, i1 = this.nx - 1, j0 = 0, j1 = this.ny - 1;
    const Hi = inv3(H);
    if (Hi) {
      const wMin = 1 / (2 * f * c);
      const poly = clipHalfPlane([[0, 0], [W, 0], [W, Hh], [0, Hh]], (u, v) => Hi[6] * u + Hi[7] * v + Hi[8] - wMin);
      if (!poly.length) return 0; // 쓸 만한 도로 면이 화면에 없음
      let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity;
      for (const [u, v] of poly) {
        const w = Math.max(wMin, Hi[6] * u + Hi[7] * v + Hi[8]);
        const x = (Hi[0] * u + Hi[1] * v + Hi[2]) / w, y = (Hi[3] * u + Hi[4] * v + Hi[5]) / w;
        xa = Math.min(xa, x); xb = Math.max(xb, x); ya = Math.min(ya, y); yb = Math.max(yb, y);
      }
      i0 = Math.max(0, Math.floor((xa - this.x0) / c) - 1); i1 = Math.min(this.nx - 1, Math.ceil((xb - this.x0) / c) + 1);
      j0 = Math.max(0, Math.floor((ya - this.y0) / c) - 1); j1 = Math.min(this.ny - 1, Math.ceil((yb - this.y0) / c) + 1);
    }
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * c;
      const bx = H[1] * y + H[2], by = H[4] * y + H[5], bz = H[7] * y + H[8];
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * c;
        const z = H[6] * x + bz;
        if (z <= 1e-6) continue;
        const ppc = (f * c) / z; // 이 칸이 영상에서 몇 픽셀인지
        if (ppc < 0.5) continue; // 너무 멀어서 흐림
        const u = (H[0] * x + bx) / z - 0.5, v = (H[3] * x + by) / z - 0.5;
        if (u < 2 || v < 2 || u > W - 3 || v > Hh - 3) continue;
        const ui = u | 0, vi = v | 0, fu = u - ui, fv = v - vi;
        const p = (vi * W + ui) * 4;
        const l00 = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
        const l10 = d[p + 4] * 0.299 + d[p + 5] * 0.587 + d[p + 6] * 0.114;
        const q = p + W * 4;
        const l01 = d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114;
        const l11 = d[q + 4] * 0.299 + d[q + 5] * 0.587 + d[q + 6] * 0.114;
        const lum = (l00 * (1 - fu) + l10 * fu) * (1 - fv) + (l01 * (1 - fu) + l11 * fu) * fv;
        const w = Math.min(ppc, 2) ** 2; // 가까이서 본 장면일수록 선명하니 더 믿는다
        const k = j * this.nx + i;
        this.sum[k] += lum * w;
        this.wsum[k] += w;
        used++;
      }
    }
    if (used) this.frames++;
    return used;
  }

  // 도로 좌표 (x,y)의 밝기. 본 적 없으면 NaN
  sample(x, y) {
    const gx = (x - this.x0) / this.cell - 0.5, gy = (y - this.y0) / this.cell - 0.5;
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    let s = 0, ws = 0;
    // 이웃 네 칸 쌍선형 보간 (본 적 없는 칸은 빼고 남은 가중치로 나눔)
    for (let q = 0; q < 4; q++) {
      const di = q & 1, dj = q >> 1;
      const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny || w <= 0) continue;
      const k = jj * this.nx + ii;
      if (this.wsum[k] <= 0) continue;
      s += (this.sum[k] / this.wsum[k]) * w; ws += w;
    }
    return ws > 0.2 ? s / ws : NaN;
  }

  // 경로 주변(±r cm)을 본 비율
  coverage(pts, r) {
    let seen = 0;
    for (const p of pts) if (!Number.isNaN(this.sample(p[0], p[1]))) seen++;
    return pts.length ? seen / pts.length : 0;
  }
}

// 볼록 다각형을 g(u,v) ≥ 0인 쪽만 남기고 자르기 (Sutherland–Hodgman, 반평면 하나)
function clipHalfPlane(poly, g) {
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const ga = g(a[0], a[1]), gb = g(b[0], b[1]);
    if (ga >= 0) out.push(a);
    if ((ga >= 0) !== (gb >= 0)) {
      const u = ga / (ga - gb);
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
  return out;
}

// ---------- 가로 단면에서 차선 찾기 ----------
// vals: 오프셋 offs[k]에서의 밝기 (NaN 가능). 어두운 노면 구간 중 0을 포함하는(없으면 가장 가까운) 구간의 가운데와 폭
export function findLaneInProfile(offs, vals, minContrast = 20) {
  const ok = vals.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (ok.length < vals.length * 0.6) return null;
  const lo = ok[Math.floor(ok.length * 0.1)], hi = ok[Math.floor(ok.length * 0.9)];
  if (hi - lo < minContrast) return null;
  const thr = (lo + hi) / 2;
  const runs = [];
  let k = 0;
  const n = vals.length;
  while (k < n) {
    if (!(vals[k] < thr)) { k++; continue; }
    const a = k;
    while (k < n && vals[k] < thr) k++;
    const b = k - 1;
    // 양쪽이 밝은 칸(흰 선·흰 바닥)으로 막혀 있어야 차선
    if (a === 0 || b === n - 1 || Number.isNaN(vals[a - 1]) || Number.isNaN(vals[b + 1])) continue;
    // 경계를 밝기 문턱값 교차점으로 보간
    const edge = (i0, i1) => {
      const v0 = vals[i0], v1 = vals[i1];
      const u = v1 !== v0 ? (thr - v0) / (v1 - v0) : 0.5;
      return offs[i0] + (offs[i1] - offs[i0]) * Math.max(0, Math.min(1, u));
    };
    const L = edge(a - 1, a), Rr = edge(b, b + 1);
    runs.push({ c: (L + Rr) / 2, w: Rr - L, a: L, b: Rr });
  }
  if (!runs.length) return null;
  let best = runs.find((r) => r.a <= 0 && r.b >= 0);
  if (!best) best = runs.reduce((p, r) => (Math.abs(r.c) < Math.abs(p.c) ? r : p));
  return { ...best, runs };
}

// 단면마다 나온 차선 후보 중, 경로를 따라 끊김 없이 이어지는 것을 고른다 (비터비).
// 탭한 경로가 옆 차선으로 넘어간 곳이 있어도 대부분 구간에서 따라간 차선을 계속 따라간다.
// cands[i]: 후보 오프셋 배열. 반환: 고른 오프셋 (못 고르면 NaN)
export function chooseLaneOffsets(cands, laneW) {
  const n = cands.length;
  const N = n * 2; // 닫힌 경로: 두 바퀴 펼쳐 풀고 가운데 한 바퀴만 쓴다
  const C = (i) => cands[i % n];
  const KMAX = Math.max(4, Math.min(n >> 1, 60));
  const SKIP = 0.4, sig2 = (0.12 * laneW) ** 2, uni = (c) => 0.5 * (c / laneW) ** 2;
  const cost = [], back = [];
  for (let i = 0; i < N; i++) {
    const ci = C(i);
    cost.push(new Float64Array(ci.length));
    back.push(ci.map(() => null));
    for (let a = 0; a < ci.length; a++) {
      let best = i * SKIP + uni(ci[a]), arg = null;
      for (let k = 1; k <= KMAX && i - k >= 0; k++) {
        const cj = C(i - k), cc = cost[i - k];
        for (let b = 0; b < cj.length; b++) {
          const d = ci[a] - cj[b];
          const v = cc[b] + (d * d) / (sig2 * k) + (k - 1) * SKIP + uni(ci[a]);
          if (v < best) { best = v; arg = [i - k, b]; }
        }
      }
      cost[i][a] = best; back[i][a] = arg;
    }
  }
  let end = null, endCost = Infinity;
  for (let i = Math.max(0, N - KMAX); i < N; i++) {
    for (let a = 0; a < cost[i].length; a++) {
      const v = cost[i][a] + (N - 1 - i) * SKIP;
      if (v < endCost) { endCost = v; end = [i, a]; }
    }
  }
  const out = new Array(n).fill(NaN);
  for (let cur = end; cur; cur = back[cur[0]][cur[1]]) {
    const [i, a] = cur;
    if (i >= n >> 1 && i < (n >> 1) + n) out[i % n] = C(i)[a];
  }
  return out;
}

// 폭 목록에서 가장 많이 나온 폭 (점선 끊긴 곳의 '두 차선 폭', 화살표에 잘린 '좁은 폭'을 피함)
export function modeWidth(ws) {
  if (!ws.length) return null;
  let best = null, bestN = -1;
  for (const w of ws) {
    let n = 0;
    for (const v of ws) if (v >= w * 0.8 && v <= w * 1.25) n++;
    if (n > bestN || (n === bestN && w < best)) { best = w; bestN = n; }
  }
  const band = ws.filter((v) => v >= best * 0.8 && v <= best * 1.25).sort((a, b) => a - b);
  return band[band.length >> 1];
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

function normals(pts) {
  const n = pts.length;
  return pts.map((_, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [-dy / L, dx / L];
  });
}

// taps: 사용자가 탭한 점(닫힌 경로). opts: {search(cm), step(cm), laneWidth(cm|null)}
// 반환: {ok, pts, validFrac, laneWidth, reason}
export function snapPathToLane(mosaic, taps, opts = {}) {
  const step = opts.step || mosaic.cell * 2;
  const search = opts.search || 10;
  const cell = mosaic.cell;
  let cur = smoothPath(taps, true, step);
  if (cur.length < 8) return { ok: false, reason: 'short' };
  const cov = mosaic.coverage(cur);
  if (cov < 0.5) return { ok: false, reason: 'coverage', coverage: cov };

  let laneW = opts.laneWidth || null;
  let validFrac = 0;
  for (let iter = 0; iter < 3; iter++) {
    const n = cur.length;
    const nor = normals(cur);
    const R = iter === 0 || !laneW ? search : Math.min(search, laneW * 1.2);
    const offs = [];
    for (let o = -R; o <= R + 1e-9; o += cell) offs.push(o);
    const found = cur.map((p, i) => {
      const vals = offs.map((o) => mosaic.sample(p[0] + nor[i][0] * o, p[1] + nor[i][1] * o));
      return findLaneInProfile(offs, vals);
    });
    if (!laneW) laneW = modeWidth(found.filter(Boolean).map((f) => f.w));
    if (!laneW) return { ok: false, reason: 'nolane' };
    // 1) 폭이 차선 폭과 비슷한 후보만 남기고, 경로를 따라 이어지는 차선을 고른다
    const fits = (r) => r.w > laneW * 0.6 && r.w < laneW * 1.5;
    const c = chooseLaneOffsets(found.map((f) => (f ? f.runs.filter(fits).map((r) => r.c) : [])), laneW);
    // 2) 이웃과 동떨어진 값 버리기 (화살표·교차로·그림자)
    const M = Math.max(2, Math.round((laneW * 1.5) / step));
    const keep = c.map((v, i) => {
      if (Number.isNaN(v)) return NaN;
      const win = [];
      for (let k = -M; k <= M; k++) { const u = c[(i + k + n) % n]; if (!Number.isNaN(u)) win.push(u); }
      return win.length >= 3 && Math.abs(v - median(win)) <= laneW * 0.25 ? v : NaN;
    });
    const valid = keep.filter((v) => !Number.isNaN(v)).length;
    validFrac = valid / n;
    if (validFrac < 0.25) return { ok: false, reason: 'nolane', validFrac, laneWidth: laneW };
    // 3) 못 찾은 곳은 앞뒤에서 이어 붙이기 (순환 선형 보간)
    const off = fillCircular(keep);
    // 4) 부드럽게
    const sm = gaussianSmooth1(off, Math.max(1, (laneW * 0.6) / step));
    cur = cur.map((p, i) => [p[0] + nor[i][0] * sm[i], p[1] + nor[i][1] * sm[i]]);
    // 간격 다시 고르게
    cur = smoothPath(cur, true, step);
  }
  cur = gaussianSmooth(cur, true, Math.max(1, (laneW * 0.25) / step));
  // 저장용으로 성기게 (차선 폭의 1/4 간격)
  const P = buildPath(cur, true);
  const spacing = Math.max(step, laneW / 4);
  const count = Math.max(8, Math.round(P.length / spacing));
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i / count) * cur.length) % cur.length;
    out.push([+cur[idx][0].toFixed(2), +cur[idx][1].toFixed(2)]);
  }
  return { ok: true, pts: out, validFrac, laneWidth: laneW };
}

function fillCircular(a) {
  const n = a.length;
  const idx = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) idx.push(i);
  if (!idx.length) return a.map(() => 0);
  const out = a.slice();
  for (let q = 0; q < idx.length; q++) {
    const i0 = idx[q], i1 = idx[(q + 1) % idx.length];
    const gap = ((i1 - i0 + n) % n) || n;
    for (let k = 1; k < gap; k++) {
      const u = k / gap;
      out[(i0 + k) % n] = a[i0] * (1 - u) + a[i1] * u;
    }
  }
  return out;
}

// ---------- 자동 경로: 차선을 따라 한 바퀴 추적 ----------
// a: 출발점(차선 위), b: 진행 방향 쪽 점 (도로 좌표, cm).
// 가로 단면마다 어두운 노면(양옆이 흰 선·흰 띠로 막힌 구간)의 가운데를 찾아 조금씩 앞으로 나아간다.
// 교차로·점선이 끊긴 곳·화살표처럼 차선을 못 찾는 곳은 그 방향으로 계속 직진하고(최대 maxGap),
// 출발점으로 돌아오면 닫힌 경로로 끝낸다.
// 반환: {ok, closed, pts, laneWidth, length, found(차선을 찾은 비율), reason, stopAt}
export function traceLane(mosaic, a, b, opts = {}) {
  const cell = mosaic.cell;
  const step = opts.step || cell * 3;
  const search = opts.search || 12;
  let h = [b[0] - a[0], b[1] - a[1]];
  let L = Math.hypot(h[0], h[1]);
  if (L < 1e-6) return { ok: false, reason: 'direction' };
  h = [h[0] / L, h[1] / L];
  const profile = (p, dir, R) => {
    const n = [-dir[1], dir[0]];
    const offs = [], vals = [];
    for (let o = -R; o <= R + 1e-9; o += cell) { offs.push(o); vals.push(mosaic.sample(p[0] + n[0] * o, p[1] + n[1] * o)); }
    return { n, f: findLaneInProfile(offs, vals) };
  };
  // 차선 폭: 출발점에서 앞쪽으로 여러 단면을 보고 가장 많이 나온 폭 (점선이 끊긴 곳에서 출발해도 두 차선 폭을 고르지 않게)
  const samples = [];
  for (let k = 0; k < 10; k++) {
    const p = [a[0] + h[0] * k * step * 2, a[1] + h[1] * k * step * 2];
    const sk = profile(p, h, search);
    if (sk.f) samples.push({ p, n: sk.n, run: sk.f.runs.reduce((q, r) => (Math.abs(r.c) < Math.abs(q.c) ? r : q)), runs: sk.f.runs });
  }
  if (!samples.length) return { ok: false, reason: 'nolane' };
  const laneW = opts.laneWidth || modeWidth(samples.map((x) => x.run.w));
  // 출발점: 그 폭에 맞는 차선 중 탭한 곳에서 가장 가까운 것 (출발점 단면이 안 맞으면 바로 앞 단면)
  let pos = null;
  for (const sk of samples) {
    const fit = sk.runs.filter((r) => r.w > laneW * 0.6 && r.w < laneW * 1.5);
    if (!fit.length) continue;
    const r = fit.reduce((q, x) => (Math.abs(x.c) < Math.abs(q.c) ? x : q));
    pos = [sk.p[0] + sk.n[0] * r.c, sk.p[1] + sk.n[1] * r.c];
    break;
  }
  if (!pos) return { ok: false, reason: 'nolane' };
  const pts = [pos];
  const maxGap = opts.maxGap || laneW * 3;
  const maxMiss = Math.max(3, Math.ceil(maxGap / step));
  const maxLength = opts.maxLength || 4000;
  let traveled = 0, miss = 0, found = 0, total = 0;
  let omega = 0; // 걸음당 방향 변화(rad): 차선을 못 찾는 동안에도 곡선이면 같은 비율로 계속 돈다
  const finish = (ring, bridged) => {
    const sm = gaussianSmooth(smoothPath(ring, true, step), true, Math.max(1, (laneW * 0.3) / step));
    const P = buildPath(sm, true);
    const spacing = Math.max(step, laneW / 4);
    const count = Math.max(8, Math.round(P.length / spacing));
    const out = [];
    for (let i = 0; i < count; i++) { const k = Math.round((i / count) * sm.length) % sm.length; out.push([+sm[k][0].toFixed(2), +sm[k][1].toFixed(2)]); }
    return { ok: true, closed: true, bridged, pts: out, laneWidth: laneW, length: P.length, found: found / Math.max(1, total) };
  };
  while (traveled < maxLength) {
    if (miss > 0 && omega) { const c = Math.cos(omega), sn = Math.sin(omega); h = [h[0] * c - h[1] * sn, h[0] * sn + h[1] * c]; }
    let q = [pos[0] + h[0] * step, pos[1] + h[1] * step];
    const { n, f } = profile(q, h, laneW * 1.3);
    total++;
    const cand = f ? f.runs.filter((r) => r.w > laneW * 0.6 && r.w < laneW * 1.5 && Math.abs(r.c) < laneW * 0.6) : [];
    // 차선이 넓어진 곳(점선이 길게 끊김, 차선 합류): 한쪽 가장자리에서 차선 폭 절반만큼 떨어진 곳을 따라감
    const wide = !cand.length && f ? f.runs.filter((r) => r.w >= laneW * 1.5 && r.w < laneW * 4 && r.a < laneW * 0.6 && r.b > -laneW * 0.6) : [];
    if (cand.length) {
      const c = cand.reduce((p, r) => (Math.abs(r.c) < Math.abs(p.c) ? r : p)).c;
      q = [q[0] + n[0] * c * 0.6, q[1] + n[1] * c * 0.6]; // 한 번에 다 옮기지 않아 흔들림을 줄임
      miss = 0; found++;
    } else if (wide.length) {
      const r = wide[0];
      const c1 = r.a + laneW / 2, c2 = r.b - laneW / 2;
      const c = Math.abs(c1) < Math.abs(c2) ? c1 : c2;
      if (Math.abs(c) < laneW * 0.6) q = [q[0] + n[0] * c * 0.4, q[1] + n[1] * c * 0.4];
      miss = 0;
    } else if (++miss > maxMiss) {
      // 거의 한 바퀴 돌아 출발점 근처에서 놓쳤으면 이어 붙여 닫는다
      const back = pts.length - miss;
      if (traveled > laneW * 20 && Math.hypot(pts[back][0] - pts[0][0], pts[back][1] - pts[0][1]) < laneW * 4) return finish(pts.slice(0, back), true);
      return { ok: false, closed: false, pts, laneWidth: laneW, length: traveled, found: found / total, reason: Number.isNaN(mosaic.sample(q[0], q[1])) ? 'unscanned' : 'lost', stopAt: q };
    }
    // 방향: 최근 몇 걸음의 이동 방향 쪽으로 서서히
    const back = pts[Math.max(0, pts.length - 4)];
    const d = [q[0] - back[0], q[1] - back[1]];
    const dl = Math.hypot(d[0], d[1]);
    if (dl > 1e-6) {
      const h0 = h;
      h = [h[0] * 0.5 + (d[0] / dl) * 0.5, h[1] * 0.5 + (d[1] / dl) * 0.5]; L = Math.hypot(h[0], h[1]); h = [h[0] / L, h[1] / L];
      if (miss === 0) omega = omega * 0.8 + 0.2 * Math.atan2(h0[0] * h[1] - h0[1] * h[0], h0[0] * h[0] + h0[1] * h[1]);
    }
    pos = q; pts.push(q); traveled += step;
    // 출발점으로 돌아옴 → 닫힌 경로
    if (traveled > laneW * 6 && Math.hypot(pos[0] - pts[0][0], pos[1] - pts[0][1]) < Math.max(step * 1.5, laneW * 0.5)) {
      pts.pop();
      return finish(pts, false);
    }
  }
  return { ok: false, closed: false, pts, laneWidth: laneW, length: traveled, found: found / Math.max(1, total), reason: 'tooLong', stopAt: pos };
}
