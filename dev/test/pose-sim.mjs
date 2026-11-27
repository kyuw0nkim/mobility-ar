// 손에 든 휴대폰(세로, 720x1280)으로 2m x 1m 디오라마 가장자리에서 도로를 볼 때의 자세 정확도 시험.
// 테두리에 10cm 마커 14개, 화면에는 보통 1~2개. 모서리 검출 잡음, 마커 지도 오차, 마커 들뜸(기울기)을 넣는다.
import { project, makeK, markerCorners, transformPoint } from '../src/geometry.js';
import { solveRoadPose } from '../src/tracking.js';
import { lookAt } from './render-lite.mjs';

export const W = 720, H = 1280, F = 0.8 * 1280;
export const K = makeK(F, W / 2, H / 2);
let seed = 11;
export const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
export function reseed(s) { seed = s; }

// 실제 마커(설치 위치) — 지도(앱이 아는 위치)는 여기에 오차를 더한 것
export function makeWorld() {
  const truth = [];
  const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];
  const pos = [];
  for (let i = 0; i < 4; i++) pos.push([20 + i * 53, -6, 0], [20 + i * 53, 106, 180]);
  for (let i = 0; i < 3; i++) pos.push([-6, 20 + i * 30, 270], [206, 20 + i * 30, 90]);
  pos.forEach(([x, y, rot], k) => {
    // 들뜸: 마커 면이 ±1.5° 기울어짐, 높이 ±0.1cm
    truth.push({ id: ids[k], x, y, size: 10, rot, tiltX: gauss() * 1.5, tiltY: gauss() * 1.5, dz: gauss() * 0.1 });
  });
  const map = truth.map((m) => ({ id: m.id, x: m.x + gauss() * 0.3, y: m.y + gauss() * 0.3, size: 10, rot: m.rot + gauss() * 0.4 }));
  return { truth, map };
}
function trueCorners(m) {
  const cs = markerCorners(m);
  const ax = m.tiltX * Math.PI / 180, ay = m.tiltY * Math.PI / 180;
  return cs.map(([x, y]) => { const dx = x - m.x, dy = y - m.y; return [x, y, m.dz + dx * Math.tan(ay) + dy * Math.tan(ax)]; });
}

// 카메라: 디오라마 앞쪽(y<0)에 선 사람이 도로 한 곳을 비춤. 손떨림 포함
export function cameraAt(time, look) {
  const pos = [look[0] + 6 * Math.sin(time * 0.7) + 0.4 * gauss(), -45 + 3 * Math.sin(time * 0.5) + 0.4 * gauss(), 50 + 2 * Math.sin(time * 0.9) + 0.4 * gauss()];
  const tgt = [look[0] + 1.5 * gauss(), look[1] + 1.5 * gauss(), 0];
  return { pose: lookAt(pos, tgt), pos };
}

// 그 장면에서 검출되는 마커 (모서리 잡음 sigma px)
export function detect(world, pose, sigma = 0.8) {
  const out = [];
  for (const m of world.truth) {
    const cs = trueCorners(m);
    const ok = cs.every((X) => transformPoint(pose, X)[2] > 5);
    if (!ok) continue;
    const uv = cs.map((X) => project(K, pose.R, pose.t, X));
    if (!uv.every(([u, v]) => u > 3 && v > 3 && u < W - 3 && v < H - 3)) continue;
    const side = Math.min(...uv.map((p, i) => Math.hypot(p[0] - uv[(i + 1) % 4][0], p[1] - uv[(i + 1) % 4][1])));
    if (side < 24) continue; // 축소 영상(640)에서 약 20px 미만이면 검출 안 됨
    out.push({ id: m.id, c: uv.map(([u, v]) => [u + gauss() * sigma, v + gauss() * sigma]) });
  }
  return out;
}

// 화면에서 차(도로 위 점)가 실제와 몇 px 어긋나는지, 바닥 기울기가 몇 도 틀렸는지
export function errors(est, truePose, point) {
  const a = project(K, est.R, est.t, point), b = project(K, truePose.R, truePose.t, point);
  const nE = [est.R[2], est.R[5], est.R[8]], nT = [truePose.R[2], truePose.R[5], truePose.R[8]];
  const tilt = Math.acos(Math.min(1, nE[0] * nT[0] + nE[1] * nT[1] + nE[2] * nT[2])) * 180 / Math.PI;
  return { px: Math.hypot(a[0] - b[0], a[1] - b[1]), tilt, a, b };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const world = makeWorld();
  const looks = [[60, 15], [100, 25], [150, 40]];
  for (const look of looks) {
    let n = 0, fails = 0, tiltS = 0, tiltBig = 0, pxS = 0, pxMax = 0, nm = 0;
    let prevErr = null, jump = 0, jumpN = 0;
    for (let i = 0; i < 300; i++) {
      const { pose } = cameraAt(i / 15, look);
      const ms = detect(world, pose);
      const r = solveRoadPose(ms, world.map, K);
      if (!r.pose) { fails++; prevErr = null; continue; }
      const e = errors(r.pose, pose, [look[0], look[1], 0]);
      n++; nm += r.count; tiltS += e.tilt ** 2; pxS += e.px ** 2; pxMax = Math.max(pxMax, e.px); if (e.tilt > 5) tiltBig++;
      const d = [e.a[0] - e.b[0], e.a[1] - e.b[1]];
      if (prevErr) { jump += Math.hypot(d[0] - prevErr[0], d[1] - prevErr[1]); jumpN++; }
      prevErr = d;
    }
    console.log(`보는 곳 (${look}) · 보이는 마커 평균 ${(nm / n).toFixed(1)}개 · 못 잡음 ${fails}/300`);
    console.log(`  바닥 기울기 오차 평균제곱근 ${Math.sqrt(tiltS / n).toFixed(1)}° · 5° 넘게 틀어짐 ${(tiltBig / n * 100).toFixed(0)}%`);
    console.log(`  차 위치 화면 오차 평균제곱근 ${Math.sqrt(pxS / n).toFixed(0)}px · 최대 ${pxMax.toFixed(0)}px · 프레임마다 튐 평균 ${(jump / jumpN).toFixed(1)}px`);
  }
}
