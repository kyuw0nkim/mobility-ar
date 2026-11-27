// 한 바퀴 중앙선 찾기: 검은 차로 둘 사이의 흰 중앙선(어두움 - 밝음 - 어두움)을 따라 닫힌 고리 하나를 찾는다.
// 탭 없이 모은 도로 영상(RoadMosaic)만으로:
//  1) 중앙선 점수 지도: 칸마다 8방향으로 '가운데 밝고 양옆 차로 폭만큼 고르게 어두운' 정도
//     (양옆을 3토막으로 나눠 가장 밝은 토막을 쓰므로, 차로 폭보다 좁은 화살표 도로·흰 바닥이 섞이면 점수가 낮음)
//  2) 고리 가운데에서 0.5°마다 바깥으로 선을 쏘아 점수가 높은 곳을 후보로
//  3) 각도마다 후보 하나씩, 매끄럽게 한 바퀴 이어지는 조합을 고름(순환 비터비). 가려진 각도는 앞뒤를 이어 채움
//  4) 고리의 법선 방향 단면으로 원래 해상도에서 중앙선 위치를 다듬음
import { smoothPath, gaussianSmooth, gaussianSmooth1, buildPath } from './logic.js';

const median = (a) => { const s = a.filter((v) => !Number.isNaN(v)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// 모은 도로 영상을 g(cm) 칸 격자로 줄인 밝기 (안 본 칸은 NaN)
function gridFrom(mosaic, g, b) {
  const nx = Math.max(1, Math.ceil((b.x1 - b.x0) / g)), ny = Math.max(1, Math.ceil((b.y1 - b.y0) / g));
  const s = new Float32Array(nx * ny), w = new Float32Array(nx * ny);
  const c = mosaic.cell;
  for (let j = 0; j < mosaic.ny; j++) {
    const gy = Math.floor((mosaic.y0 + (j + 0.5) * c - b.y0) / g);
    if (gy < 0 || gy >= ny) continue;
    for (let i = 0; i < mosaic.nx; i++) {
      const k = j * mosaic.nx + i, ww = mosaic.wsum[k];
      if (!(ww > 0)) continue;
      const gx = Math.floor((mosaic.x0 + (i + 0.5) * c - b.x0) / g);
      if (gx < 0 || gx >= nx) continue;
      s[gy * nx + gx] += mosaic.sum[k] / ww; w[gy * nx + gx] += 1;
    }
  }
  const L = new Float32Array(nx * ny);
  for (let k = 0; k < L.length; k++) L[k] = w[k] > 0 ? s[k] / w[k] : NaN;
  return { L, nx, ny, g, x0: b.x0, y0: b.y0 };
}

// 단면 vals(offs[k] = (k - mid) * step)에서 가운데 offset c의 중앙선 점수.
// 밝은 줄(±cw 안의 최댓값) - 양옆 차로(각 3토막 평균 중 가장 밝은 것) 중 밝은 쪽, 어두운 쪽이 전체 어두운 수준보다 밝으면 감점
function stripeScore(get, ci, cwN, laneN, dark) {
  let B = -Infinity;
  for (let o = -cwN; o <= cwN; o++) { const v = get(ci + o); if (v > B) B = v; }
  if (!(B > -Infinity)) return NaN;
  let Dmax = -Infinity, nOk = 0, nAll = 0;
  for (const side of [-1, 1]) {
    const start = cwN + 1, part = Math.max(1, Math.floor(laneN / 3));
    for (let p = 0; p < 3; p++) {
      let s = 0, n = 0;
      for (let o = start + p * part; o < start + (p + 1) * part; o++) { const v = get(ci + side * o); nAll++; if (!Number.isNaN(v)) { s += v; n++; nOk++; } }
      if (n) Dmax = Math.max(Dmax, s / n);
    }
  }
  if (nOk < nAll * 0.6) return NaN;
  return B - Dmax - DARK_PENALTY * Math.max(0, Dmax - dark);
}

// 양옆 차로(각 3토막) 중 가장 밝은 토막의 평균 — 차로 폭 전체가 어두운지 보기 위함
function flankMax(get, ci, cwN, laneN) {
  const part = Math.max(1, Math.floor(laneN / 3));
  let Dmax = -Infinity;
  for (const side of [-1, 1]) for (let p = 0; p < 3; p++) {
    let s = 0, n = 0;
    for (let o = cwN + 1 + p * part; o < cwN + 1 + (p + 1) * part; o++) { const v = get(ci + side * o); if (!Number.isNaN(v)) { s += v; n++; } }
    if (n) Dmax = Math.max(Dmax, s / n);
  }
  return Dmax;
}
// 탭 근처에서 붙일 때는 더 엄하게: 양옆 차로 폭 전체가 진하게 어두워야 중앙선 (A4 시트 도로 안쪽의 좁은 흰 섬처럼
// '어두움-밝음-어두움'이지만 차로가 좁아 바깥 흰 바닥이 섞이는 것, 주차장처럼 옅게 어두운 것은 아님)
const flankDarkEnough = (Dmax, dark, light) => Dmax <= dark + 0.35 * (light - dark);

// 칸마다 중앙선 점수 (8방향 중 최대). 빠르게: 방향마다 칸 오프셋을 미리 계산하고, 가장자리 근처는 건너뜀
function stripeMap(G, roadW) {
  const { L, nx, ny, g } = G;
  const { cwN, laneN } = stripeSize(roadW, g);
  const vals = []; for (const v of L) if (!Number.isNaN(v)) vals.push(v);
  vals.sort((a, b) => a - b);
  const dark = vals.length ? vals[Math.floor(vals.length * 0.05)] : 0;
  const light = vals.length ? vals[Math.floor(vals.length * 0.95)] : 255;
  const S = new Float32Array(nx * ny).fill(NaN);
  const reach = cwN + 1 + laneN, part = Math.max(1, Math.floor(laneN / 3));
  const tabs = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 8, t = new Int32Array(2 * reach + 1);
    for (let o = -reach; o <= reach; o++) t[o + reach] = Math.round(Math.sin(a) * o) * nx + Math.round(Math.cos(a) * o);
    tabs.push(t);
  }
  const mid = dark + (light - dark) * 0.35;
  for (let j = reach; j < ny - reach; j++) for (let i = reach; i < nx - reach; i++) {
    const c = j * nx + i;
    // 가운데 근처가 밝지 않으면 중앙선일 수 없음
    let bright = -Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = L[c + dj * nx + di]; if (v > bright) bright = v; }
    if (!(bright > mid)) continue;
    let best = NaN;
    for (const t of tabs) {
      let B = -Infinity;
      for (let o = -cwN; o <= cwN; o++) { const v = L[c + t[o + reach]]; if (v > B) B = v; }
      let Dmax = -Infinity, nOk = 0;
      for (let side = -1; side <= 1; side += 2) for (let p = 0; p < 3; p++) {
        let sum = 0, n = 0;
        for (let o = cwN + 1 + p * part; o < cwN + 1 + (p + 1) * part; o++) { const v = L[c + t[side * o + reach]]; if (v === v) { sum += v; n++; } }
        nOk += n;
        if (n && sum / n > Dmax) Dmax = sum / n;
      }
      if (nOk < 6 * part * 0.6 || !(B > -Infinity)) continue;
      const sc = B - Dmax - DARK_PENALTY * Math.max(0, Dmax - dark);
      if (Number.isNaN(best) || sc > best) best = sc;
    }
    S[c] = best;
  }
  return { S, dark, cwN, laneN };
}
// 양옆 차로가 이 주변의 가장 어두운 수준(검은 도로)보다 밝으면 그만큼 감점: 주차장 흰 칸 선(양옆이 어두운 회색)을 중앙선으로 보지 않게
const DARK_PENALTY = 0.5;
const stripeSize = (roadW, cell) => ({ cwN: Math.max(1, Math.round((roadW / 30) / cell)), laneN: Math.max(3, Math.round((roadW * 0.32) / cell)) });

