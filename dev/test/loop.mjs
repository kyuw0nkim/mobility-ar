// 한 바퀴 중앙선 찾기 시험: 전시 디오라마를 본뜬 가상 장면을 한 바퀴 걸으며 찍은 영상(make-frames-dio.mjs)으로
// 도로 영상을 모으고(범위 자동 확장), 탭 없이 중앙선 고리를 찾아 정답과 비교
// 먼저: node test/xr-mock/make-frames-dio.mjs
import { readFileSync } from 'node:fs';
import { RoadMosaic } from '../src/lane.js';
import { findCenterLoop } from '../src/loop.js';
import { smoothPath } from '../src/logic.js';
import { worldFromCv, roadToCv, intrinsicsFromProjection } from '../src/xr-align.js';
import { centerDist, truthLoop } from './diorama-scene.mjs';

const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta-dio.json', import.meta.url)));
const buf = readFileSync(new URL('./xr-mock/frames-dio.bin', import.meta.url));
const { W, H, N } = meta;
const K = intrinsicsFromProjection(meta.P, W, H);
const truth = truthLoop(1);

function evaluate(res) {
  const dense = smoothPath(res.pts, true, 0.5);
  const e = dense.map((p) => Math.abs(centerDist(p[0], p[1])));
  const rms = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);
  // 정답 중앙선 중 찾은 고리에서 3cm 안인 비율
  let near = 0;
  for (const q of truth) { let m = Infinity; for (const p of dense) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < m) m = d; } if (m < 9) near++; }
  const p95 = e.slice().sort((a, b) => a - b)[Math.floor(e.length * 0.95)];
  return `중앙선에서 벗어남 평균제곱근 ${rms.toFixed(2)}cm · 95% ${p95.toFixed(2)}cm · 최대 ${Math.max(...e).toFixed(2)}cm · 정답 고리 덮음 ${((near / truth.length) * 100).toFixed(0)}%`;
}

function build(frac, { cell = 0.4, poseNoise = 0 } = {}) {
  const m = new RoadMosaic({ x0: 0, y0: 0, x1: 60, y1: 60 }, cell, { grow: true });
  const n = Math.round(N * frac);
  let s = 99; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  for (let i = 0; i < n; i++) {
    const img = { width: W, height: H, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * W * H * 4, W * H * 4) };
    const pose = roadToCv(meta.TRUE, worldFromCv(meta.views[i]));
    if (poseNoise) pose.t = pose.t.map((v) => v + rnd() * 2 * poseNoise);
    m.accumulate(img, K, pose);
  }
  return m;
}

for (const [label, frac, opts] of [['한 바퀴 전부', 1, {}], ['한 바퀴, 장면마다 위치 잡음 ±0.5cm', 1, { poseNoise: 0.5 }], ['칸 0.5cm', 1, { cell: 0.5 }], ['3/4 바퀴만', 0.75, {}], ['절반만 걸음 (건너편은 멀리서 봄)', 0.4, {}]]) {
  const t0 = performance.now();
  const m = build(frac, opts);
  const t1 = performance.now();
  for (const roadWidth of [24, 18, 36]) {
    const t2 = performance.now();
    const r = findCenterLoop(m, { roadWidth });
    const t3 = performance.now();
    if (!r.pts) { console.log(`${label} · 폭 가정 ${roadWidth}cm: 못 찾음(${r.reason})`); continue; }
    console.log(`${label} · 폭 가정 ${roadWidth}cm: ${r.ok ? '찾음' : `못 찾음(${r.reason})`} · 길이 ${(r.length / 100).toFixed(2)}m (정답 ${(truth.length / 100).toFixed(2)}m) · 각도 ${(r.found * 100).toFixed(0)}% · 다듬기 ${(r.refined * 100).toFixed(0)}% · 가장 긴 빈 곳 ${r.maxGapCm.toFixed(0)}cm · ${evaluate(r)} · 계산 ${(t3 - t2).toFixed(0)}ms`);
  }
  console.log(`  (도로 영상: ${m.nx}x${m.ny}칸, 모으기 ${(t1 - t0).toFixed(0)}ms)`);
}
