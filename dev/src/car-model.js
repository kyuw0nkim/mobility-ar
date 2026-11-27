// 나만의 차 3D: 도안의 옆모습 실루엣을 차 폭만큼 밀어 낸(압출) 몸체에 색칠한 도안을 입힌다.
//  - 옆면 = ① 겉모습의 오른쪽/왼쪽 그림, 앞·뒤 면 = ② 앞모습/뒷모습, 지붕·보닛 등 윗면 = 옆 그림 가장자리 색(지붕 띠는 고른 지붕 색)
//  - 창문 아래 높이(벨트 선)에서 위·아래를 나눠, 위(뚜껑)는 setOpen(t)로 서서히 사라지고 안쪽 바닥에 ② 실내 그림이 보인다
//  - 바퀴·로보택시 센서는 따로 붙인 3D
// 좌표: x 앞, y 왼쪽, z 위 (scene.js makeCar와 같음). 바퀴 아래가 z = 0, 차 길이 가운데가 x = 0
import * as THREE from 'three';
import { CAR_TEMPLATES, PAPER } from './car-templates.js';
import { ROOF_PATCH } from './car-paint.js';

const uvOf = (X, Y) => [X / PAPER.w, 1 - Y / PAPER.h];

export function canvasTexture(cv) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 도안 종이 ↔ 차 좌표 변환 (차 길이 length)
export function carFrame(vehicle, length) {
  const t = CAR_TEMPLATES[vehicle];
  const R = t.ext.sides[0], Lf = t.ext.sides[1];
  const s = length / (R.bbox[2] - R.bbox[0]);
  const cxR = (R.bbox[0] + R.bbox[2]) / 2, cxL = (Lf.bbox[0] + Lf.bbox[2]) / 2;
  const zTop = (R.ground - R.bbox[1]) * s, zBot = (R.ground - R.bbox[3]) * s;
  const F = t.int.views[0].bbox, B = t.int.views[1].bbox;
  const W = s * ((F[2] - F[0]) / (F[3] - F[1])) * (R.bbox[3] - R.bbox[1]);
  const winBottom = Math.max(...R.window.map((r) => r[3]));
  const zBelt = (R.ground - winBottom) * s;
  const xmin = (R.bbox[0] - cxR) * s, xmax = (R.bbox[2] - cxR) * s;
  const I = t.int.interior, xa = xmin + 0.03 * length, xb = xmax - 0.03 * length;
  return {
    t, R, Lf, s, L: length, W, H: zTop, zTop, zBot, zBelt, xmin, xmax,
    toCar: (X, Y) => [(X - cxR) * s, (R.ground - Y) * s],
    right: (x, z) => uvOf(cxR + x / s, R.ground - z / s),
    left: (x, z) => uvOf(cxL - x / s, Lf.ground - z / s),
    front: (y, z) => uvOf(F[0] + ((y + W / 2) / W) * (F[2] - F[0]), F[1] + ((zTop - z) / (zTop - zBot)) * (F[3] - F[1])),
    back: (y, z) => uvOf(B[0] + ((W / 2 - y) / W) * (B[2] - B[0]), B[1] + ((zTop - z) / (zTop - zBot)) * (B[3] - B[1])),
    interior: (x, y) => uvOf(I[0] + ((x - xa) / (xb - xa)) * (I[2] - I[0]), I[1] + ((W / 2 - y) / W) * (I[3] - I[1])),
    floorX: [xa, xb],
  };
}

