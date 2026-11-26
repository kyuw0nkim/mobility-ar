// 가짜 ARCore 시험용: A4 시트 위에서 경로 카드(마커 20, 한 변 3cm)를 도로 가운데 6곳으로 옮기며 멈춰 두는 영상
// 출력: frames-card.bin, meta-card.json (카드 자리 정답 포함)
import { writeFileSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { lookAt, sheetTex } from '../render.mjs';
import { CM, levelRotation } from '../../src/xr-align.js';
import { SHEET, ROAD } from '../../src/config.js';
import { roundedRectPath, smoothPath } from '../../src/logic.js';
const { AR } = createRequire(import.meta.url)('js-aruco2');
const W = 640, H = 400, F = 520, CARD = 3; // 카드 마커 검은 사각형 3cm (화면에서 약 30px: 실제 5cm 카드를 50cm에서 볼 때보다 작게)
const TRUE = { p: [0.12, -0.42, -0.35], yaw: 0.4 };
// 마커 20 그림 (흰 테두리 포함 10칸)
const svg = new AR.Dictionary('ARUCO_MIP_36h12').generateSVG(20);
const r = new Resvg(svg, { fitTo: { mode: 'width', value: 200 } }).render();
const mk = { w: r.width, h: r.height, data: r.pixels };
// 카드 자리: 도로 가운데선 위 6곳
const center = smoothPath(roundedRectPath(ROAD.x0, ROAD.y0, ROAD.x1, ROAD.y1, ROAD.r, 8), true, 0.2);
const spots = [0, 0.17, 0.34, 0.5, 0.67, 0.84].map((u) => center[Math.floor(u * center.length)]);
const schedule = []; // 프레임별 카드 위치 또는 null
for (const s of spots) { for (let k = 0; k < 4; k++) schedule.push(null); for (let k = 0; k < 14; k++) schedule.push(s); }
const N = schedule.length;
const PXCM = 40;
const sampleSheet = (x, y) => { // render.mjs의 sample과 같은 방식(가까운 픽셀)
  const px = Math.max(0, Math.min(sheetTex.w - 1, Math.floor(x * PXCM))), py = Math.max(0, Math.min(sheetTex.h - 1, Math.floor((SHEET.height - y) * PXCM)));
  const i = (py * sheetTex.w + px) * 4; return [sheetTex.data[i], sheetTex.data[i + 1], sheetTex.data[i + 2]];
};
const mm = (A, B) => { const C = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return C; };
const tr = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const L = levelRotation(TRUE.yaw);
const P = new Array(16).fill(0); P[0] = 2 * F / W; P[5] = 2 * F / H; P[10] = -1.0004; P[11] = -1; P[14] = -0.04;
const fd = openSync(new URL('./frames-card.bin', import.meta.url).pathname, 'w');
const views = [];
const half = (CARD * 10 / 8) / 2; // 흰 테두리 포함 반쪽 길이
for (let i = 0; i < N; i++) {
  const t = i / 6;
  const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
  const pose = lookAt(pos, [14, 10, 0]);
  const { R, t: tt } = pose;
  const C = [-(R[0] * tt[0] + R[3] * tt[1] + R[6] * tt[2]), -(R[1] * tt[0] + R[4] * tt[1] + R[7] * tt[2]), -(R[2] * tt[0] + R[5] * tt[1] + R[8] * tt[2])];
  const out = Buffer.alloc(W * H * 4);
  const s = schedule[i];
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const dc = [(px + 0.5 - W / 2) / F, (py + 0.5 - H / 2) / F, 1];
    const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
    let col = [120, 120, 125];
    if (d[2] < 0) {
      const k = -C[2] / d[2], x = C[0] + k * d[0], y = C[1] + k * d[1];
      if (s && Math.abs(x - s[0]) < half && Math.abs(y - s[1]) < half) { // 카드 (위쪽 = +y)
        const u = (x - s[0] + half) / (2 * half), v = (s[1] + half - y) / (2 * half);
        const j = (Math.min(mk.h - 1, Math.floor(v * mk.h)) * mk.w + Math.min(mk.w - 1, Math.floor(u * mk.w))) * 4;
        col = [mk.data[j], mk.data[j + 1], mk.data[j + 2]];
      } else if (x >= 0 && x <= SHEET.width && y >= 0 && y <= SHEET.height) col = sampleSheet(x, y);
      else col = [196, 176, 146];
    }
    const o = (py * W + px) * 4; out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  }
  writeSync(fd, out);
  const Rwc = mm(L, tr(R));
  const tw = mv(Rwc, tt).map((v, k) => TRUE.p[k] - CM * v);
  views.push([Rwc[0], Rwc[3], Rwc[6], 0, -Rwc[1], -Rwc[4], -Rwc[7], 0, -Rwc[2], -Rwc[5], -Rwc[8], 0, tw[0], tw[1], tw[2], 1]);
}
closeSync(fd);
writeFileSync(new URL('./meta-card.json', import.meta.url).pathname, JSON.stringify({ W, H, N, P, views, TRUE, card: { size: CARD, spots } }));
console.log('card frames', N, 'spots', spots.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' | '));
