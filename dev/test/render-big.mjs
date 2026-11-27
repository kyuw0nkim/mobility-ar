// 큰 디오라마 합성 장면: 200x100cm 테이블 테두리에 10cm 마커들
import { Resvg } from '@resvg/resvg-js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const texCache = new Map();
function tex(id) {
  if (!texCache.has(id)) {
    const r = new Resvg(dict.generateSVG(id).replace('<svg ', '<svg width="200" height="200" ')).render();
    texCache.set(id, { w: r.width, h: r.height, data: r.pixels });
  }
  return texCache.get(id);
}
export const TABLE = { w: 200, h: 100 };
export function renderBig({ pose, f, w, h, markers, noise = 3, seed = 1 }) {
  const { R, t } = pose;
  const C = [0, 1, 2].map((i) => -(R[i] * t[0] + R[3 + i] * t[1] + R[6 + i] * t[2]));
  const out = new Uint8ClampedArray(w * h * 4);
  const ms = markers.map((m) => ({ ...m, c: Math.cos((m.rot * Math.PI) / 180), s: Math.sin((m.rot * Math.PI) / 180), half: (m.size * 10) / 16, tx: tex(m.id) }));
  let rnd = seed >>> 0; const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const dc = [(px + 0.5 - w / 2) / f, (py + 0.5 - h / 2) / f, 1];
    const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
    let v = 110;
    if (d[2] < 0) {
      const sc = -C[2] / d[2];
      const x = C[0] + sc * d[0], y = C[1] + sc * d[1];
      if (x >= 0 && x <= TABLE.w && y >= 0 && y <= TABLE.h) {
        v = 205 + 15 * Math.sin(x * 0.7) * Math.sin(y * 0.5);
        for (const m of ms) {
          const dx = x - m.x, dy = y - m.y;
          const lx = m.c * dx + m.s * dy, ly = -m.s * dx + m.c * dy;
          if (Math.abs(lx) < m.half && Math.abs(ly) < m.half) {
            const T = m.tx;
            const tx = Math.min(T.w - 1, Math.max(0, Math.floor((lx / (2 * m.half) + 0.5) * T.w)));
            const ty = Math.min(T.h - 1, Math.max(0, Math.floor((0.5 - ly / (2 * m.half)) * T.h)));
            v = T.data[(ty * T.w + tx) * 4];
            v = v > 128 ? 235 : 25;
          }
        }
      } else v = 90;
    }
    const i = (py * w + px) * 4, n = (rand() - 0.5) * 2 * noise;
    out[i] = out[i + 1] = out[i + 2] = v + n; out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
