// AR 지도 만들기 시뮬레이션: 2m x 1m 디오라마 테두리 8cm 마커 18개(가로 변 4 + 세로 변 5)를 한 바퀴 돌며 하나씩 비춤
// 모서리 잡음 0.8px, ARCore 추적 잡음 0.3cm·0.2°, 그리고 천천히 쌓이는 ARCore 위치 밀림(drift)을 넣어 마커 위치 오차를 본다
import { project, markerCorners, transformPoint, rodrigues, mul3 } from '../src/geometry.js';
import { roadToWorld, roadToCv, worldToRoad, CM } from '../src/xr-align.js';
import { XRMarkerMapper } from '../src/xr-mapper.js';
import { gauss, reseed } from './pose-sim.mjs';

const PW = 693, PH = 433, K = [540, 0, PW / 2, 0, 540, PH / 2, 0, 0, 1];
const TRUE = { p: [0.4, -0.8, -1.0], yaw: 0.7 };
const markers = [];
const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19];
let k = 0;
for (let i = 0; i < 4; i++) { markers.push({ id: ids[k++], x: 25 + i * 50, y: -6, rot: 0 }); markers.push({ id: ids[k++], x: 25 + i * 50, y: 106, rot: 180 }); }
for (let i = 0; i < 5; i++) { markers.push({ id: ids[k++], x: -6, y: 5 + i * 22.5, rot: 270 }); markers.push({ id: ids[k++], x: 206, y: 5 + i * 22.5, rot: 90 }); }
const lookAtW = (pos, tgt) => {
  const sub = (a, b) => a.map((v, i) => v - b[i]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (a) => { const L = Math.hypot(...a); return a.map((v) => v / L); };
  const z = norm(sub(tgt, pos)), x = norm(cross(z, [0, 1, 0])), y = cross(z, x);
  return { R: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: pos };
};
for (const driftPerM of [0, 0.01, 0.02]) {
  reseed(42);
  const truth = markers.map((m) => ({ ...m, size: 8, tilt: [gauss() * 1, gauss() * 1] }));
  const mapper = new XRMarkerMapper({ size: 8 });
  // 둘레를 따라 걸으며 각 마커를 앞에서 비춤 (마커 바깥 50cm, 높이 45cm)
  let walked = 0, prev = null, drift = [0, 0, 0];
  const order = truth.slice().sort((a, b) => Math.atan2(a.y - 50, a.x - 100) - Math.atan2(b.y - 50, b.x - 100));
  for (const m of order) {
    const out = [m.x - 100, m.y - 50]; const L = Math.hypot(...out); const dir = out.map((v) => v / L);
    for (let f = 0; f < 10; f++) {
      const camR = [m.x + dir[0] * (45 + gauss() * 3), m.y + dir[1] * (45 + gauss() * 3), 45 + gauss() * 3];
      const camW = roadToWorld(TRUE, camR), tgtW = roadToWorld(TRUE, [m.x - dir[0] * 10, m.y - dir[1] * 10, 0]);
      if (prev) { const step = Math.hypot(camW[0] - prev[0], camW[2] - prev[2]); walked += step; drift = drift.map((d) => d + gauss() * driftPerM * step); }
      prev = camW;
      const wcTrue = lookAtW(camW, tgtW);
      const pose = roadToCv(TRUE, wcTrue);
      const dR = rodrigues([gauss() * 0.0035, gauss() * 0.0035, gauss() * 0.0035]);
      const wcMeas = { R: mul3(dR, wcTrue.R), t: wcTrue.t.map((v, i) => v + gauss() * 0.003 + drift[i]) };
      const obs = [];
      for (const q of truth) {
        const cs = markerCorners(q).map(([x, y]) => [x, y, (x - q.x) * Math.tan(q.tilt[0] * Math.PI / 180) + (y - q.y) * Math.tan(q.tilt[1] * Math.PI / 180)]);
        if (!cs.every((X) => transformPoint(pose, X)[2] > 5)) continue;
        const uv = cs.map((X) => project(K, pose.R, pose.t, X));
        if (!uv.every(([u, v]) => u > 3 && v > 3 && u < PW - 3 && v < PH - 3)) continue;
        obs.push({ id: q.id, c: uv.map(([u, v]) => [u + gauss() * 0.8, v + gauss() * 0.8]) });
      }
      mapper.addFrame(obs, K, wcMeas);
    }
  }
  const res = mapper.solve();
  // 지도 → 세계 → 참 도로 좌표, 이웃 마커 사이 거리·전체 오차
  const pos = new Map(res.markers.map((m) => { const r = worldToRoad(TRUE, roadToWorld(res.align, [m.x, m.y, 0])); return [m.id, r]; }));
  const errs = truth.map((q) => Math.hypot(pos.get(q.id)[0] - q.x, pos.get(q.id)[1] - q.y));
  console.log(`ARCore 밀림 ${(driftPerM * 100).toFixed(0)}%/이동거리 (한 바퀴 ${walked.toFixed(1)}m 걸음): 마커 ${res.markers.length}개 · 위치 오차 평균 ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)}cm, 최대 ${Math.max(...errs).toFixed(2)}cm · 추정 오차 ${res.estErrCm.toFixed(2)}cm`);
}
