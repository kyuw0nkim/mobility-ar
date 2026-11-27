import { createRequire } from 'node:module';
import { renderBig } from './render-big.mjs';
import { lookAt, downscale2 } from './render.mjs';
import { makeK, project, markerCorners } from '../src/geometry.js';
import { toFullRes } from "../src/tracking.js";
const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
const W = 1280, H = 720, F = 1024, K = makeK(F, W / 2, H / 2);
const GT = [{ id: 0, x: 40, y: 40, rot: 20, size: 10 }, { id: 1, x: 80, y: 50, rot: -30, size: 10 }, { id: 2, x: 120, y: 45, rot: 70, size: 10 }];
const out = [];
for (const [i, pos] of [[0, [80, -40, 70]], [1, [60, -20, 40]], [2, [100, -60, 90]], [3, [80, -10, 100]]]) {
  const pose = lookAt(pos, [80, 45, 0]);
  const img = renderBig({ pose, f: F, w: W, h: H, markers: GT, seed: i + 3 });
  const raw = det.detect(downscale2(img));
  for (const m of raw) {
    const g = GT.find((q) => q.id === m.id); if (!g) continue;
    const truth = markerCorners(g).map((X) => project(K, pose.R, pose.t, X));
    const cx = truth.reduce((a, p) => a + p[0], 0) / 4, cy = truth.reduce((a, p) => a + p[1], 0) / 4;
    m.corners.forEach((p, k) => {
      const fr = toFullRes(m.corners, 2); const u = fr[k][0], v = fr[k][1];
      const dx = truth[k][0] - cx, dy = truth[k][1] - cy, L = Math.hypot(dx, dy);
      out.push({ radial: ((truth[k][0] - u) * dx + (truth[k][1] - v) * dy) / L, ex: truth[k][0] - u, ey: truth[k][1] - v, side: Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]) });
    });
  }
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log('모서리', out.length, '개 · 정답-검출 평균: x', mean(out.map((o) => o.ex)).toFixed(2), 'px, y', mean(out.map((o) => o.ey)).toFixed(2), 'px, 바깥 방향', mean(out.map((o) => o.radial)).toFixed(2), 'px (원본 해상도) · 마커 한 변 평균', mean(out.map((o) => o.side)).toFixed(0), 'px');
