// 가짜 ARCore 시험용: 전시 디오라마를 본뜬 가상 장면(test/diorama-scene.mjs)을 테이블 둘레로 한 바퀴 걸으며 비춘 영상
// 출력: frames-dio.bin (RGBA 640x400 연속), meta-dio.json (뷰 행렬·투영 행렬·참 정렬값·정답 중앙선·마커)
// 프레임마다 자동 노출처럼 밝기가 조금씩 다름(±12%)
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { lookAt } from '../render.mjs';
import { renderDiorama, walkAround, truthLoop, MARKERS } from '../diorama-scene.mjs';
import { CM, levelRotation } from '../../src/xr-align.js';

const N = +(process.argv[2] || 180), W = 640, H = 400, F = 520;
const TRUE = { p: [-1.3, -0.75, 0.6], yaw: -0.5 }; // 디오라마(도로 좌표) → 세계
const P = new Array(16).fill(0);
P[0] = 2 * F / W; P[5] = 2 * F / H; P[10] = -1.0004; P[11] = -1; P[14] = -0.04;
const L = levelRotation(TRUE.yaw);
const mm = (A, B) => { const C = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return C; };
const tr = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const fd = openSync(new URL('./frames-dio.bin', import.meta.url).pathname, 'w');
const views = [];
const walk = walkAround(N);
let s = 12345;
const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
for (let i = 0; i < N; i++) {
  const pose = lookAt(walk[i].pos, walk[i].target);
  const img = renderDiorama(pose, { f: F, w: W, h: H, gain: 0.88 + 0.24 * rand(), seed: i + 1 });
  writeSync(fd, Buffer.from(img.data.buffer));
  const Rwc = mm(L, tr(pose.R));
  const tw = mv(Rwc, pose.t).map((v, k) => TRUE.p[k] - CM * v);
  views.push([Rwc[0], Rwc[3], Rwc[6], 0, -Rwc[1], -Rwc[4], -Rwc[7], 0, -Rwc[2], -Rwc[5], -Rwc[8], 0, tw[0], tw[1], tw[2], 1]);
  if (i % 30 === 0) process.stdout.write(`${i} `);
}
closeSync(fd);
writeFileSync(new URL('./meta-dio.json', import.meta.url).pathname, JSON.stringify({ W, H, N, P, views, TRUE, truth: truthLoop(2), markers: MARKERS }));
console.log('\ndio frames', N);
