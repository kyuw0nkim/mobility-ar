import { DEFAULT_CONFIG as cfg } from '../src/config.js';
import { smoothPath, buildPath, pointAt, CarController, BarricadeTracker, blocksPath } from '../src/logic.js';
const P = buildPath(smoothPath(cfg.path, true, 0.5), true);
const d = cfg.drive;
const clr = cfg.car.width / 2 + d.margin;
const run = (bar, label) => {
  const c = new CarController({ ...d, carLength: cfg.car.length });
  const log = [];
  for (let i = 0; i <= 300; i++) {
    const t = i / 30;
    const b = bar && t >= bar.t0 && (bar.t1 === undefined || t < bar.t1) ? bar : null;
    c.update(1 / 30, P, b, clr);
    if (i % 30 === 0) { const q = pointAt(P, c.s); log.push(`${t.toFixed(0)}s:(${q.x.toFixed(1)},${q.y.toFixed(1)}) ${c.state} v=${c.v.toFixed(2)}`); }
  }
  console.log(label, `경로 길이 ${P.length.toFixed(1)}cm`); console.log(' ' + log.join('\n '));
};
// 윗쪽 직선을 가로막는 바리케이드 (폭 방향 = y축)
run({ x: 13, y: 15, dx: 0, dy: 1, width: 10, t0: 1, t1: 7 }, 'A. 도로를 가로막음 (1~7초)');
// 도로와 나란히, 도로 밖
const side = { x: 13, y: 18.5, dx: 1, dy: 0, width: 10 };
console.log('B. 도로 밖 나란히 → 경로 막힘?', blocksPath(P, side, clr));
// 트래커: 3프레임 확인, 보이는데 안 잡히면 2초 뒤 해제, 화면 밖이면 유지
const tr = new BarricadeTracker(cfg.barricadeTracking);
const o = { x: 13, y: 15, dx: 0, dy: 1 };
let t = 0; const step = (obs, inView, n) => { for (let i = 0; i < n; i++) { t += 33; tr.update(t, obs, inView); } return tr.present; };
console.log('C. 2프레임 후', step(o, true, 2), '/ 3프레임 후', step(o, true, 1), '/ 화면 밖 5초', step(null, false, 150), '/ 화면 안 1초', step(null, true, 30), '/ 화면 안 2.5초', step(null, true, 45));
