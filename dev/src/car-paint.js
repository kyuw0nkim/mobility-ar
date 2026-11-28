// 펴서 찍은 도안(또는 빈 도안) → 3D 차에 입힐 그림 두 장 (① 겉모습, ② 앞·뒤와 실내)
//  - 지붕 띠(인쇄된 남색)와 앞·뒤 모습의 지붕 띠 → 고른 지붕 색 (② 쪽 색 칸에 ✓한 것, 없으면 차마다 기본색)
//  - 창문(칠하지 않는 곳) → 어두운 유리색, 기둥은 그대로
//  - '내 차 이름' 칸에 쓴 글씨 → 양옆의 '차 이름이 들어갈 자리'에
//  - '여기에 자유롭게 그려요' 같은 연한 안내 글씨는 주변 색으로 지움
import { CAR_TEMPLATES, PAPER } from './car-templates.js';

export const SCALE = 4; // px/mm (스캔·빈 도안 모두)
export const GLASS = '#1f3349';
// 재질 지도 (three.js: 초록 = 거칠기, 파랑 = 금속성). 차체는 반들한 도장, 유리는 매끈하게 비춤
const MAT_BODY = 'rgb(0,115,13)', MAT_GLASS = 'rgb(0,18,150)';
// 유리 칠: 위가 밝고 아래가 어두운 그라데이션 + 비스듬한 빛 줄기 (가벼운 모드처럼 반사가 없어도 유리처럼 보이게)
function paintGlass(ctx, path, rects) {
  if (!rects.length) return;
  const y0 = Math.min(...rects.map((r) => r[1])) * K, y1 = Math.max(...rects.map((r) => r[3])) * K;
  const x0 = Math.min(...rects.map((r) => r[0])) * K, x1 = Math.max(...rects.map((r) => r[2])) * K;
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, '#3d5f82'); g.addColorStop(0.45, '#22394f'); g.addColorStop(1, '#152434');
  ctx.save();
  ctx.clip(path, 'evenodd');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const h = y1 - y0;
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  for (let x = x0 + h * 0.6; x < x1; x += h * 3.2) {
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + h * 0.45, y0); ctx.lineTo(x - h * 0.35, y1); ctx.lineTo(x - h * 0.8, y1); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function matCanvas() {
  const cv = newCanvas(), c = cv.getContext('2d');
  c.fillStyle = MAT_BODY; c.fillRect(0, 0, cv.width, cv.height);
  return cv;
}
const K = SCALE;

export function blankUrl(vehicle, page) { return `assets/car-${vehicle}-${page}.png`; }
// 빈 도안 그림 (스캔하지 않은 쪽)
export async function loadBlank(vehicle, page) {
  const img = new Image();
  img.src = blankUrl(vehicle, page);
  await img.decode();
  const cv = newCanvas();
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}
export function newCanvas() {
  const cv = document.createElement('canvas');
  cv.width = Math.round(PAPER.w * K); cv.height = Math.round(PAPER.h * K);
  cv.getContext('2d', { willReadFrequently: true });
  return cv;
}
// 3D 지붕 윗면에 쓰는 지붕 색 조각: 종이 왼쪽 가장자리(그림이 없는 곳)에 칠해 둠
export const ROOF_PATCH = [1, 140, 4, 150];
function copyCanvas(src) {
  const cv = newCanvas();
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const px = (b, pad = 0) => [Math.max(0, Math.floor((b[0] - pad) * K)), Math.max(0, Math.floor((b[1] - pad) * K)), Math.ceil((b[2] + pad) * K), Math.ceil((b[3] + pad) * K)];
function median(data, skip) {
  const ch = [[], [], []];
  for (let i = 0; i < data.length; i += 4) { if (skip && skip(data[i], data[i + 1], data[i + 2])) continue; for (let k = 0; k < 3; k++) ch[k].push(data[i + k]); }
  if (!ch[0].length) return [255, 255, 255];
  return ch.map((a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const silPath = (pts) => { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x * K, y * K) : p.moveTo(x * K, y * K))); p.closePath(); return p; };

// 연한 회색 안내 글씨 지우기: 상자 안에서 무채색·밝은 점 → 상자 주변 색(중앙값)
function eraseHint(ctx, box) {
  const [x0, y0, x1, y1] = px(box, 0.8);
  const im = ctx.getImageData(x0, y0, x1 - x0, y1 - y0), d = im.data;
  const bg = median(d);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], l = lum(r, g, b);
    if (chroma(r, g, b) < 34 && l > 110 && l < 246 && Math.abs(l - lum(...bg)) > 12) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; }
  }
  ctx.putImageData(im, x0, y0);
}

