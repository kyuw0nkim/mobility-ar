// 가짜 ARCore 깊이 인식용: make-frames-dio.mjs와 같은 자세로 본 전시 디오라마 장면의 깊이 지도 (160×100, mm)
// 출력: depth-dio.bin (Uint16 연속), depth-dio.json ({DW, DH})
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { depthDiorama } from '../diorama-scene.mjs';
import { worldFromCv, roadToCv } from '../../src/xr-align.js';
const meta = JSON.parse(readFileSync(new URL('./meta-dio.json', import.meta.url)));
const DW = 160, DH = 100, F = meta.P[0] * meta.W / 2;
const fd = openSync(new URL('./depth-dio.bin', import.meta.url).pathname, 'w');
for (let i = 0; i < meta.N; i++) {
  const pose = roadToCv(meta.TRUE, worldFromCv(meta.views[i]));
  writeSync(fd, Buffer.from(depthDiorama(pose, { f: F, w: meta.W, h: meta.H, dw: DW, dh: DH, seed: i + 1 }).buffer));
}
closeSync(fd);
writeFileSync(new URL('./depth-dio.json', import.meta.url).pathname, JSON.stringify({ DW, DH }));
console.log('depth frames', meta.N, DW, DH);
