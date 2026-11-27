// 차선 맞추기 시험: 가상 디오라마(흰 바닥, 2차로 검은 도로, 흰 가장자리 선, 흰 점선 중앙선, 차선 안 화살표)를
// 여러 카메라 위치에서 찍어 도로 평면 영상을 모은 뒤, 대충 탭한 점(±3cm 오차)을 차선 가운데로 맞춘다.
import { RoadMosaic, snapPathToLane } from '../src/lane.js';
import { makeK } from '../src/geometry.js';
import { smoothPath, buildPath } from '../src/logic.js';
import { lookAt } from './render-lite.mjs';

// 도로 중심선: 둥근 사각형 (x 30..170, y 25..85, 모서리 반지름 22). 차로 폭 8cm × 2
const RR = { x0: 30, y0: 25, x1: 170, y1: 85, r: 22 };
const LANE = 8;
function sdRoundRect(x, y) {
  const cx = (RR.x0 + RR.x1) / 2, cy = (RR.y0 + RR.y1) / 2;
  const hx = (RR.x1 - RR.x0) / 2 - RR.r, hy = (RR.y1 - RR.y0) / 2 - RR.r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RR.r;
}
function tex(x, y) {
  const d = sdRoundRect(x, y); // + 바깥
  const ad = Math.abs(d);
  if (ad > LANE + 0.6) return 225 + 10 * Math.sin(x * 0.7) * Math.sin(y * 0.9); // 흰 레고 바닥
  if (ad > LANE - 0.6) return 240; // 가장자리 흰 선
  if (ad < 0.35 && Math.floor((x + y) / 4) % 2 === 0) return 235; // 점선 중앙선
  // 바깥 차로의 화살표(사선 띠)
  if (d > 2 && d < 6 && ((((x - y) % 25) + 25) % 25) < 1.2) return 230;
  return 55; // 노면
}

// 카메라: 테이블 위 40~60cm, 도로 쪽을 비스듬히
const W = 640, H = 360, F = 0.8 * W;
const K = makeK(F, W / 2, H / 2);
function render(pose) {
  const { R, t } = pose;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  const data = new Uint8ClampedArray(W * H * 4);
  let s = 7;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const dc = [(px + 0.5 - W / 2) / F, (py + 0.5 - H / 2) / F, 1];
    const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
    let v = 90;
    if (d[2] < 0) { const k = -C[2] / d[2]; v = tex(C[0] + k * d[0], C[1] + k * d[1]); }
    s = (s * 1664525 + 1013904223) >>> 0;
    v += ((s / 4294967296) - 0.5) * 16;
    const i = (py * W + px) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

const mosaic = new RoadMosaic({ x0: 0, y0: 0, x1: 200, y1: 110 }, 0.5);
const NF = 40;
for (let i = 0; i < NF; i++) {
  const a = (i / NF) * Math.PI * 2;
  const tgt = [100 + 75 * Math.cos(a), 55 + 35 * Math.sin(a), 0];
  const pos = [100 + 120 * Math.cos(a), 55 + 80 * Math.sin(a), 45 + 8 * Math.sin(3 * a)];
  const pose = lookAt(pos, tgt);
  mosaic.accumulate(render(pose), K, pose);
}

// 정답: 바깥 차로 가운데 (중심선에서 +4cm)
const truth = [];
for (let i = 0; i < 2000; i++) {
  const a = (i / 2000) * Math.PI * 2;
  let lo = 0, hi = 200;
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (sdRoundRect(100 + dx * m, 55 + dy * m) < LANE / 2) lo = m; else hi = m; }
  truth.push([100 + dx * lo, 55 + dy * lo]);
}
const TP = buildPath(truth, true);
const err = (pts) => {
  const P = buildPath(smoothPath(pts, true, 0.5), true);
  const ds = P.pts.map((p) => Math.abs(sdRoundRect(p[0], p[1]) - LANE / 2));
  const rms = Math.sqrt(ds.reduce((s, d) => s + d * d, 0) / ds.length);
  return `평균 제곱근 ${rms.toFixed(2)}cm · 최대 ${Math.max(...ds).toFixed(2)}cm`;
};

let seed = 3;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
for (const nTaps of [10, 16]) {
  const taps = [];
  for (let i = 0; i < nTaps; i++) {
    const p = TP.pts[Math.floor((i / nTaps) * truth.length)];
    taps.push([p[0] + rnd() * 6, p[1] + rnd() * 6]);
  }
  const res = snapPathToLane(mosaic, taps, { search: 12, step: 1 });
  console.log(`탭 ${nTaps}개 (±3cm 오차)`);
  console.log('  탭 그대로     :', err(taps));
  console.log('  차선 맞추기   :', res.ok ? err(res.pts) : res.reason,
    res.ok ? `· 찾은 구간 ${(res.validFrac * 100).toFixed(0)}% · 차선 폭 ${res.laneWidth.toFixed(1)}cm (정답 ${LANE}) · 저장 점 ${res.pts.length}개` : '');
}
console.log('도로 평면 영상: 장면', mosaic.frames, '· 칸', mosaic.nx, 'x', mosaic.ny);