// 순환 비터비: cands[i] = [{r, s}] (각도 i의 후보). 반환: 각도마다 고른 r (못 고르면 NaN)
// kmax 칸 안의 앞 후보와는 r이 비슷할수록 싸게 잇고, 더 긴 빈 곳(가려짐 등)은 restart 값을 더 내고 건너뛴다.
// 닫힌 고리라 두 바퀴 펼쳐 풀고 가운데 한 바퀴만 쓴다.
function chooseRing(cands, sigma, kmax, skip, restart) {
  const n = cands.length, N = n * 2;
  const C = (i) => cands[i % n];
  const cost = [], back = [];
  let M = 0, Marg = null; // 지금까지 min(cost - j·skip)과 그 위치 (건너뛰기용)
  const minAt = []; // 각도마다 가장 싼 후보
  for (let i = 0; i < N; i++) {
    const ci = C(i);
    cost.push(new Float64Array(ci.length)); back.push(new Array(ci.length).fill(null));
    // kmax보다 먼 앞쪽에서 건너뛰어 오기
    const jump = i - kmax - 1;
    if (jump >= 0 && minAt[jump]) { const v = minAt[jump].c - jump * skip; if (v < M) { M = v; Marg = minAt[jump].at; } }
    for (let a = 0; a < ci.length; a++) {
      let best = i * skip - ci[a].s, arg = null;
      if (Marg) { const v = M + (i - 1) * skip + restart - ci[a].s; if (v < best) { best = v; arg = Marg; } }
      for (let k = 1; k <= kmax && i - k >= 0; k++) {
        const cj = C(i - k), cc = cost[i - k];
        for (let b = 0; b < cj.length; b++) {
          const d = ci[a].r - cj[b].r, sg = sigma((ci[a].r + cj[b].r) / 2);
          const v = cc[b] + (d * d) / (sg * sg * k) + (k - 1) * skip - ci[a].s;
          if (v < best) { best = v; arg = [i - k, b]; }
        }
      }
      cost[i][a] = best; back[i][a] = arg;
    }
    let mc = Infinity, ma = -1;
    for (let a = 0; a < ci.length; a++) if (cost[i][a] < mc) { mc = cost[i][a]; ma = a; }
    minAt.push(ma >= 0 ? { c: mc, at: [i, ma] } : null);
  }
  let end = null, endCost = Infinity;
  for (let i = 0; i < N; i++) for (let a = 0; a < cost[i].length; a++) {
    const v = cost[i][a] + (N - 1 - i) * skip + (N - 1 - i > kmax ? restart : 0);
    if (v < endCost) { endCost = v; end = [i, a]; }
  }
  const out = new Array(n).fill(NaN);
  for (let cur = end; cur; cur = back[cur[0]][cur[1]]) {
    const [i, a] = cur;
    if (i >= (n >> 1) && i < (n >> 1) + n) out[i % n] = C(i)[a].r;
  }
  return out;
}

