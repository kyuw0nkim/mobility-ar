import { openSync, writeSync, closeSync } from 'node:fs';
import { renderFrame, lookAt } from './render.mjs';
const W = 1280, H = 720, FPS = 15, SEC = 12, F = 0.8 * W;
const fd = openSync(new URL('./cam.y4m', import.meta.url).pathname, 'w');
writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
const bar = { x: 13, y: 15, angle: Math.PI / 2, width: 10, height: 5.5, z0: 0.3 };
const Y = new Uint8Array(W * H), U = new Uint8Array(W * H / 4), V = new Uint8Array(W * H / 4);
for (let i = 0; i < FPS * SEC; i++) {
  const t = i / FPS;
  const pos = [40 + 4 * Math.sin(0.5 * t), -12 + 3 * Math.cos(0.4 * t), 32 + 2 * Math.sin(0.3 * t)];
  const img = renderFrame({ pose: lookAt(pos, [14, 10, 0]), f: F, w: W, h: H, barricade: t >= 2 && t < 7 ? bar : null, seed: i + 1 });
  const d = img.data;
  for (let p = 0; p < W * H; p++) Y[p] = 16 + 0.257 * d[p * 4] + 0.504 * d[p * 4 + 1] + 0.098 * d[p * 4 + 2];
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
    const p = (2 * y * W + 2 * x) * 4, r = d[p], g = d[p + 1], b = d[p + 2];
    U[y * W / 2 + x] = 128 - 0.148 * r - 0.291 * g + 0.439 * b;
    V[y * W / 2 + x] = 128 + 0.439 * r - 0.368 * g - 0.071 * b;
  }
  writeSync(fd, 'FRAME\n'); writeSync(fd, Y); writeSync(fd, U); writeSync(fd, V);
}
closeSync(fd);
console.log('video ok');
