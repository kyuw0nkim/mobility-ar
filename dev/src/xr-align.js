// AR(WebXR·ARCore) 버전: 카메라 영상의 마커로 디오라마(도로 좌표)를 ARCore 세계 좌표에 맞추는 계산.
//
// 좌표계
//  - 도로: x·y는 디오라마 바닥, z는 위 (cm). 마커 지도(cfg.roadMarkers)의 좌표
//  - 세계: ARCore 'local' 공간. y가 위(중력 반대), 단위 m
//  - 카메라(cv): x 오른쪽, y 아래, z 앞 (OpenCV 규칙, 기존 코드와 같음)
//
// 디오라마는 수평이라고 보고 "수평 위치 2 + 높이 1 + 방향 1" 네 값만 구한다.
// 마커가 1개만 보여서 기울기가 애매해도 ARCore가 아는 중력 방향을 쓰니 바닥이 들리지 않는다.

export const CM = 0.01; // 도로 1cm = 세계 0.01m

// XR 투영 행렬(열 우선 4x4) → 영상(w×h, 위가 0행) 기준 카메라 행렬 K
export function intrinsicsFromProjection(P, w, h) {
  return [P[0] * w / 2, 0, (1 - P[8]) * w / 2, 0, P[5] * h / 2, (1 + P[9]) * h / 2, 0, 0, 1];
}

// XR view.transform.matrix(열 우선, 세계 ← 뷰) → 세계 ← 카메라(cv) {R(행 우선 3x3), t(m)}
// 뷰 공간은 y 위·z 뒤, cv는 y 아래·z 앞이므로 둘째·셋째 축을 뒤집는다
export function worldFromCv(M) {
  return {
    R: [M[0], -M[4], -M[8], M[1], -M[5], -M[9], M[2], -M[6], -M[10]],
    t: [M[12], M[13], M[14]],
  };
}

const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

