import { createRequire } from 'node:module';
import { toFullRes } from "../src/tracking.js";
import { renderFrame, lookAt, downscale2 } from './render.mjs';
import { DEFAULT_CONFIG as cfg } from '../src/config.js';
import { makeK, estimateFocal, transpose3, mul3, rotToVec } from '../src/geometry.js';
import { solveRoadPose, solveBarricade } from '../src/tracking.js';
const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });

const W = 1280, H = 720, F = 0.8 * W;
const bar = { x: 13, y: 15, angle: Math.PI / 2, width: 10, height: 5.5, z0: 0.3 };
const views = [
  { name: '남동쪽 높이', pos: [40, -12, 32], tgt: [14, 10, 0] },
  { name: '동쪽 낮게', pos: [48, 6, 18], tgt: [14, 11, 0] },
  { name: '가까이 위', pos: [26, -4, 24], tgt: [16, 11, 0] },
];
for (const v of views) {
  const gt = lookAt(v.pos, v.tgt);
  const t0 = Date.now();
  const img = renderFrame({ pose: gt, f: F, w: W, h: H, barricade: bar });
  const small = downscale2(img);
  const ms0 = Date.now();
  const raw = det.detect(small);
  const dms = Date.now() - ms0;
  const markers = raw.map((m) => ({ id: m.id, c: toFullRes(m.corners, 2) }));
  const K = makeK(F, W / 2, H / 2);
  const road = solveRoadPose(markers, cfg.roadMarkers, K);
  const fe = road.H ? estimateFocal(road.H, W / 2, H / 2) : null;
  let line = `[${v.name}] 마커 ${markers.map((m) => m.id).join(',')} · 인식 ${dms}ms · 렌더 ${ms0 - t0}ms`;
  if (!road.pose) { console.log(line, '→ 도로 자세 실패'); continue; }
  const C = (p) => { const R = p.R, t = p.t; return [0, 1, 2].map((i) => -(R[i] * t[0] + R[3 + i] * t[1] + R[6 + i] * t[2])); };
  const cg = C(gt), ce = C(road.pose);
  const posErr = Math.hypot(cg[0] - ce[0], cg[1] - ce[1], cg[2] - ce[2]);
  const dR = mul3(road.pose.R, transpose3(gt.R));
  const angErr = (Math.hypot(...rotToVec(dR)) * 180) / Math.PI;
  line += ` · 카메라 위치 오차 ${posErr.toFixed(2)}cm · 각도 오차 ${angErr.toFixed(2)}° · rms ${road.rms.toFixed(2)}px · f추정 ${fe ? fe.toFixed(0) : '-'} (실제 ${F})`;
  const obs = solveBarricade(markers, cfg.barricade, K, road.pose);
  if (obs) {
    const pe = Math.hypot(obs.x - bar.x, obs.y - bar.y);
    const ae = (Math.acos(Math.min(1, Math.abs(obs.dx * Math.cos(bar.angle) + obs.dy * Math.sin(bar.angle)))) * 180) / Math.PI;
    line += ` · 바리케이드 위치 오차 ${pe.toFixed(2)}cm, 방향 오차 ${ae.toFixed(1)}°`;
  } else line += ' · 바리케이드 못 찾음';
  console.log(line);
}
