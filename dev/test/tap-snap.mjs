// 탭 정확도 시험 (전시 디오라마를 본뜬 가상 장면): 사람이 흰 중앙선을 대충 탭했을 때
//  ① 그대로 ② 탭마다 중앙선에 붙이기(snapToStripe) ③ 마지막에 중앙선 맞추기(refineAlongStripe) ④ ②+③
// 탭 간격: 직선 40cm, 곡선 12cm. 탭 오차: 조준점(±1cm), 손가락 태블릿(±2.5cm), 손가락 휴대폰(±5cm), 한쪽으로 쏠림(+4cm)
// 먼저: node test/xr-mock/make-frames-dio.mjs
import { readFileSync } from 'node:fs';
import { RoadMosaic } from '../src/lane.js';
import { snapToStripe, refineAlongStripe, travelGuide } from '../src/loop.js';
import { smoothPath } from '../src/logic.js';
import { worldFromCv, roadToCv, intrinsicsFromProjection } from '../src/xr-align.js';
import { centerDist, truthLoop } from './diorama-scene.mjs';

const meta = JSON.parse(readFileSync(new URL('./xr-mock/meta-dio.json', import.meta.url)));
const buf = readFileSync(new URL('./xr-mock/frames-dio.bin', import.meta.url));
const { W, H, N } = meta;
const K = intrinsicsFromProjection(meta.P, W, H);
const m = new RoadMosaic({ x0: 0, y0: 0, x1: 60, y1: 60 }, 0.4, { grow: true });
for (let i = 0; i < N; i++) {
  const img = { width: W, height: H, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * W * H * 4, W * H * 4) };
  m.accumulate(img, K, roadToCv(meta.TRUE, worldFromCv(meta.views[i])));
}
// 정답 중앙선을 따라 탭 자리 고르기 (곡선은 촘촘히)
const truth = truthLoop(1);
const taps0 = [];
let acc = 0;
for (let i = 0; i < truth.length; i++) {
  const p = truth[i], q = truth[(i + 6) % truth.length], o = truth[(i - 6 + truth.length) % truth.length];
  const turn = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0]) - Math.atan2(p[1] - o[1], p[0] - o[0]));
  const curved = Math.min(turn, 2 * Math.PI - turn) > 0.02;
  acc += 1;
  if (acc >= (curved ? 12 : 40)) { taps0.push(p); acc = 0; }
}
let s = 7; const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) { s = (s * 1664525 + 1013904223) >>> 0; u += s / 4294967296; } return (u - 3) * Math.SQRT2; };
const err = (pts) => {
  const e = smoothPath(pts, true, 0.5).map((p) => Math.abs(centerDist(p[0], p[1]))).sort((a, b) => a - b);
  return `평균제곱근 ${Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length).toFixed(2)}cm · 95% ${e[Math.floor(e.length * 0.95)].toFixed(2)}cm · 최대 ${e[e.length - 1].toFixed(2)}cm`;
};
console.log(`탭 ${taps0.length}개 (고리 ${(truth.length / 100).toFixed(1)}m)`);
for (const [label, sd, bias] of [['조준점 ±1cm', 1, 0], ['손가락(태블릿) ±2.5cm', 2.5, 0], ['손가락(휴대폰) ±5cm', 5, 0], ['한쪽으로 4cm 쏠림 ±1cm', 1, 4]]) {
  const taps = taps0.map((p) => [p[0] + sd * gauss() + bias, p[1] + sd * gauss() + bias]);
  const t0 = performance.now();
  // 앱과 같이: 붙은 점만으로 다음 점을 예상하고, 못 붙은(주황) 점은 [중앙선 맞추기]에서 뺌
  const snapped = [], okPts = [];
  for (const p of taps) {
    const r = snapToStripe(m, p, { roadWidth: 24, guide: travelGuide(okPts, p) });
    snapped.push(r.ok ? [r.x, r.y] : p);
    if (r.ok) okPts.push(snapped[snapped.length - 1]);
  }
  const nSnap = okPts.length;
  const t1 = performance.now();
  const refRaw = refineAlongStripe(m, taps, { roadWidth: 24 });
  const refSnap = refineAlongStripe(m, nSnap >= taps.length * 0.5 ? okPts : snapped, { roadWidth: 24 });
  console.log(`[${label}]`);
  console.log(`  ① 탭 그대로            : ${err(taps)}`);
  console.log(`  ② 탭마다 붙이기         : 붙은 점 ${err(okPts)} (붙음 ${nSnap}/${taps.length}, 탭 하나 ${((t1 - t0) / taps.length).toFixed(0)}ms)`);
  console.log(`  ③ 그대로 → 중앙선 맞추기 : ${err(refRaw.pts)} (확인 ${(refRaw.refined * 100).toFixed(0)}%)`);
  console.log(`  ④ 붙이기 → 중앙선 맞추기 : ${err(refSnap.pts)} (확인 ${(refSnap.refined * 100).toFixed(0)}%)`);
}