// '내 차 이름' 칸에서 글씨만 뽑기 → 투명 배경 캔버스 (없으면 null)
export function extractName(src, t) {
  const nb = t.ext.nameBox;
  const box = [nb[0] + 2.2, nb[1] + 7, nb[2] - 2.2, nb[3] - 1.6]; // 위쪽 안내 줄과 점선 테두리 빼기
  const [x0, y0, x1, y1] = px(box);
  const w = x1 - x0, h = y1 - y0;
  const im = src.getContext('2d').getImageData(x0, y0, w, h), d = im.data;
  const ink = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], l = lum(r, g, b), c = chroma(r, g, b);
    if (l < 175 || (c > 95 && l < 236)) { ink[i] = 1; n++; }
  }
  if (n < 30) return null;
  // 글씨가 있는 범위 (줄·칸마다 2점 넘게)
  const rows = new Uint16Array(h), cols = new Uint16Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) { rows[y]++; cols[x]++; }
  const first = (a) => a.findIndex((v) => v > 2), last = (a) => a.length - 1 - [...a].reverse().findIndex((v) => v > 2);
  const bx0 = first(cols), bx1 = last(cols), by0 = first(rows), by1 = last(rows);
  if (bx0 < 0 || by0 < 0 || bx1 - bx0 < 6 || by1 - by0 < 6) return null;
  const pad = 4, cw = bx1 - bx0 + 1 + pad * 2, chh = by1 - by0 + 1 + pad * 2;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = chh;
  const oc = cv.getContext('2d'), oi = oc.createImageData(cw, chh);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    const sx = x + bx0 - pad, sy = y + by0 - pad;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const i = sy * w + sx, o = (y * cw + x) * 4;
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], l = lum(r, g, b), c = chroma(r, g, b);
    const a = Math.max(Math.min(1, (232 - l) / 70), c > 95 && l < 236 ? Math.min(1, (c - 70) / 60) : 0);
    if (a <= 0.05) continue;
    oi.data[o] = r; oi.data[o + 1] = g; oi.data[o + 2] = b; oi.data[o + 3] = Math.round(a * 255);
  }
  oc.putImageData(oi, 0, 0);
  return cv;
}

// 지붕 색 칸: ✓(또는 색칠)한 칸 = 안쪽이 가장 어두운 칸
export function pickRoof(src, t) {
  const ctx = src.getContext('2d');
  const scores = t.int.swatches.map((s) => {
    const [x0, y0, x1, y1] = px([s.box[0] + 0.9, s.box[1] + 0.9, s.box[2] - 0.9, s.box[3] - 0.9]);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 255 - lum(d[i], d[i + 1], d[i + 2]);
    return sum / (d.length / 4);
  });
  const order = scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  if (order[0][0] > 22 && order[0][0] > order[1][0] + 10) return { color: t.int.swatches[order[0][1]].color, index: order[0][1], scores };
  return { color: null, index: -1, scores };
}

