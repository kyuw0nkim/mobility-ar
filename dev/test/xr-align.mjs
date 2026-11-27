// AR 버전 위치 맞춤 시험: ARCore 세계에 놓인 2m 디오라마를 휴대폰으로 둘러보며 마커로 맞출 때 오차
// (모서리 잡음 0.8px@640, 마커 지도 오차 0.3cm·0.4°, 마커 들뜸 ±1.5°, ARCore 추적 잡음 0.3cm·0.2°)
import { project, markerCorners, transformPoint, rodrigues, mul3 } from '../src/geometry.js';
import { RoadPoseTracker } from '../src/tracking.js';
import {
  intrinsicsFromProjection, worldFromCv, levelEstimate, AlignmentFuser, roadToWorld, roadToCv, rayToRoad, CM,
} from '../src/xr-align.js';
import { makeWorld, gauss, reseed } from './pose-sim.mjs';

const PW = 640, PH = 400; // 축소 영상
const fx = 520, fy = 520, cx = 322, cy = 198;
const P = new Float32Array(16);
P[0] = 2 * fx / PW; P[5] = 2 * fy / PH; P[8] = 1 - 2 * cx / PW; P[9] = 2 * cy / PH - 1; P[10] = -1; P[11] = -1; P[14] = -0.02;
const K = intrinsicsFromProjection(P, PW, PH);
console.log('K 복원:', K.map((v) => +v.toFixed(2)).join(','), '(기대 fx 520, cx 322, cy 198)');

function viewMatrixFromWc(wc) { // 세계 ← 뷰 (열 우선)
  const R = wc.R;
  return [R[0], R[3], R[6], 0, -R[1], -R[4], -R[7], 0, -R[2], -R[5], -R[8], 0, wc.t[0], wc.t[1], wc.t[2], 1];
}
// 세계에서 카메라 위치·바라보는 점(m) → 세계 ← cv
function lookAtWorld(pos, tgt) {
  const z = norm(sub(tgt, pos)), up = [0, 1, 0];
  const x = norm(cross(z, up)), y = cross(z, x); // cv: y 아래
  return { R: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: pos };
}
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const L = Math.hypot(...a); return a.map((v) => v / L); };

let total = '';
for (const ws of [1, 2, 3]) {
  reseed(ws * 1000);
  const world = makeWorld(); // 마커(설치 위치·들뜸) + 앱이 아는 지도(오차 포함)
  const TRUE = { p: [0.3 * ws, -0.75, -1.2], yaw: 0.6 * ws }; // 테이블 높이 75cm 아래(세계 원점 = 휴대폰 시작 위치)
  // worldFromCv 확인
  const wc0 = lookAtWorld([0, 0, 0], [0, -0.5, -1]);
  const back = worldFromCv(viewMatrixFromWc(wc0));
  if (Math.max(...back.R.map((v, i) => Math.abs(v - wc0.R[i]))) > 1e-9) throw new Error('worldFromCv 불일치');

  const fuser = new AlignmentFuser();
  const tracker = new RoadPoseTracker();
  let frames = 0, used = 0, firstReady = null;
  // 디오라마 앞쪽 가장자리를 따라 걸으며 비춤 (초당 5번 인식, 30초)
  for (let i = 0; i < 150; i++) {
    const tt = i / 5;
    const along = 20 + (tt / 30) * 160; // 도로 x 20→180cm
    const camRoad = [along, -45 + 4 * Math.sin(tt), 50 + 3 * Math.sin(tt * 0.7)];
    const lookRoad = [along + 10 * Math.sin(tt * 0.5), 20 + 10 * Math.sin(tt * 0.3), 0];
    const wcTrue = lookAtWorld(roadToWorld(TRUE, camRoad), roadToWorld(TRUE, lookRoad));
    // ARCore가 알려 주는 자세 (작은 잡음)
    const dR = rodrigues([gauss() * 0.0035, gauss() * 0.0035, gauss() * 0.0035]);
    const wcMeas = worldFromCv(viewMatrixFromWc({ R: mul3(dR, wcTrue.R), t: wcTrue.t.map((v) => v + gauss() * 0.003) }));
    // 실제 장면: 도로 → cv (참값)
    const pose = roadToCv(TRUE, wcTrue);
    const ms = [];
    for (const m of world.truth) {
      const cs = markerCorners(m).map(([x, y]) => { const dx = x - m.x, dy = y - m.y; return [x, y, m.dz + dx * Math.tan(m.tiltY * Math.PI / 180) + dy * Math.tan(m.tiltX * Math.PI / 180)]; });
      if (!cs.every((X) => transformPoint(pose, X)[2] > 5)) continue;
      const uv = cs.map((X) => project(K, pose.R, pose.t, X));
      if (!uv.every(([u, v]) => u > 3 && v > 3 && u < PW - 3 && v < PH - 3)) continue;
      const side = Math.min(...uv.map((p, k) => Math.hypot(p[0] - uv[(k + 1) % 4][0], p[1] - uv[(k + 1) % 4][1])));
      if (side < 20) continue;
      ms.push({ id: m.id, c: uv.map(([u, v]) => [u + gauss() * 0.8, v + gauss() * 0.8]) });
    }
    frames++;
    const r = tracker.update(ms, world.map, K, tt * 1000);
    if (!r.pose) continue;
    const vis = world.map.filter((m) => ms.some((q) => q.id === m.id));
    const anchor = [vis.reduce((s, m) => s + m.x, 0) / vis.length, vis.reduce((s, m) => s + m.y, 0) / vis.length, 0];
    if (fuser.add(levelEstimate(r.pose, wcMeas, anchor), r.count)) used++;
    if (fuser.ready && firstReady === null) firstReady = tt;
  }
  const A = fuser.result;
  // 디오라마 곳곳(도로 위 점)에서 위치 오차
  const pts = []; for (let x = 20; x <= 180; x += 40) for (let y = 15; y <= 85; y += 35) pts.push([x, y, 0]);
  const errs = pts.map((X) => { const a = roadToWorld(A, X), b = roadToWorld(TRUE, X); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / CM; });
  const yawErr = Math.abs(Math.atan2(Math.sin(A.yaw - TRUE.yaw), Math.cos(A.yaw - TRUE.yaw))) * 180 / Math.PI;
  // 탭 → 도로 좌표 왕복
  const camW = roadToWorld(TRUE, [100, -40, 50]), tgtW = roadToWorld(TRUE, [100, 30, 0]);
  const hit = rayToRoad(A, camW, norm(sub(tgtW, camW)), 0);
  const line = `디오라마 ${ws}: 인식 ${frames}회 중 사용 ${used} · 맞춤 완료까지 ${firstReady}초 · 위치 오차 평균 ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)}cm, 최대 ${Math.max(...errs).toFixed(2)}cm · 방향 오차 ${yawErr.toFixed(2)}° · 탭 (100,30) → (${hit.map((v) => v.toFixed(1)).join(',')})`;
  console.log(line);
}
