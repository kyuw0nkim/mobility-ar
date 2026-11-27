// 실제 사진에서 노란 줄무늬 덩어리 찾기 (사진은 앱과 같은 크기로 줄인 RGBA 원본: 폭 높이 경로...)
// 사용: node test/color-photos.mjs <출력 png 폴더> <W> <H> <사진.rgba>...
import { readFileSync, writeFileSync } from 'node:fs';
import { findYellowClusters, isYellow } from '../src/barricade-color.js';
const [out, W, H, ...files] = process.argv.slice(2);
for (const f of files) {
  const data = new Uint8ClampedArray(readFileSync(f));
  const img = { width: +W, height: +H, data };
  const t0 = performance.now();
  const cl = findYellowClusters(img);
  const ms = performance.now() - t0;
  let yellow = 0; for (let i = 0; i < data.length; i += 4) if (isYellow(data[i], data[i + 1], data[i + 2])) yellow++;
  console.log(`${f.split('/').pop()}: 노란 픽셀 ${yellow} · 후보 ${cl.length}개 · ${ms.toFixed(1)}ms`);
  cl.forEach((c, i) => console.log(`  후보 ${i + 1}: 노란 픽셀 ${c.pixels} · 노란 조각 ${c.parts}개 · 영역 x ${c.bbox[0]}~${c.bbox[2]}, y ${c.bbox[1]}~${c.bbox[3]}`));
  // 확인용 그림: 노란 픽셀 = 자홍, 후보 영역 = 초록 테두리
  const o = new Uint8ClampedArray(data);
  for (let i = 0; i < o.length; i += 4) if (isYellow(o[i], o[i + 1], o[i + 2])) { o[i] = 255; o[i + 1] = 0; o[i + 2] = 255; }
  for (const c of cl) {
    const [x0, y0, x1, y1] = c.bbox;
    for (let x = x0; x < x1; x++) for (const y of [y0, y0 + 1, y1 - 1, y1 - 2]) { const i = (y * W + x) * 4; o[i] = 0; o[i + 1] = 255; o[i + 2] = 0; }
    for (let y = y0; y < y1; y++) for (const x of [x0, x0 + 1, x1 - 1, x1 - 2]) { const i = (y * W + x) * 4; o[i] = 0; o[i + 1] = 255; o[i + 2] = 0; }
  }
  writeFileSync(`${out}/${f.split('/').pop().replace('.rgba', '')}-mask.rgba`, o);
}
