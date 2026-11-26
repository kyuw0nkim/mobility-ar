// 마커 지도 만들기: 한 화면에 함께 보인 마커들의 관계로 모든 도로 마커의 위치·방향을 계산
// 전제: 모든 도로 마커는 같은 평면(도로면)에 평평하게 붙어 있고, 크기가 같다.
// 좌표: 처음 기준으로 정한 마커의 중심이 원점, 그 마커의 위쪽이 +y (단위 cm)
import {
  homography, applyH, inv3, markerCorners, makeK, poseFromHomography, refinePose, rotToVec, rodrigues, project, solveLinear,
} from './geometry.js';

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const transpose = (A) => A[0].map((_, j) => A.map((row) => row[j]));
const matMul = (A, B) => A.map((row) => B[0].map((_, j) => { let s = 0; for (let k = 0; k < row.length; k++) s += row[k] * B[k][j]; return s; }));
function inv(A) {
  const n = A.length, cols = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; const x = solveLinear(A, e); if (!x) return null; cols.push(x); }
  return A.map((_, i) => cols.map((c) => c[i]));
}

// 평면 좌표의 네 모서리(TL,TR,BR,BL) → {x, y, a(rad), size}
export function cornersToPose(p) {
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  const vx = [(p[1][0] - p[0][0] + p[2][0] - p[3][0]) / 2, (p[1][1] - p[0][1] + p[2][1] - p[3][1]) / 2];
  const vy = [(p[0][0] - p[3][0] + p[1][0] - p[2][0]) / 2, (p[0][1] - p[3][1] + p[1][1] - p[2][1]) / 2];
  const a1 = Math.atan2(vx[1], vx[0]);
  const a2 = Math.atan2(vy[1], vy[0]) - Math.PI / 2;
  const a = Math.atan2(Math.sin(a1) + Math.sin(a2), Math.cos(a1) + Math.cos(a2));
  const size = (Math.hypot(...vx) + Math.hypot(...vy)) / 2;
  return { x: cx, y: cy, a, size };
}

const cornersOf = (size, p) => markerCorners({ x: p.x, y: p.y, size, rot: (p.a * 180) / Math.PI });

export class MarkerMapper {
  constructor({ size = 10, excludeIds = [], minSamples = 4, maxFrames = 500, maxId = 49 } = {}) {
    this.maxId = maxId; // 도로 마커로 쓸 번호 범위 (0~maxId). 잘못 검출된 엉뚱한 번호를 걸러냄
    this.size = size;
    this.exclude = new Set(excludeIds);
    this.minSamples = minSamples;
    this.maxFrames = maxFrames;
    this.reset();
  }

  reset() {
    this.refId = null;
    this.est = new Map(); // id -> {x,y,a}
    this.samples = new Map(); // id -> [{x,y,a}]
    this.frames = []; // [{markers:[{id,c}]}], 마커 2개 이상 보인 프레임만
    this.seen = new Set();
    this.seenCount = new Map();
    this.lastFrameKey = '';
  }

  confirmed(id) {
    return id === this.refId || (this.samples.get(id) || []).length >= this.minSamples;
  }

  // markers: [{id, c:[[u,v]x4]}] (영상 좌표)
  addFrame(markers) {
    const ms = markers.filter((m) => !this.exclude.has(m.id) && m.id >= 0 && m.id <= this.maxId);
    for (const m of ms) { this.seen.add(m.id); this.seenCount.set(m.id, (this.seenCount.get(m.id) || 0) + 1); }
    if (!ms.length) return;
    if (this.refId === null) {
      // 화면에서 가장 크게 보인 마커를 기준(원점)으로
      const area = (m) => Math.abs((m.c[2][0] - m.c[0][0]) * (m.c[3][1] - m.c[1][1]) - (m.c[3][0] - m.c[1][0]) * (m.c[2][1] - m.c[0][1])) / 2;
      const ref = ms.reduce((a, b) => (area(b) > area(a) ? b : a));
      this.refId = ref.id;
      this.est.set(ref.id, { x: 0, y: 0, a: 0 });
    }
    if (ms.length < 2) return;
    // 같은 장면이 계속 쌓이지 않게 거의 움직이지 않은 프레임은 건너뜀
    const key = ms.map((m) => `${m.id}:${Math.round(m.c[0][0] / 12)},${Math.round(m.c[0][1] / 12)}`).sort().join('|');
    if (key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    const frame = { markers: ms.map((m) => ({ id: m.id, c: m.c.map((p) => [p[0], p[1]]) })) };
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) this.frames.splice(1, 1);
    // 실시간 추정: 이미 확인된 다른 마커들로 이 프레임의 평면→영상 관계를 구해 각 마커 위치를 역산
    for (const m of frame.markers) {
      if (m.id === this.refId) continue;
      const s = this._backProject(frame, m, (id) => this.confirmed(id));
      if (!s) continue;
      const arr = this.samples.get(m.id) || [];
      arr.push(s);
      if (arr.length > 40) arr.shift();
      this.samples.set(m.id, arr);
      this.est.set(m.id, {
        x: median(arr.map((q) => q.x)),
        y: median(arr.map((q) => q.y)),
        a: Math.atan2(arr.reduce((t, q) => t + Math.sin(q.a), 0), arr.reduce((t, q) => t + Math.cos(q.a), 0)),
      });
    }
  }

