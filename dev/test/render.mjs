// 합성 카메라 영상 렌더러: 책상 위 테스트 시트 + 세워진 바리케이드 면
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { SHEET } from '../src/config.js';

function rasterSvg(path, width) {
  const r = new Resvg(readFileSync(path, 'utf8'), { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
  return { w: r.width, h: r.height, data: r.pixels };
}

const PXCM = 40;
export const sheetTex = rasterSvg(new URL('../dist/sheet-road.svg', import.meta.url).pathname, Math.round(SHEET.width * PXCM));
const bar = rasterSvg(new URL('../dist/sheet-barricade.svg', import.meta.url).pathname, 2100); // 10 px/mm
// 2쪽에서 뒷면(B, 마커 11, 정방향) 잘라내기: x 55..155mm, y 107..162mm
function crop(img, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((y0 + y) * img.w + (x0 + x)) * 4, di = (y * w + x) * 4;
    out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
  }
  return { w, h, data: out };
}
export const faceTex = crop(bar, 550, 1070, 1000, 550);

function sample(tex, x, y) {
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (xx, yy, c) => {
    xx = Math.max(0, Math.min(tex.w - 1, xx)); yy = Math.max(0, Math.min(tex.h - 1, yy));
    return tex.data[(yy * tex.w + xx) * 4 + c];
  };
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = (g(x0, y0, c) * (1 - fx) + g(x0 + 1, y0, c) * fx) * (1 - fy) + (g(x0, y0 + 1, c) * (1 - fx) + g(x0 + 1, y0 + 1, c) * fx) * fy;
  }
  return out;
}

export function lookAt(pos, target) {
  const z = norm(sub(target, pos));
  const x = norm(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  const t = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { R, t };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const L = Math.hypot(...a); return a.map((v) => v / L); };

// barricade: {x, y, angle(rad, 폭 방향), width, height, z0} 또는 null
export function renderFrame({ pose, f, w, h, barricade, noise = 3, seed = 1 }) {
  const { R, t } = pose;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  const out = new Uint8ClampedArray(w * h * 4);
  let b = null;
  if (barricade) {
    const u = [Math.cos(barricade.angle), Math.sin(barricade.angle), 0], v = [0, 0, 1];
    const P0 = [barricade.x, barricade.y, barricade.z0 + barricade.height / 2];
    b = { u, v, n: cross(u, v), P0, W: barricade.width, H: barricade.height };
  }
  let rnd = seed >>> 0;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dc = [(px + 0.5 - w / 2) / f, (py + 0.5 - h / 2) / f, 1];
      const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      let col = [120, 120, 125], best = Infinity;
      if (d[2] < 0) {
        const s = -C[2] / d[2];
        const x = C[0] + s * d[0], y = C[1] + s * d[1];
        best = s;
        if (x >= 0 && x <= SHEET.width && y >= 0 && y <= SHEET.height) col = sample(sheetTex, x * PXCM, (SHEET.height - y) * PXCM);
        else col = [196, 176, 146];
      }
      if (b) {
        const den = dot(d, b.n);
        if (Math.abs(den) > 1e-9) {
          const s = dot(sub(b.P0, C), b.n) / den;
          if (s > 0 && s < best) {
            const hit = [C[0] + s * d[0], C[1] + s * d[1], C[2] + s * d[2]];
            const rel = sub(hit, b.P0);
            const a = dot(rel, b.u), c = dot(rel, b.v);
            if (Math.abs(a) <= b.W / 2 && Math.abs(c) <= b.H / 2) {
              best = s;
              if (den < 0) col = sample(faceTex, (a / b.W + 0.5) * faceTex.w, (0.5 - c / b.H) * faceTex.h);
              else col = [90, 90, 90];
            }
          }
        }
      }
      const i = (py * w + px) * 4;
      const nz = (rand() - 0.5) * 2 * noise;
      out[i] = col[0] + nz; out[i + 1] = col[1] + nz; out[i + 2] = col[2] + nz; out[i + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export function downscale2(img) {
  const w = img.width >> 1, h = img.height >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      const s = (yy, xx) => img.data[(yy * img.width + xx) * 4 + c];
      out[(y * w + x) * 4 + c] = (s(2 * y, 2 * x) + s(2 * y, 2 * x + 1) + s(2 * y + 1, 2 * x) + s(2 * y + 1, 2 * x + 1)) / 4;
    }
  }
  return { width: w, height: h, data: out };
}
