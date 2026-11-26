// 주행 경로, 바리케이드 추적, 정지 판단

// 둥근 사각형 경로 (닫힌 루프, 반시계 방향)
export function roundedRectPath(x0, y0, x1, y1, r, stepsPerCorner = 10) {
  const pts = [];
  const corners = [
    [x1 - r, y0 + r, -Math.PI / 2],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, Math.PI / 2],
    [x0 + r, y0 + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= stepsPerCorner; i++) {
      const a = a0 + (i / stepsPerCorner) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

// Catmull-Rom 스플라인으로 잇고 일정 간격으로 재표본한 뒤, sigma(cm)>0이면 가우시안으로 한 번 더 다듬는다.
// (탭한 점의 손떨림이 그대로 경로의 지그재그가 되는 것을 막는다)
export function smoothPath(points, closed = true, spacing = 0.5, sigma = 0) {
  const pts = splinePath(points, closed, spacing);
  return sigma > 0 ? gaussianSmooth(pts, closed, sigma / spacing) : pts;
}

// 점 배열(같은 간격)에 가우시안 평활. closed면 순환. sigmaN: 표본 개수 단위
export function gaussianSmooth(pts, closed, sigmaN) {
  const n = pts.length;
  if (sigmaN < 0.3 || n < 5) return pts.slice();
  const r = Math.min(Math.ceil(sigmaN * 3), closed ? (n >> 1) - 1 : n - 1);
  const wts = [];
  for (let k = -r; k <= r; k++) wts.push(Math.exp(-(k * k) / (2 * sigmaN * sigmaN)));
  const out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sw = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const w = wts[k + r];
      sx += pts[j][0] * w; sy += pts[j][1] * w; sw += w;
    }
    out.push([sx / sw, sy / sw]);
  }
  if (!closed) { out[0] = pts[0].slice(); out[n - 1] = pts[n - 1].slice(); }
  return out;
}

// 1차원 값 배열 가우시안 평활 (순환)
export function gaussianSmooth1(vals, sigmaN) {
  return gaussianSmooth(vals.map((v) => [v, 0]), true, sigmaN).map((p) => p[0]);
}

// 구심(centripetal) Catmull-Rom: 점 간격이 들쭉날쭉해도(곡선은 촘촘히, 직선은 듬성듬성 탭)
// 꼬임·고리·뾰족점이 생기지 않는다. (균일 Catmull-Rom은 이런 곳에서 작은 고리를 만들어 차가 홱 돈다)
function splinePath(points, closed, spacing) {
  if (points.length < 2) return points.slice();
  const n = points.length;
  const get = (i) => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const knot = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const lerp = (a, b, ta, tb, t) => {
    const u = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const dense = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(4, Math.min(400, Math.ceil(len / Math.max(1e-3, spacing / 2))));
    for (let k = 0; k < steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const A1 = lerp(p0, p1, t0, t1, t), A2 = lerp(p1, p2, t1, t2, t), A3 = lerp(p2, p3, t2, t3, t);
      const B1 = lerp(A1, A2, t0, t2, t), B2 = lerp(A2, A3, t1, t3, t);
      dense.push(lerp(B1, B2, t1, t2, t));
    }
  }
  if (!closed) dense.push(points[n - 1]);
  return resample(dense, closed, spacing);
}

function resample(pts, closed, spacing) {
  const P = buildPath(pts, closed);
  const out = [];
  const count = Math.max(2, Math.round(P.length / spacing));
  for (let i = 0; i < count; i++) {
    const s = closed ? (i / count) * P.length : (i / (count - 1)) * P.length;
    const q = pointAt(P, s);
    out.push([q.x, q.y]);
  }
  return out;
}

export function buildPath(points, closed = true) {
  const pts = points.map((p) => [p[0], p[1]]);
  if (closed) pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, length: cum[cum.length - 1], closed };
}

