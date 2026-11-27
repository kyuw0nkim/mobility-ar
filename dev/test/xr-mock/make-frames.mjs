// 가짜 ARCore 시험용 장면: A4 시트를 휴대폰으로 비추는 영상(640x400) + 그때의 ARCore 자세
// 출력: test/xr-mock/frames.bin (RGBA 프레임 연속), meta.json (뷰 행렬·투영 행렬·참 정렬값)
// node make-frames.mjs bar → frames-bar.bin, meta-bar.json: 바리케이드 없음 20장 → 도로를 막음 40장 → 치움 40장
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { renderFrame, lookAt } from '../render.mjs';
import { roadToWorld, CM, levelRotation } from '../../src/xr-align.js';

const BAR = process.argv[2] === 'bar';
const W = 640, H = 400, F = 520, N = BAR ? 100 : 40;
// 바리케이드: 시트 윗쪽 직선(y=15)을 가로막음, 뒷면 마커 11이 카메라 쪽
const BARRICADE = { x: 13, y: 15, angle: Math.PI / 2, width: 10, height: 5.5, z0: 0.3 };
const barAt = (i) => (BAR && i >= 20 && i < 60 ? BARRICADE : null);
const TRUE = { p: [0.12, -0.42, -0.35], yaw: 0.4 }; // 디오라마(도로 좌표) → 세계
const P = new Array(16).fill(0);
P[0] = 2 * F / W; P[5] = 2 * F / H; P[8] = 0; P[9] = 0; P[10] = -1.0004; P[11] = -1; P[14] = -0.04;
const L = levelRotation(TRUE.yaw);
const mm = (A, B) => { const C = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return C; };
const tr = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const fd = openSync(new URL(BAR ? './frames-bar.bin' : './frames.bin', import.meta.url).pathname, 'w');
const views = [];
for (let i = 0; i < N; i++) {
  const t = i / 4;
  const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
  const pose = lookAt(pos, [14, 10, 0]); // 도로 → cv (cm)
  const img = renderFrame({ pose, f: F, w: W, h: H, barricade: barAt(i), seed: i + 1 });
  writeSync(fd, Buffer.from(img.data.buffer));
  // 세계 ← cv: R = L Rᵀ, t = p - CM·L Rᵀ t_road
  const Rwc = mm(L, tr(pose.R));
  const tw = mv(Rwc, pose.t).map((v, k) => TRUE.p[k] - CM * v);
  // XR 뷰 행렬(열 우선): 뷰 축 = cv 축에서 y·z 뒤집기
  views.push([Rwc[0], Rwc[3], Rwc[6], 0, -Rwc[1], -Rwc[4], -Rwc[7], 0, -Rwc[2], -Rwc[5], -Rwc[8], 0, tw[0], tw[1], tw[2], 1]);
}
closeSync(fd);
writeFileSync(new URL(BAR ? './meta-bar.json' : './meta.json', import.meta.url).pathname, JSON.stringify({ W, H, N, P, views, TRUE, barricade: BAR ? { ...BARRICADE, frames: [20, 60] } : null }));
console.log('frames ok', N, 'camera world pos[0]', views[0].slice(12, 15).map((v) => v.toFixed(3)));
