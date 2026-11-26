import { createRequire } from 'node:module';
import { toFullRes } from "../src/tracking.js";
import { renderBig } from './render-big.mjs';
import { lookAt, downscale2 } from './render.mjs';
import { MarkerMapper } from '../src/mapping.js';
const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
// 실제(정답) 마커 배치: 테두리를 따라 약 50cm 간격, 방향은 제각각
const GT = [
  { id: 0, x: 10, y: 7, rot: 0 }, { id: 1, x: 60, y: 6, rot: 12 }, { id: 2, x: 112, y: 7, rot: -8 }, { id: 3, x: 160, y: 6, rot: 90 },
  { id: 4, x: 193, y: 50, rot: 180 }, { id: 5, x: 158, y: 93, rot: 175 }, { id: 6, x: 108, y: 94, rot: -95 }, { id: 7, x: 58, y: 93, rot: 30 },
  { id: 8, x: 9, y: 92, rot: 270 }, { id: 9, x: 7, y: 48, rot: 45 },
].map((m) => ({ ...m, size: 10 }));
const W = 1280, H = 720, F = 0.8 * W;
const mapper = new MarkerMapper({ size: 10, excludeIds: [10, 11] });
const N = Number(process.argv[2] || 220);
let seenTot = 0;
for (let i = 0; i < N; i++) {
  const th = -Math.PI / 2 + (2 * Math.PI * 1.08 * i) / N; // 한 바퀴 + 조금 더 (처음 마커로 돌아옴)
  const pos = [100 + 150 * Math.cos(th), 50 + 105 * Math.sin(th), 70 + 8 * Math.sin(3 * th)];
  const tgt = [100 + 85 * Math.cos(th), 50 + 40 * Math.sin(th), 0];
  const img = renderBig({ pose: lookAt(pos, tgt), f: F, w: W, h: H, markers: GT, seed: i + 7 });
  const raw = det.detect(downscale2(img));
  const ms = raw.map((m) => ({ id: m.id, c: toFullRes(m.corners, 2) })).filter((m) => m.id <= 11);
  seenTot += ms.length;
  mapper.addFrame(ms);
}
const st = mapper.status();
console.log(`프레임 ${N}, 평균 보인 마커 ${(seenTot / N).toFixed(1)}개, 기준 마커 ${st.refId}, 실시간 확인 ${st.confirmed.join(',')}, 대기 ${JSON.stringify(st.pending)}`);
// 실시간 추정 vs 정답
const ref = GT.find((g) => g.id === st.refId);
const toRef = (g) => { const a = (-ref.rot * Math.PI) / 180, dx = g.x - ref.x, dy = g.y - ref.y; return { x: Math.cos(a) * dx - Math.sin(a) * dy, y: Math.sin(a) * dx + Math.cos(a) * dy, rot: g.rot - ref.rot }; };
const report = (label, list) => {
  const errs = list.map((m) => { const g = toRef(GT.find((q) => q.id === m.id)); const da = ((((m.rot - g.rot) % 360) + 540) % 360) - 180; return { id: m.id, d: Math.hypot(m.x - g.x, m.y - g.y), da }; });
  console.log(label, errs.map((e) => `${e.id}:${e.d.toFixed(2)}cm/${e.da.toFixed(1)}°`).join('  '), `| 최대 ${Math.max(...errs.map((e) => e.d)).toFixed(2)}cm`);
};
report('실시간:', [...mapper.est.entries()].filter(([id]) => mapper.confirmed(id)).map(([id, p]) => ({ id, x: p.x, y: p.y, rot: (p.a * 180) / Math.PI })));
const t0 = Date.now(); const res = mapper.solve({ imgW: W, imgH: H }); console.log("보정 시간", Date.now() - t0, "ms, 초점거리", res.focal.toFixed(1), "(실제", F, ")");
report('보정 후:', res.markers);
console.log("재투영 오차 중앙값:", res.errorPx && res.errorPx.toFixed(2), "px, 연결 안 된 마커:", res.unconnected);