  // frame 안의 다른 마커(조건 충족)로 호모그래피를 구해 m의 평면 좌표를 계산
  _backProject(frame, m, usable) {
    const obj = [], img = [];
    for (const o of frame.markers) {
      if (o === m || !this.est.has(o.id) || !usable(o.id)) continue;
      const cs = cornersOf(this.size, this.est.get(o.id));
      for (let k = 0; k < 4; k++) { obj.push([cs[k][0], cs[k][1]]); img.push(o.c[k]); }
    }
    if (obj.length < 4) return null;
    const H = homography(obj, img);
    if (!H) return null;
    const Hi = inv3(H);
    if (!Hi) return null;
    const pts = m.c.map((p) => applyH(Hi, p[0], p[1]));
    const pose = cornersToPose(pts);
    const r = pose.size / this.size;
    if (!(r > 0.8 && r < 1.25)) return null; // 크기가 맞지 않으면 버림
    return { ...pose, w: obj.length / 4 };
  }

  status() {
    const ids = [...this.seen].filter((id) => this.confirmed(id) || this.seenCount.get(id) >= 5).sort((a, b) => a - b);
    return {
      refId: this.refId,
      confirmed: ids.filter((id) => this.confirmed(id)),
      pending: ids.filter((id) => !this.confirmed(id)).map((id) => ({ id, n: (this.samples.get(id) || []).length })),
      frames: this.frames.length,
    };
  }