function fillCircular(a) {
  const n = a.length, idx = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) idx.push(i);
  if (!idx.length) return null;
  const out = a.slice();
  for (let q = 0; q < idx.length; q++) {
    const i0 = idx[q], i1 = idx[(q + 1) % idx.length], gap = ((i1 - i0 + n) % n) || n;
    for (let k = 1; k < gap; k++) { const u = k / gap; out[(i0 + k) % n] = a[i0] * (1 - u) + a[i1] * u; }
  }
  return out;
}
function longestRun(a) { // 순환 배열에서 가장 긴 NaN 연속 길이
  const n = a.length; let best = 0, cur = 0;
  for (let i = 0; i < 2 * n; i++) { if (Number.isNaN(a[i % n])) { cur++; best = Math.max(best, Math.min(cur, n)); } else cur = 0; }
  return best;
}

// mosaic: RoadMosaic. opts: {roadWidth(cm, 도로 전체 폭: 차로 2 + 중앙선, 대충), center:[x,y](고리 안쪽 아무 점, 없으면 자동)}
// 반환: {ok, pts(닫힌 고리, 도로 좌표), length, found(각도 중 중앙선을 찾은 비율), refined(다듬기에서 찾은 비율), maxGapCm, reason}
// 도로 폭을 실제보다 넓게 잡으면 차로 양옆의 흰 바닥까지 '차로'로 봐서 약해지므로, 안 되면 좁혀서 한 번 더
export function findCenterLoop(mosaic, opts = {}) {
  const W = opts.roadWidth || 24;
  let best = null;
  for (const k of [1, 0.7]) {
    const r = findOnce(mosaic, { ...opts, roadWidth: W * k });
    if (r.ok) return { ...r, roadWidth: W * k };
    if (!best || (r.found || 0) * (r.refined || 0) > (best.found || 0) * (best.refined || 0)) best = { ...r, roadWidth: W * k };
  }
  return best;
}
function findOnce(mosaic, opts) {
  const roadW = opts.roadWidth || 24;
  const b = mosaic.seenBounds ? mosaic.seenBounds() : { x0: mosaic.x0, y0: mosaic.y0, x1: mosaic.x0 + mosaic.nx * mosaic.cell, y1: mosaic.y0 + mosaic.ny * mosaic.cell };
  if (!b) return { ok: false, reason: 'empty' };
  const g = Math.max(mosaic.cell, roadW / 30);
  const G = gridFrom(mosaic, g, b);
  const { S } = stripeMap(G, roadW);
  const sv = []; for (const v of S) if (v > 0) sv.push(v);
  if (sv.length < 50) return { ok: false, reason: 'nostripe' };
  sv.sort((a, c) => a - c);
  // 기준 점수: 중앙선은 전체 넓이에 비해 아주 가늘어서 백분위 대신 '위에서 몇 번째' 값으로
  // (도로 폭의 10배 길이 정도의 중앙선이 보이면 그 안에 듦)
  const topN = Math.max(20, Math.round((roadW * 10) / g));
  const sRef = sv[Math.max(0, sv.length - topN)];
  const thr = sRef * 0.35;
  // 고리 가운데: 점수 높은 칸들의 무게 중심 (주면 그 점)
  let cx = 0, cy = 0, cw = 0;
  if (opts.center) [cx, cy] = opts.center;
  else {
    for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) { const s = S[j * G.nx + i]; if (s > sRef * 0.6) { cx += i * s; cy += j * s; cw += s; } }
    if (!cw) return { ok: false, reason: 'nocenter' };
    cx = G.x0 + (cx / cw + 0.5) * g; cy = G.y0 + (cy / cw + 0.5) * g;
  }
  const at = (x, y) => { const i = Math.floor((x - G.x0) / g), j = Math.floor((y - G.y0) / g); return i < 0 || j < 0 || i >= G.nx || j >= G.ny ? undefined : S[j * G.nx + i]; };
  let ring = null, center = [cx, cy];
  const NA = 720, dA = (2 * Math.PI) / NA;
  // 가운데를 고리 중심으로 한 번 더 옮겨 다시 (처음 가운데가 한쪽으로 치우쳐도 괜찮게)
  for (let pass = 0; pass < 2; pass++) {
    const cands = [];
    for (let a = 0; a < NA; a++) {
      const th = a * dA, dx = Math.cos(th), dy = Math.sin(th);
      const prof = [];
      for (let r = g; ; r += g) { const v = at(center[0] + dx * r, center[1] + dy * r); if (v === undefined) break; prof.push(v); }
      const list = [];
      for (let k = 1; k < prof.length - 1; k++) {
        const v = prof[k];
        if (!(v > thr) || !(v >= (prof[k - 1] || -Infinity)) || !(v >= (prof[k + 1] || -Infinity))) continue;
        list.push({ r: (k + 1) * g, s: v / sRef });
      }
      // 가까운 후보끼리는 센 것 하나만, 최대 6개
      list.sort((p, q) => q.s - p.s);
      const keep = [];
      for (const c of list) { if (keep.every((q) => Math.abs(q.r - c.r) > roadW * 0.5)) keep.push(c); if (keep.length >= 6) break; }
      cands.push(keep);
    }
    const r = chooseRing(cands, (rr) => Math.max(2 * g, 1.5 + rr * dA * 3), 24, 0.25, 4);
    const found = r.filter((v) => !Number.isNaN(v)).length / NA;
    const maxGap = longestRun(r);
    const rf = fillCircular(r);
    if (!rf) return { ok: false, reason: 'noring' };
    const pts = rf.map((rr, a) => [center[0] + Math.cos(a * dA) * rr, center[1] + Math.sin(a * dA) * rr]);
    ring = { pts, found, maxGap, center: center.slice() };
    if (opts.center) break;
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; }
    center = [mx / pts.length, my / pts.length];
  }
  const R = refineRing(mosaic, ring.pts, roadW, thr, [roadW * 0.35, roadW * 0.15]);
  const maxGapCm = (ring.maxGap * dA) * (R.length / (2 * Math.PI));
  // 기준을 엄하게: 덜 비춘 쪽을 이어 채운 고리는 지름길로 틀릴 수 있음 (가상 장면에서 1/3 바퀴만 비추면 고리의 13~30%가 3cm 넘게 틀림)
  const ok = ring.found >= 0.85 && R.refined >= 0.95 && R.length > roadW * 6;
  return { ok, pts: R.pts, weak: R.weak, length: R.length, found: ring.found, refined: R.refined, maxGapCm, center: ring.center, reason: ok ? null : ring.found < 0.85 ? 'partial' : 'weak' };
}

