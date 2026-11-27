// 앱에서 실제로 보이는 것(자세 다듬기 후): 기존 vs 새 추적기, 새 추적기 + 마커 1개일 때 더 강하게 다듬기
import * as THREE from 'three';
import { makeWorld, cameraAt, detect, errors, K, reseed } from './pose-sim.mjs';
import { solveRoadPose, RoadPoseTracker } from '../src/tracking.js';
function toQT(p) {
  const m = new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], 0, p.R[3], p.R[4], p.R[5], 0, p.R[6], p.R[7], p.R[8], 0, 0, 0, 0, 1);
  return { q: new THREE.Quaternion().setFromRotationMatrix(m), t: new THREE.Vector3(...p.t) };
}
function fromQT(q, t) { const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements; return { R: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]], t: [t.x, t.y, t.z] }; }
function run(mode, look, world) {
  reseed(77);
  const tr = new RoadPoseTracker();
  let sq = null, st = null, n = 0, pxS = 0, pxMax = 0, prevD = null, jump = 0, jumpN = 0;
  for (let i = 0; i < 300; i++) {
    const { pose } = cameraAt(i / 15, look);
    const ms = detect(world, pose);
    const r = mode === 'old' ? solveRoadPose(ms, world.map, K) : tr.update(ms, world.map, K, (i / 15) * 1000);
    if (r.pose) {
      const { q, t } = toQT(r.pose);
      const a = mode === 'adapt' && r.count < 2 ? 0.25 : 0.45;
      if (!sq) { sq = q; st = t; } else { sq.slerp(q, a); st.lerp(t, a); }
    }
    if (!sq) continue;
    const e = errors(fromQT(sq, st), pose, [look[0], look[1], 0]);
    n++; pxS += e.px ** 2; pxMax = Math.max(pxMax, e.px);
    const d = [e.a[0] - e.b[0], e.a[1] - e.b[1]];
    if (prevD) { jump += Math.hypot(d[0] - prevD[0], d[1] - prevD[1]); jumpN++; }
    prevD = d;
  }
  return `차 위치 오차 ${Math.sqrt(pxS / n).toFixed(0)}px (최대 ${pxMax.toFixed(0)}) · 프레임마다 튐 ${(jump / jumpN).toFixed(1)}px`;
}
for (const ws of [1, 2, 3]) {
  reseed(ws * 1000);
  const world = makeWorld();
  for (const look of [[60, 15], [150, 40]]) {
    console.log(`디오라마 ${ws} · 보는 곳 (${look})`);
    for (const [m, label] of [['old', '기존          '], ['track', '거울해+연속   '], ['adapt', '+마커1개 강하게']]) console.log(`   ${label}`, run(m, look, world));
  }
}