// 수평 디오라마 자세: 도로 → 세계. yaw ψ: 도로 x축 = (cosψ, 0, -sinψ), y축 = (-sinψ, 0, -cosψ), z축 = 세계 위(0,1,0)
export function levelRotation(yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // 열: ex, ey, ez (행 우선 3x3)
  return [c, -s, 0, 0, 0, 1, -s, -c, 0];
}
// 도로 점(cm) → 세계(m)
export function roadToWorld(A, X) {
  const R = levelRotation(A.yaw);
  const v = mv(R, X);
  return [A.p[0] + v[0] * CM, A.p[1] + v[1] * CM, A.p[2] + v[2] * CM];
}
// 세계(m) → 도로(cm)
export function worldToRoad(A, W) {
  const R = levelRotation(A.yaw);
  const d = [(W[0] - A.p[0]) / CM, (W[1] - A.p[1]) / CM, (W[2] - A.p[2]) / CM];
  return [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
}
// three.js Matrix4.set 순서(행 우선 16개): 도로(cm) → 세계(m)
export function roadToWorldMatrix(A) {
  const R = levelRotation(A.yaw);
  return [
    R[0] * CM, R[1] * CM, R[2] * CM, A.p[0],
    R[3] * CM, R[4] * CM, R[5] * CM, A.p[1],
    R[6] * CM, R[7] * CM, R[8] * CM, A.p[2],
    0, 0, 0, 1,
  ];
}
// 도로 → 카메라(cv) 자세 {R, t(cm)}: 차선 맞추기 영상 모으기 등 기존 함수에 넘기기 위함
export function roadToCv(A, wc) {
  const L = levelRotation(A.yaw);
  // X_cv = Rwcᵀ (p + L X·CM - twc) → 도로 cm 기준으로는 R = Rwcᵀ L, t = Rwcᵀ (p - twc) / CM
  const RwT = [wc.R[0], wc.R[3], wc.R[6], wc.R[1], wc.R[4], wc.R[7], wc.R[2], wc.R[5], wc.R[8]];
  const R = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(RwT[i * 3] * L[j] + RwT[i * 3 + 1] * L[3 + j] + RwT[i * 3 + 2] * L[6 + j]);
  const t = mv(RwT, [(A.p[0] - wc.t[0]) / CM, (A.p[1] - wc.t[1]) / CM, (A.p[2] - wc.t[2]) / CM]);
  return { R, t };
}

// 한 프레임의 관측: 마커로 구한 도로 → 카메라 자세 + 그때의 세계 ← 카메라 → 수평 디오라마 추정 {p, yaw}
// anchor: 이번에 보인 마커들의 중심(도로 좌표). 기울기 오차가 멀리 있는 원점을 크게 흔들지 않도록 이 점을 기준으로 위치를 정한다
export function levelEstimate(roadPose, wc, anchor) {
  // 도로 → 세계 회전 = Rwc · R
  const R = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(wc.R[i * 3] * roadPose.R[j] + wc.R[i * 3 + 1] * roadPose.R[3 + j] + wc.R[i * 3 + 2] * roadPose.R[6 + j]);
  const ex = [R[0], R[3], R[6]], ey = [R[1], R[4], R[7]];
  // ex ≈ (cosψ, *, -sinψ), ey ≈ (-sinψ, *, -cosψ): 두 축의 수평 성분을 합쳐 ψ
  const c = ex[0] - ey[2], s = -ex[2] - ey[0];
  const yaw = Math.atan2(s, c);
  // 기울기: 도로 z축이 세계 위에서 얼마나 기울었나 (품질 판단용)
  const tilt = Math.acos(Math.max(-1, Math.min(1, R[5]))) * 180 / Math.PI;
  // 앵커 점의 세계 위치 (마커 관측 그대로)
  const ac = mv(roadPose.R, anchor);
  const acv = [ac[0] + roadPose.t[0], ac[1] + roadPose.t[1], ac[2] + roadPose.t[2]];
  const aw = mv(wc.R, acv.map((v) => v * CM));
  const Aw = [aw[0] + wc.t[0], aw[1] + wc.t[1], aw[2] + wc.t[2]];
  // 수평 자세로 앵커를 맞추는 원점
  const L = levelRotation(yaw);
  const la = mv(L, anchor);
  const p = [Aw[0] - la[0] * CM, Aw[1] - la[1] * CM, Aw[2] - la[2] * CM];
  return { p, yaw, tilt };
}

// 여러 프레임의 추정을 모아 하나로 (최근 것 위주, 튀는 값 제외)
export class AlignmentFuser {
  constructor({ keep = 90, minCount = 8 } = {}) {
    this.keep = keep; this.minCount = minCount;
    this.list = [];
    this.result = null;
  }
  reset() { this.list = []; this.result = null; }
  // 이미 아는 위치로 바로 맞춘 상태로 시작 (AR 지도 만들기 직후)
  seed(A) {
    this.list = Array.from({ length: this.minCount }, () => ({ p: A.p.slice(), yaw: A.yaw, tilt: 0, w: 1 }));
    this.result = { p: A.p.slice(), yaw: A.yaw, n: this.minCount };
  }
  // est: levelEstimate 결과, w: 신뢰도 (보인 마커 수 등)
  add(est, w = 1) {
    if (est.tilt > 12) return false; // 바닥이 이만큼 기울어 보이면 잘못 잡힌 프레임 (디오라마는 수평)
    this.list.push({ ...est, w });
    if (this.list.length > this.keep) this.list.shift();
    this.result = this.fuse();
    return true;
  }
  get count() { return this.list.length; }
  get ready() { return this.result !== null && this.list.length >= this.minCount; }
  fuse() {
    const L = this.list;
    if (!L.length) return null;
    // 방향: 첫 값 기준으로 펼친 뒤 중앙값
    const y0 = L[L.length - 1].yaw;
    const yaws = L.map((e) => y0 + Math.atan2(Math.sin(e.yaw - y0), Math.cos(e.yaw - y0)));
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const my = med(yaws), mp = [0, 1, 2].map((k) => med(L.map((e) => e.p[k])));
    // 중앙값에서 2cm·2° 넘게 벗어난 것 제외 후 가중 평균
    let sw = 0, sy = 0; const sp = [0, 0, 0];
    L.forEach((e, i) => {
      const dp = Math.hypot(e.p[0] - mp[0], e.p[1] - mp[1], e.p[2] - mp[2]);
      if (dp > 0.02 || Math.abs(yaws[i] - my) > 2 * Math.PI / 180) return;
      const w = e.w * (0.5 + 0.5 * (i / L.length)); // 최근 것을 조금 더
      sw += w; sy += yaws[i] * w; for (let k = 0; k < 3; k++) sp[k] += e.p[k] * w;
    });
    if (sw === 0) return { p: mp, yaw: my, n: 0 };
    return { p: sp.map((v) => v / sw), yaw: sy / sw, n: L.length };
  }
}

// 세계 광선(원점 o, 방향 d; m) → 도로 면 z=h(cm)과 만나는 도로 좌표 [x,y] 또는 null
export function rayToRoad(A, o, d, h = 0) {
  const O = worldToRoad(A, o);
  const R = levelRotation(A.yaw);
  const D = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
  if (Math.abs(D[2]) < 1e-6) return null;
  const k = (h - O[2]) / D[2];
  if (k <= 0) return null;
  return [O[0] + D[0] * k, O[1] + D[1] * k];
}
