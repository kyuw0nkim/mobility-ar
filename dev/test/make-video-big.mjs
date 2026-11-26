import { openSync, writeSync, closeSync } from 'node:fs';
import { renderBig } from './render-big.mjs';
import { lookAt } from './render.mjs';
export const GT = [
  { id: 0, x: 10, y: 7, rot: 0 }, { id: 1, x: 60, y: 6, rot: 12 }, { id: 2, x: 112, y: 7, rot: -8 }, { id: 3, x: 160, y: 6, rot: 90 },
  { id: 4, x: 193, y: 50, rot: 180 }, { id: 5, x: 158, y: 93, rot: 175 }, { id: 6, x: 108, y: 94, rot: -95 }, { id: 7, x: 58, y: 93, rot: 30 },
  { id: 8, x: 9, y: 92, rot: 270 }, { id: 9, x: 7, y: 48, rot: 45 },
].map((m) => ({ ...m, size: 10 }));
if (process.argv[1].endsWith('make-video-big.mjs')) {
  const W = 1280, H = 720, F = 1024, N = 240;
  const fd = openSync('/home/claude/marker-proto/test/big.y4m', 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`);
  const Y = new Uint8Array(W * H), UV = new Uint8Array(W * H / 2).fill(128);
  for (let i = 0; i < N; i++) {
    const th = -Math.PI / 2 + (2 * Math.PI * 1.08 * i) / N;
    const pos = [100 + 150 * Math.cos(th), 50 + 105 * Math.sin(th), 70 + 8 * Math.sin(3 * th)];
    const img = renderBig({ pose: lookAt(pos, [100 + 85 * Math.cos(th), 50 + 40 * Math.sin(th), 0]), f: F, w: W, h: H, markers: GT, seed: i + 7 });
    for (let p = 0; p < W * H; p++) Y[p] = 16 + 0.859 * img.data[p * 4];
    writeSync(fd, 'FRAME\n'); writeSync(fd, Y); writeSync(fd, UV);
  }
  closeSync(fd); console.log('ok');
}