  // 완료 시 전체 보정 (번들 조정): 모든 마커 위치(x,y,방향), 프레임별 카메라 자세, 초점거리를
  // 한꺼번에 조정해 모든 프레임의 모서리 재투영 오차를 최소화한다. 기준 마커는 고정.
  // imgW, imgH: 영상 크기(px), f0: 초점거리 초기값(px)
  solve({ imgW = 1280, imgH = 720, f0 = null, iters = 30 } = {}) {
    const cx = imgW / 2, cy = imgH / 2;
    let f = f0 || 0.8 * Math.max(imgW, imgH);
    const mids = [...this.est.keys()].filter((id) => id !== this.refId).sort((a, b) => a - b);
    const mIndex = new Map(mids.map((id, i) => [id, i]));
    const mp = new Map([[this.refId, { ...this.est.get(this.refId) }]]);
    for (const id of mids) mp.set(id, { ...this.est.get(id) });
    const P = 3 * mids.length + 1; // 마커 3개씩 + 초점거리

    // 프레임 초기 자세
    let frames = [];
    for (const fr of this.frames) {
      const ms = fr.markers.filter((m) => mp.has(m.id));
      if (ms.length < 2) continue;
      const obj = [], img = [];
      for (const m of ms) { const cs = cornersOf(this.size, mp.get(m.id)); for (let k = 0; k < 4; k++) { obj.push(cs[k]); img.push(m.c[k]); } }
      const H = homography(obj.map((q) => [q[0], q[1]]), img);
      if (!H) continue;
      const K = makeK(f, cx, cy);
      const pose = refinePose(K, poseFromHomography(H, K), obj, img, 8);
      if (!(pose.t[2] > 0) || pose.rms > 40) continue;
      frames.push({ ms, p: [...rotToVec(pose.R), ...pose.t] });
    }
    if (!frames.length) return this._result(mp, null, f);

    const getM = (id, q) => (id === this.refId ? mp.get(id) : { x: q[3 * mIndex.get(id)], y: q[3 * mIndex.get(id) + 1], a: q[3 * mIndex.get(id) + 2] });
    let q = []; for (const id of mids) { const e = mp.get(id); q.push(e.x, e.y, e.a); } q.push(f);
    const resid = (qq, fp, m) => {
      const K = makeK(qq[P - 1], cx, cy);
      const R = rodrigues(fp.slice(0, 3)), t = fp.slice(3);
      const cs = cornersOf(this.size, getM(m.id, qq));
      const r = [];
      for (let k = 0; k < 4; k++) { const u = project(K, R, t, cs[k]); r.push(u[0] - m.c[k][0], u[1] - m.c[k][1]); }
      return r;
    };
    const DELTA = 3; // Huber (px)
    const robustW = (r) => { const n = Math.sqrt(r.reduce((a, v) => a + v * v, 0) / 4); return n <= DELTA ? 1 : DELTA / n; };
    const cost = (qq, fps) => {
      let c = 0;
      frames.forEach((fr, j) => { for (const m of fr.ms) { const r = resid(qq, fps[j], m); const w = robustW(r); c += w * r.reduce((a, v) => a + v * v, 0); } });
      return c;
    };
    let fps = frames.map((fr) => fr.p);
    let c0 = cost(q, fps);
    let lam = 1e-3;
    const hp = (i) => (i === P - 1 ? 0.05 : i % 3 === 2 ? 1e-5 : 1e-3);
    const hc = (k) => (k < 3 ? 1e-6 : 1e-4);
    for (let it = 0; it < iters; it++) {
      const U = zeros(P, P), bp = new Array(P).fill(0);
      const Ws = [], Vs = [], bcs = [];
      frames.forEach((fr, j) => {
        const W = zeros(P, 6), V = zeros(6, 6), bc = new Array(6).fill(0);
        for (const m of fr.ms) {
          const r0 = resid(q, fps[j], m);
          const w = robustW(r0);
          // 이 관측이 영향을 주는 마커 파라미터 + 초점거리
          const pIdx = m.id === this.refId ? [P - 1] : [3 * mIndex.get(m.id), 3 * mIndex.get(m.id) + 1, 3 * mIndex.get(m.id) + 2, P - 1];
          const Jp = pIdx.map((i) => { const qq = q.slice(); qq[i] += hp(i); const r1 = resid(qq, fps[j], m); return r1.map((v, n) => (v - r0[n]) / hp(i)); });
          const Jc = [0, 1, 2, 3, 4, 5].map((k) => { const fp = fps[j].slice(); fp[k] += hc(k); const r1 = resid(q, fp, m); return r1.map((v, n) => (v - r0[n]) / hc(k)); });
          for (let a = 0; a < pIdx.length; a++) {
            for (let b = 0; b < pIdx.length; b++) U[pIdx[a]][pIdx[b]] += w * dot(Jp[a], Jp[b]);
            for (let k = 0; k < 6; k++) W[pIdx[a]][k] += w * dot(Jp[a], Jc[k]);
            bp[pIdx[a]] -= w * dot(Jp[a], r0);
          }
          for (let k = 0; k < 6; k++) { for (let l = 0; l < 6; l++) V[k][l] += w * dot(Jc[k], Jc[l]); bc[k] -= w * dot(Jc[k], r0); }
        }
        Ws.push(W); Vs.push(V); bcs.push(bc);
      });
      let improved = false;
      for (let tries = 0; tries < 6 && !improved; tries++) {
        const S = U.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lam) + 1e-9 : v)));
        const g = bp.slice();
        const Vinv = Vs.map((V) => inv(V.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lam) + 1e-9 : v)))));
        frames.forEach((_, j) => {
          if (!Vinv[j]) return;
          const WVi = matMul(Ws[j], Vinv[j]); // P x 6
          const WViWt = matMul(WVi, transpose(Ws[j]));
          for (let a = 0; a < P; a++) { for (let b = 0; b < P; b++) S[a][b] -= WViWt[a][b]; g[a] -= dot(WVi[a], bcs[j]); }
        });
        const dp = solveLinear(S, g);
        if (!dp) { lam *= 10; continue; }
        const q2 = q.map((v, i) => v + dp[i]);
        const fps2 = fps.map((fp, j) => {
          if (!Vinv[j]) return fp;
          const rhs = bcs[j].map((v, k) => v - Ws[j].reduce((a, row, i) => a + row[k] * dp[i], 0));
          const dc = Vinv[j].map((row) => dot(row, rhs));
          return fp.map((v, k) => v + dc[k]);
        });
        const c1 = cost(q2, fps2);
        if (c1 < c0) { q = q2; fps = fps2; lam = Math.max(1e-7, lam / 3); improved = c0 - c1 > 1e-6 * c0 ? true : 'done'; c0 = c1; }
        else lam *= 8;
      }
      if (!improved || improved === 'done') break;
    }
    for (const id of mids) mp.set(id, getM(id, q));
    f = q[P - 1];
    // 품질: 재투영 오차 (px)
    const errs = [];
    frames.forEach((fr, j) => { for (const m of fr.ms) { const r = resid(q, fps[j], m); for (let k = 0; k < 4; k++) errs.push(Math.hypot(r[2 * k], r[2 * k + 1])); } });
    return this._result(mp, median(errs), f);
  }

  _result(mp, errPx, f) {
    this.est = mp;
    const markers = [...mp.entries()].sort((a, b) => a[0] - b[0]).map(([id, p]) => ({
      id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), size: this.size, rot: +((wrap(p.a) * 180) / Math.PI).toFixed(2),
    }));
    const unconnected = [...this.seen].filter((id) => !mp.has(id) && this.seenCount.get(id) >= 10).sort((a, b) => a - b);
    return { markers, errorPx: errPx, focal: f, unconnected };
  }
}
