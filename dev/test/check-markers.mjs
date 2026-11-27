import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/claude/marker-proto/package.json');
const { AR } = require('js-aruco2');
const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
for (let i = 1; i <= 7; i++) {
  const f = `/home/claude/marker-proto/dist/markers/page-0${i}.svg`;
  const r = new Resvg(readFileSync(f, 'utf8'), { fitTo: { mode: 'width', value: 840 } }).render(); // 4 px/mm
  const m = det.detect({ width: r.width, height: r.height, data: r.pixels });
  console.log(`page ${i}:`, m.map((x) => `id ${x.id}, 검은 변 ${(Math.hypot(x.corners[1].x - x.corners[0].x, x.corners[1].y - x.corners[0].y) / 4).toFixed(1)}mm`).join(' / '));
}
