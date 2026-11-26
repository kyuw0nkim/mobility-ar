// 기존(프레임마다 독립) vs 새 추적기(거울 해 검사 + 직전 프레임)
import { makeWorld, cameraAt, detect, errors, K, reseed } from './pose-sim.mjs';
import { solveRoadPose, RoadPoseTracker } from '../src/tracking.js';

function run(mode, look, world) {
  reseed(77);
  const tr = new RoadPoseTracker();
  let n = 0, tiltS = 0, tiltBig = 0, pxS = 0, pxMax = 0, prevD = null, jump = 0, jumpN = 0, fails = 0;
  for (let i = 0; i < 300; i++) {
    const now = (i / 15) * 1000;
    const { pose } = cameraAt(i / 15, look);
    const ms = detect(world, pose);
    let r;
    if (mode === 'old') r = solveRoadPose(ms, world.map, K);
    else r = tr.update(ms, world.map, K, now);
    if (!r.pose) { fails++; prevD = null; continue; }
    const e = errors(r.pose, pose, [look[0], look[1], 0]);
    n++; tiltS += e.tilt ** 2; pxS += e.px ** 2; pxMax = Math.max(pxMax, e.px); if (e.tilt > 5) tiltBig++;
    const d = [e.a[0] - e.b[0], e.a[1] - e.b[1]];
    if (prevD) { jump += Math.hypot(d[0] - prevD[0], d[1] - prevD[1]); jumpN++; }
    prevD = d;
  }
  return `기울기 오차 ${Math.sqrt(tiltS / n).toFixed(1)}° (5°↑ ${(tiltBig / n * 100).toFixed(0)}%) · 차 위치 ${Math.sqrt(pxS / n).toFixed(0)}px (최대 ${pxMax.toFixed(0)}) · 프레임마다 튐 ${(jump / Math.max(1, jumpN)).toFixed(1)}px`;
}
for (const ws of [1, 2, 3]) {
  reseed(ws * 1000);
  const world = makeWorld();
  console.log(`--- 디오라마 ${ws} (마커 지도 오차·들뜸 무작위)`);
  for (const look of [[60, 15], [150, 40], [190, 70]]) {
    console.log(` 보는 곳 (${look})`);
    for (const [m, label] of [['old', '기존        '], ['track', '거울해+연속 ']]) console.log(`   ${label}`, run(m, look, world));
  }
}