export function pointAt(P, s) {
  if (P.closed) s = ((s % P.length) + P.length) % P.length;
  else s = Math.max(0, Math.min(P.length, s));
  let lo = 0, hi = P.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (P.cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = P.cum[hi] - P.cum[lo] || 1e-9;
  const u = (s - P.cum[lo]) / seg;
  const a = P.pts[lo], b = P.pts[hi];
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

// 차 자세: 뒷바퀴·앞바퀴 위치(s ∓ wheelbase/2)를 잇는 방향을 차의 방향으로 쓴다.
// 0.5cm 간격 선분 하나로 방향을 정하면 경로의 작은 떨림이 그대로 차의 흔들림이 된다.
export function carPoseAt(P, s, wheelbase) {
  const q = pointAt(P, s);
  if (!(wheelbase > 0)) return q;
  const a = pointAt(P, s - wheelbase / 2), b = pointAt(P, s + wheelbase / 2);
  if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) q.heading = Math.atan2(b.y - a.y, b.x - a.x);
  return q;
}

export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

// 바리케이드 바닥 선분: 중심 c, 방향 d(단위벡터), 폭 w
export function barricadeSegment(b) {
  const h = b.width / 2;
  return [b.x - b.dx * h, b.y - b.dy * h, b.x + b.dx * h, b.y + b.dy * h];
}

// 현재 위치 s에서 앞으로 lookahead 안에 경로가 바리케이드와 겹치는 첫 지점까지의 거리. 없으면 null.
export function distanceToBlock(P, s, barricade, clearance, lookahead, step = 0.25) {
  if (!barricade) return null;
  const [ax, ay, bx, by] = barricadeSegment(barricade);
  const maxD = P.closed ? Math.min(lookahead, P.length) : Math.min(lookahead, P.length - s);
  for (let d = 0; d <= maxD; d += step) {
    const q = pointAt(P, s + d);
    if (distPointSeg(q.x, q.y, ax, ay, bx, by) < clearance) return d;
  }
  return null;
}

// 경로 전체 중 바리케이드와 겹치는 구간이 있는지 (판단 표시용)
export function blocksPath(P, barricade, clearance) {
  return distanceToBlock(P, 0, barricade, clearance, P.length, 0.5) !== null;
}

// 차량 속도 제어: 감속 후 정지
export class CarController {
  constructor(opts) {
    this.o = opts; // {cruise, brakeDist, stopGap, accel, decel, carLength}
    this.s = 0;
    this.v = 0;
    this.state = 'drive';
    this.gap = null;
  }
  update(dt, P, barricade, clearance) {
    const o = this.o;
    const front = o.carLength / 2;
    const d = distanceToBlock(P, this.s + front, barricade, clearance, o.brakeDist * 3);
    this.gap = d === null ? null : Math.max(0, d - o.stopGap);
    let target = o.cruise;
    if (this.gap !== null) {
      if (this.gap <= 0.05) target = 0;
      else if (this.gap < o.brakeDist) {
        // v^2 = 2 a d 형태로 남은 거리 안에 멈출 수 있는 속도
        target = Math.min(o.cruise, Math.sqrt(2 * o.decel * this.gap));
      }
    }
    if (this.v < target) this.v = Math.min(target, this.v + o.accel * dt);
    else this.v = Math.max(target, this.v - o.decel * 1.5 * dt);
    // 멈춤선 넘지 않도록
    let ds = this.v * dt;
    if (this.gap !== null) ds = Math.min(ds, this.gap);
    this.s += ds;
    if (P.closed) this.s = ((this.s % P.length) + P.length) % P.length;
    this.state = this.v < 0.01 && target === 0 ? 'stop' : target < o.cruise - 1e-6 ? 'brake' : 'drive';
    return this.state;
  }
}

// 바리케이드 추적: 여러 프레임 확인 후 등장, 보이는데 안 잡히면 해제
export class BarricadeTracker {
  constructor(opts) {
    this.o = opts; // {confirmFrames, windowFrames, clearMs, smoothing}
    this.hist = [];
    this.est = null;
    this.present = false;
    this.lastSeen = -Infinity;
    this.unseenVisibleSince = null;
  }
  // obs: {x,y,dx,dy} 또는 null. inView: 추정 위치가 현재 화면 안인지 (bool)
  update(now, obs, inView) {
    const o = this.o;
    this.hist.push(!!obs);
    if (this.hist.length > o.windowFrames) this.hist.shift();
    if (obs) {
      this.lastSeen = now;
      this.unseenVisibleSince = null;
      if (!this.est) this.est = { ...obs };
      else {
        const a = o.smoothing;
        // 방향은 부호 맞춘 뒤 섞기 (앞·뒷면 마커는 방향이 반대)
        let { dx, dy } = obs;
        if (dx * this.est.dx + dy * this.est.dy < 0) { dx = -dx; dy = -dy; }
        this.est.x += (obs.x - this.est.x) * a;
        this.est.y += (obs.y - this.est.y) * a;
        const nx = this.est.dx + (dx - this.est.dx) * a, ny = this.est.dy + (dy - this.est.dy) * a;
        const L = Math.hypot(nx, ny) || 1;
        this.est.dx = nx / L; this.est.dy = ny / L;
      }
      const seen = this.hist.filter(Boolean).length;
      if (!this.present && seen >= o.confirmFrames) this.present = true;
    } else if (this.present) {
      if (inView) {
        if (this.unseenVisibleSince === null) this.unseenVisibleSince = now;
        if (now - this.unseenVisibleSince > o.clearMs) this.clear();
      } else {
        this.unseenVisibleSince = null;
      }
    } else {
      // 확정 전 관측이 끊기면 후보 폐기
      if (now - this.lastSeen > o.clearMs) this.est = null;
    }
    return this.present ? this.est : null;
  }
  clear() {
    this.present = false;
    this.est = null;
    this.hist = [];
    this.unseenVisibleSince = null;
  }
}