// 실루엣을 밀어 낸 몸체 + 면마다 텍스처 좌표 (그룹 0 = ① 겉모습 그림, 1 = ② 앞·뒤 그림)
function bodyGeometry(fr) {
  const { W, s } = fr;
  const pts = fr.R.silhouette.map(([X, Y]) => new THREE.Vector2(...fr.toCar(X, Y)));
  const shape = new THREE.Shape(pts);
  const bs = 0.035 * fr.H, bt = 0.06 * W, depth = W - 2 * bt;
  let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelOffset: -bs, bevelSegments: 3, curveSegments: 2, steps: 1 });
  if (g.index) g = g.toNonIndexed();
  const P = g.attributes.position, n = P.count;
  // (모양 x, 모양 y, 압출 z) → 차 (x, −z + depth/2, y): 행렬식 +1이라 면 방향(바깥)이 그대로
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = P.getX(i); pos[i * 3 + 1] = depth / 2 - P.getZ(i); pos[i * 3 + 2] = P.getY(i); }
  const uv = new Float32Array(n * 2), faceN = new Float32Array(n * 3);
  const cls = new Uint8Array(n / 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
  const inset = 2.6 * s; // 윗면·가장자리는 옆 그림의 테두리 선보다 조금 안쪽 색을 씀
  const cxR = (fr.R.bbox[0] + fr.R.bbox[2]) / 2;
  const roofUV = uvOf((ROOF_PATCH[0] + ROOF_PATCH[2]) / 2, (ROOF_PATCH[1] + ROOF_PATCH[3]) / 2);
  for (let f = 0; f < n / 3; f++) {
    a.fromArray(pos, f * 9); b.fromArray(pos, f * 9 + 3); c.fromArray(pos, f * 9 + 6);
    nn.crossVectors(b.clone().sub(a), c.clone().sub(b)).normalize();
    const k = Math.abs(nn.y) >= 0.8 ? (nn.y < 0 ? 0 : 1) : nn.x >= 0.72 ? 2 : nn.x <= -0.72 ? 3 : 4;
    cls[f] = k;
    const cy = (a.y + b.y + c.y) / 3;
    let roofTop = false;
    if (k === 4 && nn.z > 0.45) { // 윗면: 옆 그림에서 그 자리(안쪽으로 조금)가 지붕 띠 안이면 지붕 색
      const hl0 = Math.hypot(nn.x, nn.z) || 1;
      const cx = (a.x + b.x + c.x) / 3 - (1.0 * s * nn.x) / hl0, cz = (a.z + b.z + c.z) / 3 - (1.0 * s * nn.z) / hl0;
      const X = cxR + cx / s, Y = fr.R.ground - cz / s;
      roofTop = fr.R.roof.some((r) => X >= r[0] && X <= r[2] && Y <= r[3] + 0.3);
    }
    const hl = Math.hypot(nn.x, nn.z) || 1;
    for (let v = 0; v < 3; v++) {
      const i = f * 3 + v, x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let u;
      if (k === 0) u = fr.right(x, z);
      else if (k === 1) u = fr.left(x, z);
      else if (k === 2) u = fr.front(y, z);
      else if (k === 3) u = fr.back(y, z);
      else {
        const xi = x - (inset * nn.x) / hl, zi = z - (inset * nn.z) / hl;
        u = cy < 0 ? fr.right(xi, zi) : fr.left(xi, zi);
        if (roofTop) u = roofUV; // 평평한 지붕 윗면: 지붕 색 (그 자리 옆 그림이 지붕 띠 안이면)
      }
      uv[i * 2] = u[0]; uv[i * 2 + 1] = u[1];
      faceN[i * 3] = nn.x; faceN[i * 3 + 1] = nn.y; faceN[i * 3 + 2] = nn.z;
    }
  }
  // 부드러운 법선: 같은 자리의 면 중 55° 안쪽으로 꺾인 면끼리만 평균 (각진 곳은 그대로)
  const key = (i) => `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
  const at = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); if (!at.has(k)) at.set(k, []); at.get(k).push(i); }
  const nor = new Float32Array(n * 3), cosT = Math.cos((55 * Math.PI) / 180);
  for (const list of at.values()) for (const i of list) {
    let x = 0, y = 0, z = 0;
    for (const j of list) {
      const d = faceN[i * 3] * faceN[j * 3] + faceN[i * 3 + 1] * faceN[j * 3 + 1] + faceN[i * 3 + 2] * faceN[j * 3 + 2];
      if (d >= cosT) { x += faceN[j * 3]; y += faceN[j * 3 + 1]; z += faceN[j * 3 + 2]; }
    }
    const l = Math.hypot(x, y, z) || 1;
    nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l;
  }
  // 재질 그룹으로 정렬: ① 그림(옆·윗면) 먼저, ② 그림(앞·뒤)
  const order = [...cls.keys()].sort((p, q) => (cls[p] === 2 || cls[p] === 3 ? 1 : 0) - (cls[q] === 2 || cls[q] === 3 ? 1 : 0));
  const pos2 = new Float32Array(n * 3), uv2 = new Float32Array(n * 2), nor2 = new Float32Array(n * 3);
  let nExt = 0;
  order.forEach((f, o) => {
    if (!(cls[f] === 2 || cls[f] === 3)) nExt++;
    for (let v = 0; v < 3; v++) {
      const i = f * 3 + v, j = o * 3 + v;
      pos2.set(pos.subarray(i * 3, i * 3 + 3), j * 3); nor2.set(nor.subarray(i * 3, i * 3 + 3), j * 3); uv2.set(uv.subarray(i * 2, i * 2 + 2), j * 2);
    }
  });
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor2, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv2, 2));
  out.addGroup(0, nExt * 3, 0);
  out.addGroup(nExt * 3, (n / 3 - nExt) * 3, 1);
  return out;
}

// 실루엣에서 높이 z일 때 가장 뒤(x 최소) 자리 (브레이크등 위치)
function backXAt(fr, z) {
  const P = fr.R.silhouette.map(([X, Y]) => fr.toCar(X, Y));
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length];
    if ((z0 - z) * (z1 - z) > 0 || z0 === z1) continue;
    best = Math.min(best, x0 + ((z - z0) / (z1 - z0)) * (x1 - x0));
  }
  return Number.isFinite(best) ? best : fr.xmin;
}

// painted: car-paint.js paintCar() 결과 {vehicle, ext, int}
export function makeDrawnCar(dims, painted, { lite = false } = {}) {
  const fr = carFrame(painted.vehicle, dims.length);
  const { W, H, zBelt, zBot } = fr;
  const Mat = lite ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
  const extra = lite ? {} : { roughness: 0.45, metalness: 0.05 };
  const texExt = canvasTexture(painted.ext), texInt = canvasTexture(painted.int);
  const g = new THREE.Group();

  // 벨트 선으로 위·아래 나누기 (세계 좌표 평면, 그리기 직전에 차 위치로 갱신)
  const lowerLocal = new THREE.Plane(new THREE.Vector3(0, 0, -1), zBelt), upperLocal = new THREE.Plane(new THREE.Vector3(0, 0, 1), -zBelt);
  const lowerPlane = new THREE.Plane(), upperPlane = new THREE.Plane();
  const updatePlanes = (m) => { lowerPlane.copy(lowerLocal).applyMatrix4(m); upperPlane.copy(upperLocal).applyMatrix4(m); };

  const geo = bodyGeometry(fr);
  const lowerMats = [new Mat({ map: texExt, clippingPlanes: [lowerPlane], ...extra }), new Mat({ map: texInt, clippingPlanes: [lowerPlane], ...extra })];
  const innerMat = new Mat({ color: 0xc9d0d8, side: THREE.BackSide, clippingPlanes: [lowerPlane], ...extra });
  const lidMats = [new Mat({ map: texExt, clippingPlanes: [upperPlane], transparent: false, ...extra }), new Mat({ map: texInt, clippingPlanes: [upperPlane], transparent: false, ...extra })];
  const lower = new THREE.Mesh(geo, lowerMats), inner = new THREE.Mesh(geo, innerMat), lid = new THREE.Mesh(geo, lidMats);
  for (const m of [lower, inner, lid]) m.onBeforeRender = () => updatePlanes(g.matrixWorld);
  lid.renderOrder = 2;
  const lidGroup = new THREE.Group();
  lidGroup.add(lid);
  g.add(lower, inner, lidGroup);

  // 실내 바닥 (② 실내 그림)
  const zFloor = zBelt - 0.4 * (zBelt - zBot);
  const [xa, xb] = fr.floorX, m = 0.05 * W;
  const fg = new THREE.BufferGeometry();
  const corners = [[xa, -W / 2 + m], [xb, -W / 2 + m], [xb, W / 2 - m], [xa, W / 2 - m]];
  fg.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, y]) => [x, y, zFloor]), 3));
  fg.setAttribute('uv', new THREE.Float32BufferAttribute(corners.flatMap(([x, y]) => fr.interior(x, y)), 2));
  fg.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  fg.setIndex([0, 1, 2, 0, 2, 3]);
  const floor = new THREE.Mesh(fg, new Mat({ map: texInt, ...extra }));
  g.add(floor);

  // 바퀴 (오른쪽 그림의 바퀴 자리)
  const tireMat = new Mat({ color: 0x2b2d31, ...extra }), hubMat = new Mat({ color: 0xc9ced4, ...extra });
  const tw = 0.2 * W;
  for (const tire of fr.R.tires) {
    const [x, z] = fr.toCar(tire.cx, tire.cy), r = tire.r * fr.s;
    const tg = new THREE.CylinderGeometry(r, r, tw, 24), hg = new THREE.CylinderGeometry(r * 0.5, r * 0.5, tw * 1.06, 16);
    for (const sy of [-1, 1]) {
      const w = new THREE.Mesh(tg, tireMat), h = new THREE.Mesh(hg, hubMat);
      w.position.set(x, sy * (W / 2 - tw * 0.3), z); h.position.copy(w.position);
      g.add(w, h);
    }
  }
  // 로보택시 지붕 센서 (뚜껑과 같이 사라짐)
  const sensorMat = new Mat({ color: 0x2a3444, transparent: false, ...extra });
  if (fr.R.sensor) {
    const [x0, z1] = fr.toCar(fr.R.sensor[0], fr.R.sensor[1]), [x1, z0] = fr.toCar(fr.R.sensor[2], fr.R.sensor[3]);
    const sensor = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.34 * W, z1 - z0 + 0.04 * H), sensorMat);
    sensor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2 - 0.02 * H);
    lidGroup.add(sensor);
  }
  // 브레이크등: 멈출 때만 빨갛게 (평소엔 그린 그림이 보이게 투명)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0, depthWrite: false });
  const zb = fr.zTop - 0.53 * (fr.zTop - zBot);
  const brake = new THREE.Mesh(new THREE.PlaneGeometry(0.045 * H, 0.84 * W), brakeMat);
  brake.position.set(backXAt(fr, zb) - 0.004 * fr.L, 0, zb);
  brake.rotation.y = -Math.PI / 2;
  g.add(brake);

  let open = -1;
  function setOpen(t) {
    t = Math.min(1, Math.max(0, t));
    if (Math.abs(t - open) < 0.005) return;
    open = t;
    lidGroup.visible = t < 0.98;
    for (const mt of [...lidMats, sensorMat]) {
      mt.opacity = 1 - t;
      const tr = t > 0.005;
      if (mt.transparent !== tr) { mt.transparent = tr; mt.depthWrite = !tr; mt.needsUpdate = true; }
    }
    floor.visible = inner.visible = t > 0.005;
  }
  setOpen(0);
  g.userData = {
    drawn: true, vehicle: painted.vehicle, setOpen, get open() { return open; },
    brakeMat, setBrake: (on) => { brakeMat.opacity = on ? 0.85 : 0; },
    shape: { L: fr.L, W, H, zBelt },
  };
  return g;
}
