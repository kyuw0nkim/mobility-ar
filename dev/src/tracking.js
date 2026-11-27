// 프레임 단위 계산 (화면·DOM 없음): 도로 자세, 바리케이드 위치
import {
  homography, poseFromHomography, refinePose, invertPose, composePose,
  transformPoint, mulVec3, markerCorners, flipPose,
} from './geometry.js';

// markers: [{id, c:[[u,v]x4]}] (원본 해상도 좌표)
// 보인 도로 마커의 모서리 ↔ 지도 위치 짝 맞추기 + 호모그래피 (아래 두 함수가 함께 씀)
function roadHomography(markers, roadMarkers) {
  const byId = new Map(roadMarkers.map((m) => [m.id, m]));
  const obj = [], ip = [];
  let count = 0;
  for (const m of markers) {
    const def = byId.get(m.id);
    if (!def) continue;
    count++;
    const cs = markerCorners(def);
    for (let k = 0; k < 4; k++) { obj.push(cs[k]); ip.push(m.c[k]); }
  }
  const H = obj.length >= 4 ? homography(obj.map((p) => [p[0], p[1]]), ip) : null;
  return { count, obj, ip, H };
}

export function solveRoadPose(markers, roadMarkers, K) {
  const { count, obj, ip, H } = roadHomography(markers, roadMarkers);
  if (!H) return { count, pose: null, H: null, nPts: obj.length };
  const pose = refinePose(K, poseFromHomography(H, K), obj, ip, 5);
  const ok = pose.rms < 8 && pose.t[2] > 0;
  return { count, pose: ok ? pose : null, H, nPts: obj.length, rms: pose.rms };
}

// 프레임마다 도로 자세를 구하되, 기울기가 애매할 때(마커 1개·작은 마커) 엉뚱한 해로 튀지 않게 한다.
//  1) 호모그래피 해, 그 거울 해, 직전 프레임 해 — 세 후보를 모두 다듬어 본다
//  2) 재투영 오차가 비슷하면(영상만으로 구분 불가) 직전 프레임의 바닥 기울기에 가까운 해를 고른다
export class RoadPoseTracker {
  constructor() { this.prev = null; this.prevTime = -Infinity; }
  reset() { this.prev = null; }
  update(markers, roadMarkers, K, now) {
    const { count, obj, ip, H } = roadHomography(markers, roadMarkers);
    if (!H) return { count, pose: null, H: null, nPts: obj.length };
    const init = poseFromHomography(H, K);
    const recent = this.prev && now - this.prevTime < 500;
    const starts = [init, flipPose(init, obj), recent ? this.prev : null].filter(Boolean);
    const cands = starts.map((s) => refinePose(K, s, obj, ip, 8)).filter((c) => c.rms < 8 && c.t[2] > 0);
    if (!cands.length) return { count, pose: null, H, nPts: obj.length };
    const minRms = Math.min(...cands.map((c) => c.rms));
    const ref = recent ? [this.prev.R[2], this.prev.R[5], this.prev.R[8]] : null;
    let best;
    if (ref) {
      const tilt = (c) => Math.acos(Math.max(-1, Math.min(1, c.R[2] * ref[0] + c.R[5] * ref[1] + c.R[8] * ref[2])));
      const ok = cands.filter((c) => c.rms <= minRms * 1.3 + 0.7);
      best = ok.reduce((a, c) => (tilt(c) < tilt(a) ? c : a));
    } else {
      best = cands.reduce((a, c) => (c.rms < a.rms ? c : a));
    }
    this.prev = best; this.prevTime = now;
    return { count, pose: best, H, nPts: obj.length, rms: best.rms };
  }
}

// 바닥에 평평히 놓인 마커 하나(경로 카드)의 도로 좌표. 거울 해 중 마커 면이 도로 면과 나란한 쪽을 고른다.
// 반환 {x, y, z, tilt(°)} 또는 null
export function solveFlatMarker(m, size, K, camPose) {
  const local = markerCorners({ x: 0, y: 0, size, rot: 0 });
  const Hm = homography(local.map((p) => [p[0], p[1]]), m.c);
  if (!Hm) return null;
  const init = poseFromHomography(Hm, K);
  const tableFromCam = invertPose(camPose);
  let best = null;
  const cands = [init, flipPose(init, local)].filter(Boolean).map((s) => refinePose(K, s, local, m.c, 8)).filter((c) => c.t[2] > 0 && c.rms < 4);
  if (!cands.length) return null;
  const minRms = Math.min(...cands.map((c) => c.rms));
  for (const pm of cands) {
    if (pm.rms > minRms * 1.5 + 0.5) continue;
    const tm = composePose(tableFromCam, pm);
    const tilt = Math.acos(Math.max(-1, Math.min(1, tm.R[8]))) * 180 / Math.PI;
    if (!best || tilt < best.tilt) { const c = transformPoint(tm, [0, 0, 0]); best = { x: c[0], y: c[1], z: c[2], tilt }; }
  }
  return best;
}

// camPose: 도로 → 카메라. 반환: 도로 좌표의 바리케이드 {x, y, dx, dy, z} 또는 null
export function solveBarricade(markers, bc, K, camPose) {
  const local = markerCorners({ x: 0, y: 0, size: bc.markerSize, rot: 0 });
  const tableFromCam = invertPose(camPose);
  const found = [];
  for (const m of markers) {
    if (!bc.markerIds.includes(m.id)) continue;
    const Hm = homography(local.map((p) => [p[0], p[1]]), m.c);
    if (!Hm) continue;
    const pm = refinePose(K, poseFromHomography(Hm, K), local, m.c, 5);
    if (pm.rms > 6) continue;
    const tm = composePose(tableFromCam, pm);
    const c = transformPoint(tm, [0, 0, 0]);
    const d = mulVec3(tm.R, [1, 0, 0]);
    const L = Math.hypot(d[0], d[1]);
    if (L < 0.3) continue; // 마커가 눕혀져 있으면 방향 판단 불가
    found.push({ x: c[0], y: c[1], z: c[2], dx: d[0] / L, dy: d[1] / L });
  }
  if (!found.length) return null;
  let obs = found[0];
  if (found.length > 1) {
    const f2 = found[1];
    const sgn = f2.dx * obs.dx + f2.dy * obs.dy < 0 ? -1 : 1;
    obs = { x: (obs.x + f2.x) / 2, y: (obs.y + f2.y) / 2, z: (obs.z + f2.z) / 2, dx: obs.dx + sgn * f2.dx, dy: obs.dy + sgn * f2.dy };
    const L = Math.hypot(obs.dx, obs.dy) || 1;
    obs.dx /= L; obs.dy /= L;
  }
  return obs;
}

// 검출기(축소 영상) 모서리 → 원본 해상도 좌표 보정
// 1) 픽셀 중심 규칙 차이(+0.5px) 2) 검출 모서리가 검은 사각형 안쪽으로 약 0.55px(축소 영상 기준) 들어오는 편향
export const CORNER_OUTSET = 0.55;
export function toFullRes(corners, sc) {
  const p = corners.map((q) => [(q.x + 0.5) * sc, (q.y + 0.5) * sc]);
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  return p.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
    return [x + (dx / L) * CORNER_OUTSET * sc, y + (dy / L) * CORNER_OUTSET * sc];
  });
}
