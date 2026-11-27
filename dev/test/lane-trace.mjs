// 자동 경로 시험: 가상 디오라마를 여러 위치에서 찍어 도로 평면 영상을 모은 뒤, 두 번 탭(출발점·진행 방향)으로 한 바퀴 추적
//  A. 실제 전시 디오라마처럼: 검은 차선 2개(각 8cm) 사이에 흰 띠(3cm), 바깥쪽도 흰 띠, 바닥은 연회색. 세로로 가로지르는 교차 도로 2개
//  B. 점선형: 검은 2차로 도로, 흰 가장자리 선, 흰 점선 중앙선, 차선 안 화살표
import { RoadMosaic, traceLane } from '../src/lane.js';
import { makeK } from '../src/geometry.js';
import { smoothPath } from '../src/logic.js';
import { lookAt } from './render-lite.mjs';

const RR = { x0: 30, y0: 25, x1: 170, y1: 85, r: 22 };
function sdRoundRect(x, y) {
  const cx = (RR.x0 + RR.x1) / 2, cy = (RR.y0 + RR.y1) / 2;
  const hx = (RR.x1 - RR.x0) / 2 - RR.r, hy = (RR.y1 - RR.y0) / 2 - RR.r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RR.r;
}
const SCENES = {
  A: { laneCenter: 5.5, tex(x, y) { // 흰 띠(-1.5~1.5) | 검은 차선(1.5~9.5) 바깥, 안쪽도 대칭 · 바깥 흰 띠 9.5~12.5
    const d = sdRoundRect(x, y), ad = Math.abs(d);
    // 교차 도로: x=75, x=125 근처 세로 검은 도로(폭 16)가 루프를 가로지름
    const cross = (Math.abs(x - 75) < 8 || Math.abs(x - 125) < 8) && y > 5 && y < 105;
    if (ad < 1.5) return cross ? 50 : 238;
    if (ad < 9.5) return 50;
    if (ad < 12.5) return cross ? 50 : 238;
    if (cross) return 50;
    return 205 + 8 * Math.sin(x * 0.3) * Math.sin(y * 0.2);
  } },
  B: { laneCenter: 4, tex(x, y) {
    const d = sdRoundRect(x, y), ad = Math.abs(d);
    if (ad > 8.6) return 225 + 10 * Math.sin(x * 0.7) * Math.sin(y * 0.9);
    if (ad > 7.4) return 240;
    if (ad < 0.35 && Math.floor((x + y) / 4) % 2 === 0) return 235;
    if (d > 2 && d < 6 && ((((x - y) % 25) + 25) % 25) < 1.2) return 230;
    return 55;
  } },
};
const W = 640, H = 400, F = 0.8 * W, K = makeK(F, W / 2, H / 2);
function render(tex, pose) {
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
for (const [name, sc] of Object.entries(SCENES)) {
  const mosaic = new RoadMosaic({ x0: 0, y0: 0, x1: 200, y1: 110 }, 0.4);
  for (let i = 0; i < 40; i++) {
    const ang = (i / 40) * Math.PI * 2;
    const tgt = [100 + 75 * Math.cos(ang), 55 + 35 * Math.sin(ang), 0];
    const pos = [100 + 120 * Math.cos(ang), 55 + 80 * Math.sin(ang), 45 + 8 * Math.sin(3 * ang)];
    const pose = lookAt(pos, tgt);
    mosaic.accumulate(render(sc.tex, pose), K, pose);
  }
  // 바깥 차선 아래쪽 직선에서 두 번 탭 (±2cm 어긋나게), 오른쪽(+x)으로
  const yLane = RR.y0 - sc.laneCenter;
  for (const [label, a, b] of [['정확히 탭', [60, yLane], [70, yLane]], ['2cm 어긋나게 탭', [60, yLane + 2], [72, yLane - 1.5]], ['교차로 바로 앞에서 출발', [66, yLane + 1], [70, yLane]]]) {
    const r = traceLane(mosaic, a, b, { search: 12, step: 1.2 });
    let line = `${name} · ${label}: `;
    if (!r.ok) { console.log(line + `실패 (${r.reason}, ${r.length.toFixed(0)}cm 진행, 멈춘 곳 ${r.stopAt.map((v) => v.toFixed(0))})`); continue; }
    const dense = smoothPath(r.pts, true, 0.5);
    const errs = dense.map((p) => Math.abs(sdRoundRect(p[0], p[1]) - sc.laneCenter));
    const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
    const trueLen = 2 * (RR.x1 - RR.x0 + RR.y1 - RR.y0) - 8 * RR.r + 2 * Math.PI * (RR.r + sc.laneCenter);
    console.log(line + `한 바퀴 닫힘${r.bridged ? "(출발점 근처 이어 붙임)" : ""} · 길이 ${r.length.toFixed(0)}cm (정답 ${trueLen.toFixed(0)}) · 차선 가운데에서 벗어남 평균제곱근 ${rms.toFixed(2)}cm, 최대 ${Math.max(...errs).toFixed(2)}cm · 차선 폭 ${r.laneWidth.toFixed(1)}cm · 차선 찾은 비율 ${(r.found * 100).toFixed(0)}% · 점 ${r.pts.length}개`);
  }
}