// 닫힌 고리 ringPts를 법선 단면으로 흰 중앙선에 맞춰 다듬기 (원래 해상도). thr: 중앙선으로 볼 최소 점수(null이면 단면마다 밝기 차로 정함)
// Rs: 차례로 쓸 찾기 범위(cm, 단면 좌우). 반환: {pts(저장용 간격), weak(점마다: 중앙선을 직접 확인 못 하고 이어 채움), refined(확인한 비율), length}
function refineRing(mosaic, ringPts, roadW, thr, Rs) {
  const step = Math.max(mosaic.cell * 2, roadW / 30);
  let cur = smoothPath(ringPts, true, step);
  const c = mosaic.cell;
  const { cwN, laneN } = stripeSize(roadW, c);
  let refined = 0, lastKeep = null;
  for (const R of Rs) {
    const n = cur.length;
    const nor = cur.map((_, i) => { const a = cur[(i - 1 + n) % n], bb = cur[(i + 1) % n]; const dx = bb[0] - a[0], dy = bb[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; });
    const reach = Math.ceil(R / c) + cwN + 1 + laneN;
    const offs = cur.map((p, i) => {
      const vals = [];
      for (let o = -reach; o <= reach; o++) vals.push(mosaic.sample(p[0] + nor[i][0] * o * c, p[1] + nor[i][1] * o * c));
      const get = (k) => (k + reach < 0 || k + reach >= vals.length ? NaN : vals[k + reach]);
      const ok = vals.filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
      if (ok.length < vals.length * 0.6) return NaN;
      const dark = ok[Math.floor(ok.length * 0.1)], light = ok[Math.floor(ok.length * 0.9)];
      const t = thr ?? Math.max(25, 0.35 * (light - dark));
      let best = -Infinity, bk = null;
      const RN = Math.ceil(R / c);
      for (let k = -RN; k <= RN; k++) {
        const s = stripeScore(get, k, cwN, laneN, dark);
        if (!(s > best)) continue;
        if (thr === null && !flankDarkEnough(flankMax(get, k, cwN, laneN), dark, light)) continue; // 탭 경로 다듬기: 엄하게
        best = s; bk = k;
      }
      if (bk === null || !(best > t)) return NaN;
      return stripeCentroid(get, bk, cwN, dark) * c;
    });
    // 이웃과 동떨어진 값 버리기 → 채우기 → 부드럽게 → 옮기기
    const M = Math.max(3, Math.round(roadW / step));
    const keep = offs.map((v, i) => {
      if (Number.isNaN(v)) return NaN;
      const win = []; for (let k = -M; k <= M; k++) win.push(offs[(i + k + n) % n]);
      const m = median(win);
      return Math.abs(v - m) <= roadW * 0.08 ? v : NaN;
    });
    refined = keep.filter((v) => !Number.isNaN(v)).length / n;
    lastKeep = keep;
    const filled = fillCircular(keep) || keep.map(() => 0);
    const sm = gaussianSmooth1(filled, Math.max(1, (roadW * 0.15) / step));
    cur = smoothPath(cur.map((p, i) => [p[0] + nor[i][0] * sm[i], p[1] + nor[i][1] * sm[i]]), true, step);
  }
  cur = gaussianSmooth(cur, true, Math.max(1, (roadW * 0.05) / step));
  const P = buildPath(cur, true);
  const spacing = Math.max(1.5, roadW / 15);
  const count = Math.max(16, Math.round(P.length / spacing));
  const pts = [], weak = [];
  for (let i = 0; i < count; i++) {
    const k = Math.round((i / count) * cur.length) % cur.length;
    pts.push([+cur[k][0].toFixed(2), +cur[k][1].toFixed(2)]);
    weak.push(Number.isNaN(lastKeep[Math.round((k / cur.length) * lastKeep.length) % lastKeep.length]));
  }
  return { pts, weak, refined, length: P.length };
}

// 중앙선 폭 안에서 밝기 무게 중심 (칸 단위, 칸 사이 위치)
function stripeCentroid(get, k, cwN, dark) {
  let sw = 0, so = 0;
  for (let o = -cwN - 1; o <= cwN + 1; o++) { const v = get(k + o); if (!Number.isNaN(v)) { const w = Math.max(0, v - dark); sw += w; so += w * (k + o); } }
  return sw > 0 ? so / sw : k;
}

// 탭으로 찍은 고리(대충 중앙선 위)를 흰 중앙선에 붙이기: 탭 사이 곡선까지 법선 단면으로 다듬는다.
// 탭 근처(roadWidth의 0.35배 안)만 찾으니 엉뚱한 도로로 가지 않는다.
// 반환: {ok(확인한 비율 70% 이상), pts, weak, refined, length}
export function refineAlongStripe(mosaic, taps, { roadWidth = 24 } = {}) {
  if (!taps || taps.length < 3) return { ok: false, reason: 'short' };
  const r = refineRing(mosaic, taps, roadWidth, null, [roadWidth * 0.35, roadWidth * 0.15]);
  return { ...r, ok: r.refined >= 0.7, reason: r.refined >= 0.7 ? null : 'weak' };
}

// 한 점 p 근처(반경 radius, 기본 도로 폭의 0.3배)에서 흰 중앙선 위 가장 그럴듯한 점 찾기 (탭할 때마다 바로 붙이기용)
// guide: {p, dir} 앞서 찍은 점으로 예상한 경로 선 (travelGuide). 주면
//  - 이 방향과 엇갈리는 줄(주차선·횡단보도처럼 가로지르는 선)은 빼고
//  - 이 선에서 옆으로 멀리 떨어진 후보(도로 위 흰 기둥이 바닥에 비친 자국 등)는 거의 고르지 않는다
// 반환: {ok, x, y, dist(옮긴 거리), score} — 못 찾으면 ok: false
export function snapToStripe(mosaic, p, { roadWidth = 24, radius = null, guide = null } = {}) {
  const dir = guide ? guide.dir : null;
  const R = radius ?? roadWidth * 0.3, c = mosaic.cell;
  const { cwN, laneN } = stripeSize(roadWidth, c);
  const reach = cwN + 1 + laneN;
  // 주변 밝기 수준
  const around = [];
  for (let y = -R - reach * c; y <= R + reach * c; y += c * 2) for (let x = -R - reach * c; x <= R + reach * c; x += c * 2) {
    const v = mosaic.sample(p[0] + x, p[1] + y); if (!Number.isNaN(v)) around.push(v);
  }
  if (around.length < 30) return { ok: false, reason: 'unscanned' };
  around.sort((a, b) => a - b);
  const dark = around[Math.floor(around.length * 0.1)], light = around[Math.floor(around.length * 0.9)];
  const thr = Math.max(25, 0.35 * (light - dark));
  const dirs = []; for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 8; dirs.push([Math.cos(a), Math.sin(a)]); }
  const s = Math.max(c, roadWidth / 60);
  let best = null;
  for (let y = -R; y <= R + 1e-9; y += s) for (let x = -R; x <= R + 1e-9; x += s) {
    const d = Math.hypot(x, y);
    if (d > R) continue;
    const q = [p[0] + x, p[1] + y];
    for (const n of dirs) {
      if (dir && Math.abs(n[0] * dir[0] + n[1] * dir[1]) > 0.85) continue; // 줄 방향이 진행 방향과 58° 넘게 엇갈림 (가로지르는 선)
      const get = (o) => mosaic.sample(q[0] + n[0] * o * c, q[1] + n[1] * o * c);
      const sc = stripeScore(get, 0, cwN, laneN, dark);
      if (!(sc > thr) || !flankDarkEnough(flankMax(get, 0, cwN, laneN), dark, light)) continue;
      let v = sc * (1 - 0.3 * (d / R) ** 2); // 같으면 탭한 곳에 가까운 쪽
      if (guide) {
        // 예상 선에서 옆으로 벗어난 거리. 곡선이면 앞으로 갈수록 벗어나니(반지름 60cm 곡선만큼) 그만큼 더 봐줌
        const dx = q[0] - guide.p[0], dy = q[1] - guide.p[1];
        const lat = Math.abs(dx * dir[1] - dy * dir[0]), along = dx * dir[0] + dy * dir[1];
        const bend = (along * along) / (2 * 60);
        if (lat > roadWidth * 0.35 + bend) continue; // 예상 경로 선에서 너무 벗어남 (차로 하나 폭 가까이)
        v *= Math.exp(-0.5 * (Math.max(0, lat - bend) / (roadWidth * 0.2)) ** 2);
      }
      if (!best || v > best.v) best = { v, sc, q, n, get };
    }
  }
  if (!best) return { ok: false, reason: 'nostripe' };
  const off = stripeCentroid(best.get, 0, cwN, dark) * c;
  const x = best.q[0] + best.n[0] * off, y = best.q[1] + best.n[1] * off;
  return { ok: true, x, y, dist: Math.hypot(x - p[0], y - p[1]), score: best.sc };
}

// 탭할 때 예상 경로 선 {p, dir} 또는 null: 이미 찍은 앞의 두 점(중앙선에 붙어 정확함)을 잇는 선.
// 점이 하나뿐이면 그 점 → 이번 탭 방향(옆 거리 판단 없이 방향만 쓰도록 p는 이번 탭). 이번 탭이 80cm 넘게 떨어지면 쓰지 않음
export function travelGuide(pts, p) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const unit = (u, v) => { const dx = v[0] - u[0], dy = v[1] - u[1], L = Math.hypot(dx, dy); return L > 2 && L < 150 ? [dx / L, dy / L] : null; };
  if (!b || Math.hypot(p[0] - b[0], p[1] - b[1]) > 80) return null; // 멀리 떨어진 점으로는 예상하지 않음
  if (a) { const dir = unit(a, b); return dir ? { p: b, dir } : null; }
  const dir = unit(b, p);
  return dir ? { p, dir } : null;
}
