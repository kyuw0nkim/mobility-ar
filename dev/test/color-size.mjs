// 크기 확인 시험: 같은 카메라에서 (1) 디오라마 위 바리케이드 패널 (2) 테이블 너머 바닥의 노란 의자
// 둘 다 노란 덩어리로 잡혀 '패널 높이 면'에 투영했을 때 디오라마 안에 떨어지더라도, 의자는 크기가 안 맞아 걸러져야 함
import { plausibleSize, clusterToRoad } from '../src/barricade-color.js';
import { lookAt } from './render-lite.mjs';
import { makeK, project } from '../src/geometry.js';
const K = makeK(540, 346, 216);
const cam = lookAt([100, -40, 45], [100, 60, 0]); // 디오라마(200x100) 앞에서 비스듬히
const zPanel = 4, panelH = 3;
// 가짜 덩어리: 물체의 세로 양 끝을 투영해 조각 높이(px)와 가운데 점으로 만든다
function blob(center, heightCm) {
  const a = project(K, cam.R, cam.t, [center[0], center[1], center[2] - heightCm / 2]);
  const b = project(K, cam.R, cam.t, [center[0], center[1], center[2] + heightCm / 2]);
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { partH: Math.abs(a[1] - b[1]), pts: [[m[0] - 3, m[1], 1], [m[0] + 3, m[1], 1], [m[0], m[1] + 1, 1]] };
}
const panel = blob([100, 30, zPanel], panelH);
const chair = blob([100, 260, -35], 40); // 테이블 너머 2m, 바닥 위 의자 (테이블 면보다 35cm 아래 가운데)
for (const [name, c] of [['바리케이드 패널', panel], ['테이블 너머 노란 의자', chair]]) {
  const r = clusterToRoad(c, K, cam, zPanel);
  const inside = r && r.x > 0 && r.x < 200 && r.y > 0 && r.y < 100;
  console.log(`${name}: 투영 위치 (${r.x.toFixed(0)}, ${r.y.toFixed(0)})cm · 디오라마 안 ${inside} · 크기 확인 ${plausibleSize(c, r, K, cam, zPanel, panelH)}`);
}
console.log('--- 의자 위치를 바꿔 가며: 디오라마 안에 떨어지는 경우만');
let n = 0, rej = 0;
for (const y of [110, 130, 160, 200, 260]) for (const zc of [-35, -20, -5]) for (const cam2 of [[100, -40, 45], [100, -60, 70], [30, -30, 40]]) {
  const C = lookAt(cam2, [100, 50, 0]);
  const a = project(K, C.R, C.t, [100, y, zc - 20]), b = project(K, C.R, C.t, [100, y, zc + 20]);
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const c = { partH: Math.abs(a[1] - b[1]), pts: [[m[0] - 3, m[1], 1], [m[0] + 3, m[1], 1], [m[0], m[1] + 1, 1]] };
  const r = clusterToRoad(c, K, C, zPanel);
  if (!r || !(r.x > 0 && r.x < 200 && r.y > 0 && r.y < 100)) continue;
  n++; if (!plausibleSize(c, r, K, C, zPanel, panelH)) rej++;
}
console.log(`디오라마 안에 투영된 의자 ${n}경우 중 크기 확인으로 걸러짐 ${rej}`);
// 반대로 진짜 패널은 여러 위치·카메라에서 통과해야 함
let m2 = 0, ok = 0;
for (const x of [20, 60, 100, 140, 180]) for (const y of [15, 50, 85]) for (const cam2 of [[100, -40, 45], [100, -60, 70], [30, -30, 40], [180, 130, 50]]) {
  const C = lookAt(cam2, [x, y, 0]);
  const a = project(K, C.R, C.t, [x, y, zPanel - panelH / 2]), b = project(K, C.R, C.t, [x, y, zPanel + panelH / 2]);
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const k of [0.5, 1]) { // 체크무늬형(조각 = 패널 절반)과 줄무늬형
    const c = { partH: Math.abs(a[1] - b[1]) * k, pts: [[m[0] - 3, m[1], 1], [m[0] + 3, m[1], 1], [m[0], m[1] + 1, 1]] };
    const r = clusterToRoad(c, K, C, zPanel); m2++; if (r && plausibleSize(c, r, K, C, zPanel, panelH)) ok++;
  }
}
console.log(`진짜 패널 ${m2}경우 중 통과 ${ok}`);
