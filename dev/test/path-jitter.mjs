// 차 흔들림 시험: 10cm 마커 디오라마(차 길이 12cm), 탭 위치에 ±1cm 손떨림이 있을 때
// 기존(탭을 그대로 잇고 0.5cm 선분 방향) vs 새(경로 다듬기 + 앞뒤 바퀴 방향)의 차 방향 흔들림
import { roundedRectPath, smoothPath, buildPath, pointAt, carPoseAt } from '../src/logic.js';
const L = 12; // 차 길이 (cm)
const truth = roundedRectPath(20, 20, 180, 90, 25, 8);
const T = buildPath(smoothPath(truth, true, 0.5), true);
let seed = 4; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const taps = [];
for (let i = 0; i < 40; i++) { const q = pointAt(T, (i / 40) * T.length); taps.push([q.x + rnd() * 2, q.y + rnd() * 2]); }
function measure(P, headingAt) {
  // 3cm/s로 30fps 주행할 때 프레임마다 방향 변화 - 정답 경로의 방향 변화
  let sum = 0, mx = 0, n = 0, prev = null;
  for (let s = 0; s < P.length; s += 0.1) {
    const h = headingAt(s);
    if (prev !== null) {
      let d = h - prev; d = Math.atan2(Math.sin(d), Math.cos(d));
      const deg = Math.abs(d) * 180 / Math.PI;
      sum += deg * deg; mx = Math.max(mx, deg); n++;
    }
    prev = h;
  }
  return `프레임당 방향 변화 평균제곱근 ${Math.sqrt(sum / n).toFixed(2)}° · 최대 ${mx.toFixed(1)}°`;
}
const Pold = buildPath(smoothPath(taps, true, 0.5), true);
const Pnew = buildPath(smoothPath(taps, true, 0.5, L * 0.3), true);
console.log('정답 경로      :', measure(T, (s) => carPoseAt(T, s, L * 0.6).heading));
console.log('기존           :', measure(Pold, (s) => pointAt(Pold, s).heading));
console.log('경로 다듬기만  :', measure(Pnew, (s) => pointAt(Pnew, s).heading));
console.log('새 (다듬기+바퀴):', measure(Pnew, (s) => carPoseAt(Pnew, s, L * 0.6).heading));

// 실제 탭 방식: 곡선은 촘촘히(모서리마다 7점), 직선은 양 끝만 (±1cm 손떨림)
const taps2 = [];
const corners = [[155, 45, -Math.PI / 2], [155, 65, 0], [45, 65, Math.PI / 2], [45, 45, Math.PI]];
for (const [cx, cy, a0] of corners) for (let k = 0; k <= 6; k++) { const a = a0 + (k / 6) * Math.PI / 2; taps2.push([cx + 25 * Math.cos(a) + rnd() * 2, cy + 25 * Math.sin(a) + rnd() * 2]); }
const P2old = buildPath(smoothPath(taps2, true, 0.5), true);
const P2new = buildPath(smoothPath(taps2, true, 0.5, L * 0.3), true);
console.log('\n곡선 촘촘·직선 듬성 탭');
console.log('새 (다듬기+바퀴):', measure(P2new, (s) => carPoseAt(P2new, s, L * 0.6).heading));
console.log('경로 길이', P2new.length.toFixed(1), 'cm (정답', T.length.toFixed(1), 'cm)');
