// 도안 스캔: 카메라(또는 사진)에서 네 모서리 표식을 찾아 종이를 반듯하게 편다 → 3D 차 텍스처
//  1) 표식(ArUco 60~63)을 찾는다. 3개 이상이면 펼 수 있고, 4개가 몇 프레임 이어서 보이면 저절로 찍는다
//  2) 찍을 때는 원본 해상도로 다시 찾아 모서리를 정확히 잡고, 표식 귀퉁이(최대 16점)로 종이 → 사진 호모그래피를 구한다
//  3) 종이 mm 격자마다 사진의 그 자리를 읽어 반듯한 그림(SHEET × scale px)을 만든다 + 조명 색 보정
import { homography, applyH } from './geometry.js';
import { SHEET, MARKERS, MARKER_IDS, markerPaperCorners } from './car-template.js';
import { toFullRes } from './tracking.js';

const byId = new Map(MARKERS.map((m) => [m.id, m]));

// 검출 결과(축소 영상 기준, sc = 원본/축소)에서 도안 표식만 → [{id, c: [[x,y]×4] (원본 px)}]
export function sheetMarkers(detected, sc = 1) {
  const seen = new Set(), out = [];
  for (const m of detected) {
    if (!byId.has(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, c: toFullRes(m.corners, sc) });
  }
  return out;
}

// 종이(mm) → 사진(px) 호모그래피. 표식 3개 이상
export function sheetHomography(markers) {
  if (markers.length < 3) return null;
  const src = [], dst = [];
  for (const m of markers) {
    const pc = markerPaperCorners(byId.get(m.id));
    for (let i = 0; i < 4; i++) { src.push(pc[i]); dst.push(m.c[i]); }
  }
  const H = homography(src, dst);
  if (!H) return null;
  // 맞음 확인: 귀퉁이 오차 (사진 px). 표식 크기에 비해 크면 잘못 찾은 것
  let err = 0;
  for (let i = 0; i < src.length; i++) { const p = applyH(H, src[i][0], src[i][1]); err = Math.max(err, Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1])); }
  const side = Math.hypot(dst[1][0] - dst[0][0], dst[1][1] - dst[0][1]);
  return { H, err, ok: err < Math.max(4, side * 0.25) };
}

// 사진(ImageData) + H → 반듯한 종이 그림 (ImageData, SHEET × scale)
export function rectify(img, H, scale = 4) {
  const W = Math.round(SHEET.w * scale), Ht = Math.round(SHEET.h * scale);
  const out = new Uint8ClampedArray(W * Ht * 4);
  const src = img.data, sw = img.width, sh = img.height;
  for (let y = 0; y < Ht; y++) {
    const py = (y + 0.5) / scale;
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / scale;
      const w = H[6] * px + H[7] * py + H[8];
      let u = (H[0] * px + H[1] * py + H[2]) / w - 0.5, v = (H[3] * px + H[4] * py + H[5]) / w - 0.5;
      const o = (y * W + x) * 4;
      if (!(u >= 0 && v >= 0 && u < sw - 1 && v < sh - 1)) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) {
        const a = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
        const b = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
        out[o + k] = a + (b - a) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: W, height: Ht, data: out };
}

// 조명 색 보정: 종이 흰색이 흰색, 표식 검정이 검정이 되게 채널마다 늘리고, 색연필 색이 살게 채도를 조금 올림
export function normalizeColors(img, { satBoost = 1.25 } = {}) {
  const d = img.data, n = d.length / 4;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) hist[k][d[i * 4 + k]]++;
  const pct = (h, q) => { let s = 0; const t = n * q; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= t) return v; } return 255; };
  const lo = hist.map((h) => pct(h, 0.01)), hi = hist.map((h) => pct(h, 0.85)); // 종이는 대부분 흰색
  const lut = hist.map((_, k) => {
    const a = Math.min(lo[k], hi[k] - 40), b = Math.max(hi[k], a + 40);
    return Uint8ClampedArray.from({ length: 256 }, (_, v) => ((v - a) / (b - a)) * 250);
  });
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = lut[0][d[o]], g = lut[1][d[o + 1]], b = lut[2][d[o + 2]];
    const m = (r + g + b) / 3;
    d[o] = m + (r - m) * satBoost; d[o + 1] = m + (g - m) * satBoost; d[o + 2] = m + (b - m) * satBoost;
  }
  return { lo, hi };
}

// 사진 한 장(ImageData)에서 바로: 찾기 → 펴기 → 색 보정. detector: AR.Detector
export function scanImage(detector, img, scale = 4) {
  const found = sheetMarkers(detector.detect(img), 1);
  const hm = sheetHomography(found);
  if (!hm || !hm.ok) return { ok: false, found: found.map((m) => m.id), reason: found.length < 3 ? 'markers' : 'fit' };
  const flat = rectify(img, hm.H, scale);
  normalizeColors(flat);
  return { ok: true, found: found.map((m) => m.id), err: hm.err, image: flat };
}

export { MARKER_IDS };