// vehicle: 'pbv' | 'taxi' | 'truck'. pages: { ext: 펴진 캔버스|null, int: 캔버스|null } (없으면 빈 도안)
export async function paintCar(vehicle, pages = {}) {
  const t = CAR_TEMPLATES[vehicle];
  const extSrc = pages.ext || await loadBlank(vehicle, 'ext');
  const intSrc = pages.int || await loadBlank(vehicle, 'int');
  const pick = pages.int ? pickRoof(intSrc, t) : { color: null, index: -1 };
  const roof = pick.color || t.roof;
  const name = pages.ext ? extractName(extSrc, t) : null;

  // ① 겉모습: 양옆
  const ext = copyCanvas(extSrc), ec = ext.getContext('2d');
  const extMat = matCanvas(), em = extMat.getContext('2d');
  for (const s of t.ext.sides) {
    const sil = silPath(s.silhouette);
    for (const h of s.hint) eraseHint(ec, h);
    ec.save(); ec.clip(sil);
    ec.fillStyle = roof;
    for (const r of s.roof) ec.fillRect(r[0] * K, r[1] * K, (r[2] - r[0]) * K, (r[3] - r[1]) * K);
    const glass = new Path2D();
    for (const r of s.window) glass.rect(r[0] * K, r[1] * K, (r[2] - r[0]) * K, (r[3] - r[1]) * K);
    for (const r of s.pillar) glass.rect(r[0] * K, r[1] * K, (r[2] - r[0]) * K, (r[3] - r[1]) * K);
    paintGlass(ec, glass, s.window);
    ec.restore();
    em.save(); em.clip(sil); em.fillStyle = MAT_GLASS; em.fill(glass, 'evenodd'); em.restore();
    // 이름 자리: 테두리·안내 글씨를 지우고(주변 색) 이름을 넣음
    const [x0, y0, x1, y1] = px(s.nameSlot, 0.9);
    const bg = median(ec.getImageData(x0, y0, x1 - x0, y1 - y0).data, (r, g, b) => chroma(r, g, b) > 60 && r > g && g > b && lum(r, g, b) > 120);
    ec.fillStyle = rgb(bg);
    ec.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (name) {
      const sw = (s.nameSlot[2] - s.nameSlot[0] - 2) * K, sh = (s.nameSlot[3] - s.nameSlot[1] - 1) * K;
      const k = Math.min(sw / name.width, sh / name.height);
      const w = name.width * k, h = name.height * k;
      ec.drawImage(name, (x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2, w, h);
    }
  }
  ec.fillStyle = roof;
  ec.fillRect(ROOF_PATCH[0] * K, ROOF_PATCH[1] * K, (ROOF_PATCH[2] - ROOF_PATCH[0]) * K, (ROOF_PATCH[3] - ROOF_PATCH[1]) * K);
  // ② 앞·뒤: 지붕 띠·창문
  const int = copyCanvas(intSrc), ic = int.getContext('2d');
  const intMat = matCanvas(), im2 = intMat.getContext('2d');
  for (const h of t.int.hints || []) eraseHint(ic, h);
  for (const v of t.int.views) {
    ic.save();
    const b = v.bbox, r = 2.6 * K;
    const clip = new Path2D();
    clip.roundRect(b[0] * K, b[1] * K, (b[2] - b[0]) * K, (b[3] - b[1]) * K, r);
    ic.clip(clip);
    ic.fillStyle = roof;
    for (const q of v.roof) ic.fillRect(q[0] * K, q[1] * K, (q[2] - q[0]) * K, (q[3] - q[1]) * K);
    const glass = new Path2D();
    for (const q of v.window) glass.rect(q[0] * K, q[1] * K, (q[2] - q[0]) * K, (q[3] - q[1]) * K);
    paintGlass(ic, glass, v.window);
    ic.restore();
    im2.save(); im2.clip(clip); im2.fillStyle = MAT_GLASS; im2.fill(glass); im2.restore();
  }
  return { vehicle, ext, int, extMat, intMat, roof, roofPicked: !!pick.color, roofIndex: pick.index, name: !!name, nameCanvas: name };
}
