// 나만의 차: 펴서 찍은 도안(텍스처 한 장)을 입힌 3D 차. 치수와 그림 칸은 car-template.js를 따른다.
//  - 차체(옆·앞·뒤·보닛·트렁크) + 지붕(뚜껑: 옆창·지붕·앞유리·뒷유리) + 실내(바닥·좌석·계기판·운전대)
//  - setOpen(t): 0 = 지붕 닫힘, 1 = 지붕이 사라지고 실내가 보임 (AR에서 태블릿이 차에 가까이 가면 1 쪽으로)
// 좌표: x 앞, y 왼쪽, z 위 (scene.js makeCar와 같음). 차 가운데 아래가 원점
import * as THREE from 'three';
import { SHEET, REGIONS, PROFILE, INTERIOR, RATIO, paperUV, paperPoint } from './car-template.js';

// 면 모으기: 사각형·상자를 한 BufferGeometry로
class Builder {
  constructor() { this.pos = []; this.uv = []; this.idx = []; }
  // 네 점(시계 반대 방향, 바깥에서 볼 때)과 텍스처 좌표
  quad(p, t) {
    const n = this.pos.length / 3;
    for (let i = 0; i < 4; i++) { this.pos.push(...p[i]); this.uv.push(...t[i]); }
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export function carShape(length) {
  const L = length, W = L * RATIO.width, H = L * RATIO.height;
  return { L, W, H, X: (a) => (a - 0.5) * L, Y: (c) => (c - 0.5) * W, Z: (b) => b * H };
}

// texture: 펴서 찍은 도안(THREE.Texture). lite: 가벼운 재질(Lambert)
export function makeDrawnCar(dims, texture, { lite = false } = {}) {
  const { L, W, H, X, Y, Z } = carShape(dims.length);
  const P = PROFILE, I = INTERIOR;
  const [r0, r1, f1, f0] = P.cabin;
  const ci = P.cabinInset, wl = P.wall;
  const Mat = lite ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
  const extra = lite ? {} : { roughness: 0.55, metalness: 0.05 };
  const g = new THREE.Group();
  const uvS = (a, b) => paperUV('side', a, b);
  const uvT = (a, c) => paperUV('top', a, c);
  const uvI = (a, c) => paperUV('interior', a, c);

  // ── 차체 ──
  const body = new Builder();
  for (const side of [0, 1]) { // c = 0: 오른쪽(y−), 1: 왼쪽(y+)
    const y = Y(side), pts = [[0, P.sill], [1, P.sill], [1, P.belt], [0, P.belt]];
    const ps = pts.map(([a, b]) => [X(a), y, Z(b)]), ts = pts.map(([a, b]) => uvS(a, b));
    if (side) { ps.reverse(); ts.reverse(); }
    body.quad(ps, ts);
  }
  // 앞(a = 1): 앞에서 보면 오른쪽이 차의 왼쪽(c 큼) → 그림 가로 = c
  body.quad([[X(1), Y(0), Z(P.sill)], [X(1), Y(1), Z(P.sill)], [X(1), Y(1), Z(P.belt)], [X(1), Y(0), Z(P.belt)]],
    [paperUV('front', 0, 0), paperUV('front', 1, 0), paperUV('front', 1, 1), paperUV('front', 0, 1)]);
  // 뒤(a = 0): 뒤에서 보면 오른쪽이 차의 오른쪽(c 작음) → 그림 가로 = 1 − c
  body.quad([[X(0), Y(1), Z(P.sill)], [X(0), Y(0), Z(P.sill)], [X(0), Y(0), Z(P.belt)], [X(0), Y(1), Z(P.belt)]],
    [paperUV('back', 0, 0), paperUV('back', 1, 0), paperUV('back', 1, 1), paperUV('back', 0, 1)]);
  // 윗면: 트렁크, 보닛, 양옆 문턱 (실내가 열리는 곳 a r0~f0, c wl~1−wl는 비움)
  const top = (a0, a1, c0, c1, z = Z(P.belt)) => body.quad(
    [[X(a0), Y(c0), z], [X(a1), Y(c0), z], [X(a1), Y(c1), z], [X(a0), Y(c1), z]],
    [uvT(a0, c0), uvT(a1, c0), uvT(a1, c1), uvT(a0, c1)]);
  top(0, r0, 0, 1); top(f0, 1, 0, 1); top(r0, f0, 0, wl); top(r0, f0, 1 - wl, 1);

  // ── 실내 (도안의 실내 칸을 위에서 비춤) ──
  const inside = new Builder();
  const flat = (a0, a1, c0, c1, b) => inside.quad(
    [[X(a0), Y(c0), Z(b)], [X(a1), Y(c0), Z(b)], [X(a1), Y(c1), Z(b)], [X(a0), Y(c1), Z(b)]],
    [uvI(a0, c0), uvI(a1, c0), uvI(a1, c1), uvI(a0, c1)]);
  // 상자: 모든 면을 위에서 본 실내 그림으로 (옆면은 가장자리 색이 아래로 이어짐)
  const box = (a0, a1, c0, c1, b0, b1) => {
    flat(a0, a1, c0, c1, b1);
    const q = (p) => inside.quad(p.map(([a, c, b]) => [X(a), Y(c), Z(b)]), p.map(([a, c]) => uvI(a, c)));
    q([[a1, c0, b0], [a1, c1, b0], [a1, c1, b1], [a1, c0, b1]]);
    q([[a0, c1, b0], [a0, c0, b0], [a0, c0, b1], [a0, c1, b1]]);
    q([[a0, c0, b0], [a1, c0, b0], [a1, c0, b1], [a0, c0, b1]]);
    q([[a1, c1, b0], [a0, c1, b0], [a0, c1, b1], [a1, c1, b1]]);
  };
  flat(r0, f0, wl, 1 - wl, P.floor);
  for (const s of I.seats) {
    box(s.a0, s.a1, s.c0, s.c1, P.floor, I.seatTop);
    box(s.a0, s.a0 + s.back, s.c0, s.c1, P.floor, I.backTop);
  }
  const d = I.dash;
  box(d.a0, d.a1, d.c0, d.c1, P.floor, d.top);

  // 실내 벽 (안쪽에서 보이는 면, 단색)
  const wall = new Builder();
  const wq = (p) => wall.quad(p.map(([a, c, b]) => [X(a), Y(c), Z(b)]), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const fb = P.floor, bt = P.belt;
  wq([[r0, 1 - wl, fb], [r0, wl, fb], [r0, wl, bt], [r0, 1 - wl, bt]]);
  wq([[f0, wl, fb], [f0, 1 - wl, fb], [f0, 1 - wl, bt], [f0, wl, bt]]);
  wq([[f0, wl, fb], [r0, wl, fb], [r0, wl, bt], [f0, wl, bt]]);
  wq([[r0, 1 - wl, fb], [f0, 1 - wl, fb], [f0, 1 - wl, bt], [r0, 1 - wl, bt]]);
  // 바닥 밑면
  wq([[0, 1, P.sill], [1, 1, P.sill], [1, 0, P.sill], [0, 0, P.sill]]);

  // ── 지붕 (뚜껑) ──
  const cab = new Builder();
  for (const side of [0, 1]) {
    const c = side ? 1 - ci : ci;
    const pts = [[r0, P.belt], [f0, P.belt], [f1, P.roof], [r1, P.roof]];
    const ps = pts.map(([a, b]) => [X(a), Y(c), Z(b)]), ts = pts.map(([a, b]) => uvS(a, b));
    if (side) { ps.reverse(); ts.reverse(); }
    cab.quad(ps, ts);
  }
  const slope = (aLo, aHi, bLo, bHi) => cab.quad(
    [[X(aLo), Y(ci), Z(bLo)], [X(aLo), Y(1 - ci), Z(bLo)], [X(aHi), Y(1 - ci), Z(bHi)], [X(aHi), Y(ci), Z(bHi)]],
    [uvT(aLo, ci), uvT(aLo, 1 - ci), uvT(aHi, 1 - ci), uvT(aHi, ci)]);
  slope(f0, f1, P.belt, P.roof); // 앞유리
  slope(r1, r0, P.roof, P.belt); // 뒷유리
  cab.quad([[X(r1), Y(ci), Z(P.roof)], [X(f1), Y(ci), Z(P.roof)], [X(f1), Y(1 - ci), Z(P.roof)], [X(r1), Y(1 - ci), Z(P.roof)]],
    [uvT(r1, ci), uvT(f1, ci), uvT(f1, 1 - ci), uvT(r1, 1 - ci)]);

  const map = texture || null;
  const bodyMat = new Mat({ map, side: THREE.DoubleSide, ...extra });
  const insideMat = new Mat({ map, side: THREE.DoubleSide, ...extra });
  const wallMat = new Mat({ color: 0x8a96a3, side: THREE.DoubleSide, ...extra });
  const cabinMat = new Mat({ map, side: THREE.DoubleSide, transparent: true, opacity: 1, ...extra });
  g.add(new THREE.Mesh(body.geometry(), bodyMat));
  const interior = new THREE.Group();
  interior.add(new THREE.Mesh(inside.geometry(), insideMat), new THREE.Mesh(wall.geometry(), wallMat));
  // 운전대
  const wheelR = I.wheel.r * W;
  const steer = new THREE.Mesh(new THREE.TorusGeometry(wheelR, wheelR * 0.18, 6, 18), new Mat({ color: 0x222831, ...extra }));
  steer.position.set(X(I.wheel.a), Y(I.wheel.c), Z(0.42));
  steer.rotation.set(0, Math.PI / 2 - 0.5, 0);
  interior.add(steer);
  g.add(interior);
  const cabin = new THREE.Mesh(cab.geometry(), cabinMat);
  cabin.renderOrder = 2;
  g.add(cabin);

  // 바퀴
  const wr = P.wheelR * H;
  const wheelGeo = new THREE.CylinderGeometry(wr, wr, W * 0.16, 18);
  const wheelMat = new Mat({ color: 0x1d1f22, ...extra });
  const hubGeo = new THREE.CylinderGeometry(wr * 0.45, wr * 0.45, W * 0.17, 12);
  const hubMat = new Mat({ color: 0xc9d1d9, ...extra });
  for (const a of P.wheels) for (const sy of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(X(a), sy * (W / 2 - W * 0.04), wr);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.copy(w.position);
    g.add(w, hub);
  }
  // 브레이크등: 멈출 때만 빨갛게 (평소엔 그린 그림이 보이게 투명)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0 });
  for (const [u0, u1] of [[0.05, 0.25], [0.75, 0.95]]) {
    const c0 = 1 - u1, c1 = 1 - u0, b0 = P.sill + 0.5 * (P.belt - P.sill), b1 = P.sill + 0.8 * (P.belt - P.sill);
    const m = new THREE.Mesh(new THREE.PlaneGeometry((b1 - b0) * H, (c1 - c0) * W), brakeMat); // 판의 가로 → 높이(z), 세로 → 폭(y)
    m.position.set(X(0) - 0.02, (Y(c0) + Y(c1)) / 2, (Z(b0) + Z(b1)) / 2);
    m.rotation.y = -Math.PI / 2; // 뒤(−x)를 봄
    g.add(m);
  }

  let open = -1;
  function setOpen(t) {
    t = Math.min(1, Math.max(0, t));
    if (Math.abs(t - open) < 0.005) return;
    open = t;
    cabin.visible = t < 0.98;
    cabinMat.opacity = 1 - t;
    cabinMat.transparent = t > 0.005;
    cabinMat.depthWrite = t <= 0.005;
    cabinMat.needsUpdate = true;
    interior.visible = t > 0.005;
  }
  setOpen(0);
  g.userData = {
    drawn: true, setOpen, get open() { return open; },
    brakeMat, setBrake: (on) => { brakeMat.opacity = on ? 0.85 : 0; },
    shape: { L, W, H },
  };
  return g;
}

// ── 기본 그림 (스캔 없이 달릴 때): 도안 칸을 색으로 채운 텍스처 ──
export function defaultCarCanvas(color = '#e2453c', scale = 4) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(SHEET.w * scale); cv.height = Math.round(SHEET.h * scale);
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SHEET.w, SHEET.h);
  const P = PROFILE, I = INTERIOR, [r0, r1, f1, f0] = P.cabin;
  const rect = (reg, a0, b0, a1, b1, fill) => {
    const [x0, y1] = paperPoint(reg, a0, b0), [x1, y0] = paperPoint(reg, a1, b1);
    ctx.fillStyle = fill; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  const polyFill = (reg, pts, fill) => {
    ctx.beginPath();
    pts.forEach(([a, b], i) => { const [x, y] = paperPoint(reg, a, b); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  const glass = '#9fc6e6', dark = '#30343a';
  // 옆: 차체, 지붕, 창
  rect('side', 0, P.sill, 1, P.belt, color);
  polyFill('side', [[r0, P.belt], [f0, P.belt], [f1, P.roof], [r1, P.roof]], color);
  const wb = P.belt + 0.05, wt = P.roof - 0.07, k0 = (wb - P.belt) / (P.roof - P.belt), k1 = (wt - P.belt) / (P.roof - P.belt);
  const lerp = (u, v, t) => u + (v - u) * t, pil = (r1 + f1) / 2;
  polyFill('side', [[lerp(r0, r1, k0) + 0.03, wb], [pil - 0.012, wb], [pil - 0.012, wt], [lerp(r0, r1, k1) + 0.03, wt]], glass);
  polyFill('side', [[pil + 0.012, wb], [lerp(f0, f1, k0) - 0.03, wb], [lerp(f0, f1, k1) - 0.03, wt], [pil + 0.012, wt]], glass);
  rect('side', 0.955, 0.38, 0.995, 0.46, '#fff6c0'); rect('side', 0.005, 0.38, 0.04, 0.46, '#a01818');
  // 앞·뒤
  rect('front', 0, 0, 1, 1, color);
  rect('front', 0.06, 0.45, 0.24, 0.8, '#fff6c0'); rect('front', 0.76, 0.45, 0.94, 0.8, '#fff6c0'); rect('front', 0.32, 0.3, 0.68, 0.7, dark);
  rect('back', 0, 0, 1, 1, color);
  rect('back', 0.05, 0.5, 0.25, 0.8, '#a01818'); rect('back', 0.75, 0.5, 0.95, 0.8, '#a01818'); rect('back', 0.36, 0.2, 0.64, 0.5, '#f4f4f4');
  // 위: 차체, 앞유리·뒷유리, 지붕
  rect('top', 0, 0, 1, 1, color);
  rect('top', f1, P.cabinInset, f0, 1 - P.cabinInset, glass); rect('top', r0, P.cabinInset, r1, 1 - P.cabinInset, glass);
  // 실내: 바닥, 좌석, 계기판
  rect('interior', 0, 0, 1, 1, '#5b6470');
  for (const s of I.seats) { rect('interior', s.a0, s.c0, s.a1, s.c1, '#d9b48a'); rect('interior', s.a0, s.c0, s.a0 + s.back, s.c1, '#b48a5e'); }
  rect('interior', I.dash.a0, I.dash.c0, I.dash.a1, I.dash.c1, dark);
  // 외곽선 (도안처럼)
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 0.5;
  for (const k of Object.keys(REGIONS)) { const r = REGIONS[k]; ctx.strokeRect(r.x, r.y, r.w, r.h); }
  return cv;
}

export function canvasTexture(cv) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
