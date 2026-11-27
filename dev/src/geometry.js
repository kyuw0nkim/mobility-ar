// 기하 계산: 호모그래피, 카메라 자세, 좌표 변환
// 행렬은 길이 9(3x3) 배열, 행 우선(row-major)

export function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function mulVec3(A, v) {
  return [
    A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
    A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
    A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
  ];
}

export function transpose3(A) {
  return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
}

export function inv3(A) {
  const [a, b, c, d, e, f, g, h, i] = A;
  const co0 = e * i - f * h, co1 = -(d * i - f * g), co2 = d * h - e * g;
  const det = a * co0 + b * co1 + c * co2;
  if (Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    co0 * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    co1 * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    co2 * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// 가우스 소거 (부분 피벗)
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

// 점 정규화 (Hartley)
function normalizer(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

// src(평면 좌표) → dst(이미지 좌표) 호모그래피. 점 4개 이상.
export function homography(src, dst) {
  if (src.length < 4) return null;
  const Ts = normalizer(src), Td = normalizer(dst);
  const ns = src.map((p) => mulVec3(Ts, [p[0], p[1], 1]));
  const nd = dst.map((p) => mulVec3(Td, [p[0], p[1], 1]));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const addRow = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < ns.length; k++) {
    const [x, y] = ns[k], [u, v] = nd[k];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [...h, 1];
  const TdInv = inv3(Td);
  if (!TdInv) return null;
  const H = mul3(mul3(TdInv, Hn), Ts);
  const s = H[8];
  return H.map((v) => v / s);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function makeK(f, cx, cy) {
  return [f, 0, cx, 0, f, cy, 0, 0, 1];
}

// 단일 영상 호모그래피로 초점거리 추정 (주점=영상 중심 가정). 불안정하면 null.
export function estimateFocal(H, cx, cy) {
  const T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const G = mul3(T, H);
  const h1 = [G[0], G[3], G[6]], h2 = [G[1], G[4], G[7]];
  const est = [];
  const den1 = h1[2] * h2[2];
  if (Math.abs(den1) > 1e-9) {
    const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / den1;
    if (f2 > 0) est.push(Math.sqrt(f2));
  }
  const den2 = h1[2] * h1[2] - h2[2] * h2[2];
  if (Math.abs(den2) > 1e-9) {
    const f2 = -(h1[0] * h1[0] + h1[1] * h1[1] - h2[0] * h2[0] - h2[1] * h2[1]) / den2;
    if (f2 > 0) est.push(Math.sqrt(f2));
  }
  if (!est.length) return null;
  return est.reduce((a, b) => a + b, 0) / est.length;
}

// 회전 행렬 정규직교화 (극분해 반복)
function orthonormalize(R) {
  let M = R.slice();
  for (let it = 0; it < 8; it++) {
    const inv = inv3(M);
    if (!inv) break;
    const invT = transpose3(inv);
    M = M.map((v, i) => 0.5 * (v + invT[i]));
  }
  return M;
}

// 호모그래피 + 내부 파라미터 → 평면 좌표계에서 카메라 좌표계로의 자세 {R, t}
// 카메라 좌표계: OpenCV 규칙 (x 오른쪽, y 아래, z 앞)
export function poseFromHomography(H, K) {
  const Kinv = inv3(K);
  const M = mul3(Kinv, H);
  const h1 = [M[0], M[3], M[6]], h2 = [M[1], M[4], M[7]], h3 = [M[2], M[5], M[8]];
  let lam = 2 / (norm(h1) + norm(h2));
  if (h3[2] * lam < 0) lam = -lam;
  const r1 = h1.map((v) => v * lam), r2 = h2.map((v) => v * lam), t = h3.map((v) => v * lam);
  const r3 = cross(r1, r2);
  const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  return { R, t };
}

// 로드리게스 변환
export function rodrigues(r) {
  const th = norm(r);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = r.map((v) => v / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

export function rotToVec(R) {
  const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180도 근처: 대각 성분으로 축 추정
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

export function project(K, R, t, X) {
  const c = mulVec3(R, X);
  c[0] += t[0]; c[1] += t[1]; c[2] += t[2];
  return [(K[0] * c[0]) / c[2] + K[2], (K[4] * c[1]) / c[2] + K[5]];
}

// 재투영 오차 최소화 (가우스-뉴턴, 수치 미분)
export function refinePose(K, pose, obj, img, iters = 6) {
  let p = [...rotToVec(pose.R), ...pose.t];
  const residual = (q) => {
    const R = rodrigues(q.slice(0, 3)), t = q.slice(3);
    const r = [];
    for (let i = 0; i < obj.length; i++) {
      const u = project(K, R, t, obj[i]);
      r.push(u[0] - img[i][0], u[1] - img[i][1]);
    }
    return r;
  };
  let r0 = residual(p);
  let e0 = r0.reduce((a, v) => a + v * v, 0);
  for (let it = 0; it < iters; it++) {
    const J = [];
    for (let k = 0; k < 6; k++) {
      const h = k < 3 ? 1e-6 : 1e-4 * Math.max(1, Math.abs(p[k]));
      const q = p.slice(); q[k] += h;
      const r1 = residual(q);
      J.push(r1.map((v, i) => (v - r0[i]) / h));
    }
    const JtJ = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => {
      let s = 0; for (let m = 0; m < r0.length; m++) s += J[i][m] * J[j][m]; return s;
    }));
    const Jtr = J.map((col) => col.reduce((s, v, m) => s + v * r0[m], 0));
    for (let i = 0; i < 6; i++) JtJ[i][i] *= 1.001;
    const dp = solveLinear(JtJ, Jtr.map((v) => -v));
    if (!dp) break;
    const q = p.map((v, i) => v + dp[i]);
    const r1 = residual(q);
    const e1 = r1.reduce((a, v) => a + v * v, 0);
    if (e1 < e0) { p = q; r0 = r1; e0 = e1; } else break;
  }
  return { R: rodrigues(p.slice(0, 3)), t: p.slice(3), rms: Math.sqrt(e0 / obj.length) };
}

// 평면 자세의 '거울 해': 마커가 작거나 하나뿐이면 바닥 기울기가 시선 방향을 축으로 뒤집힌 해도 거의 똑같이 맞는다.
// 바닥 법선을 (카메라 → 점들 중심) 방향에 대해 대칭으로 뒤집은 자세를 돌려준다.
export function flipPose(pose, obj) {
  let cx = 0, cy = 0;
  for (const X of obj) { cx += X[0]; cy += X[1]; }
  const Xc = [cx / obj.length, cy / obj.length, 0];
  const c = transformPoint(pose, Xc);
  const v = c.map((x) => x / norm(c));
  const n = [pose.R[2], pose.R[5], pose.R[8]];
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const n2 = [2 * d * v[0] - n[0], 2 * d * v[1] - n[1], 2 * d * v[2] - n[2]];
  const ax = cross(n, n2), s = norm(ax);
  if (s < 1e-9) return null;
  const ang = Math.atan2(s, n[0] * n2[0] + n[1] * n2[1] + n[2] * n2[2]);
  const Rf = mul3(rodrigues(ax.map((x) => (x / s) * ang)), pose.R);
  const RX = mulVec3(Rf, Xc);
  return { R: Rf, t: [c[0] - RX[0], c[1] - RX[1], c[2] - RX[2]] };
}

// 자세 {R,t}: 좌표계 A → 카메라. 역변환: 카메라 → A
export function invertPose({ R, t }) {
  const Rt = transpose3(R);
  const ti = mulVec3(Rt, t).map((v) => -v);
  return { R: Rt, t: ti };
}

// a∘b : (b 적용 후 a 적용)
export function composePose(a, b) {
  const R = mul3(a.R, b.R);
  const t = mulVec3(a.R, b.t);
  return { R, t: [t[0] + a.t[0], t[1] + a.t[1], t[2] + a.t[2]] };
}

export function transformPoint(pose, X) {
  const p = mulVec3(pose.R, X);
  return [p[0] + pose.t[0], p[1] + pose.t[1], p[2] + pose.t[2]];
}

// 마커 설정(중심, 크기, 회전) → 도로 좌표계의 네 모서리 (TL, TR, BR, BL; 마커 '위쪽'이 rot 방향)
export function markerCorners(m) {
  const h = m.size / 2;
  const a = ((m.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // 마커 로컬: x 오른쪽, y 위쪽
  const local = [[-h, h], [h, h], [h, -h], [-h, -h]];
  return local.map(([x, y]) => [m.x + c * x - s * y, m.y + s * x + c * y, 0]);
}
