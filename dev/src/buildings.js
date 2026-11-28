// 건물 등록 가림: 디오라마의 건물·천막·나무를 단순한 모양으로 등록해 두고, 그 뒤에 있는 차·경로를 그리지 않는다.
// (깊이 인식은 거칠고 잡음이 있어 지직거림 → 고정된 건물은 등록한 모양으로 가리는 게 깔끔하고 가볍다)
// 좌표: 디오라마(도로) 좌표 cm, z는 마커 면 기준. 등록 정보 b:
//   { kind: 'building'|'canopy'|'tree', pts: [[x,y],...] (바닥 둘레, 나무는 [가운데]), base: 바닥 높이,
//     h: 꼭대기 높이(바닥에서), under: 천막 아래 빈 높이, peak: 지붕 뾰족 높이(0이면 평평), r: 나무 반지름 }
import * as THREE from 'three';

export const KIND_NAME = { building: '건물', canopy: '천막', tree: '나무' };

// 탭 3개로 네모 만들기: 첫 두 점 = 한 변, 셋째 점 = 반대쪽 변까지 (사각형 건물이 대부분이라)
export function rectFrom3(p0, p1, p2) {
  const ex = p1[0] - p0[0], ey = p1[1] - p0[1], L = Math.hypot(ex, ey) || 1;
  const nx = -ey / L, ny = ex / L;
  const w = (p2[0] - p0[0]) * nx + (p2[1] - p0[1]) * ny;
  return [p0, p1, [p1[0] + nx * w, p1[1] + ny * w], [p0[0] + nx * w, p0[1] + ny * w]];
}
// 바닥 둘레: 건물·천막은 점 3개면 네모, 4개 이상이면 찍은 대로
export function footprint(b) {
  if (b.kind === 'tree') return null;
  return b.pts.length === 3 ? rectFrom3(...b.pts) : b.pts;
}
export function centroid(pts) {
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}
export function valid(b) {
  if (!b || !(b.h > 0)) return false;
  if (b.kind === 'tree') return b.pts.length >= 1 && b.r > 0;
  if (b.kind === 'canopy' && !(b.under >= 0 && b.under < b.h)) return false;
  return b.pts.length >= 3;
}

// 모양 하나 → three.js 모양(BufferGeometry, 디오라마 좌표)
function shapeGeometry(b) {
  if (b.kind === 'tree') {
    // 나무: 줄기 + 동그란 잎 덩어리를 원기둥 하나로 (가림용이라 대충)
    const [cx, cy] = b.pts[0];
    const g = new THREE.CylinderGeometry(b.r * 0.85, b.r, b.h, 14);
    g.rotateX(Math.PI / 2);
    g.translate(cx, cy, b.base + b.h / 2);
    return g;
  }
  let pts = footprint(b);
  // 시계 방향이면 뒤집기 (압출 면 방향)
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length]; area += a[0] * c[1] - c[0] * a[1]; }
  if (area < 0) pts = pts.slice().reverse();
  const z0 = b.base + (b.kind === 'canopy' ? b.under : 0), z1 = b.base + b.h;
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const parts = [];
  const box = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.1, z1 - z0), bevelEnabled: false });
  box.translate(0, 0, z0);
  parts.push(box.index ? box.toNonIndexed() : box);
  if (b.peak > 0) { // 뾰족 지붕(천막 꼭대기): 둘레 → 가운데 꼭짓점
    const [cx, cy] = centroid(pts), pos = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      pos.push(a[0], a[1], z1, c[0], c[1], z1, cx, cy, z1 + b.peak);
    }
    const roof = new THREE.BufferGeometry();
    roof.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    roof.computeVertexNormals();
    parts.push(roof);
  }
  return parts.length === 1 ? parts[0] : mergeGeos(parts);
}
function mergeGeos(geos) {
  const pos = [];
  for (const g of geos) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i)); g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

// 깊이만 쓰는 재질: 화면에는 안 보이고, 뒤에 있는 차·경로를 가린다 (차보다 먼저 그림)
const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
export function makeOccluder(geo) {
  const m = new THREE.Mesh(geo, occluderMat);
  m.renderOrder = -10;
  return m;
}

// 등록한 모양들을 그리는 묶음. show: 관리자에게 반투명 하늘색으로 보여 줌
export class BuildingLayer {
  constructor() {
    this.group = new THREE.Group();
    this.occ = new THREE.Group();
    this.vis = new THREE.Group();
    this.group.add(this.occ, this.vis);
    this.visMat = new THREE.MeshBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.draftMat = new THREE.MeshBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x38d9ff });
    this.draftLine = new THREE.LineBasicMaterial({ color: 0xff00aa });
    this.dotMat = new THREE.MeshBasicMaterial({ color: 0xff00aa });
    this.vis.visible = false;
    this.draft = new THREE.Group();
    this.group.add(this.draft);
  }
  clear(g) { while (g.children.length) { const c = g.children[0]; if (c.geometry) c.geometry.dispose(); g.remove(c); } }
  set(list) {
    this.clear(this.occ); this.clear(this.vis);
    for (const b of list || []) {
      if (!valid(b)) continue;
      const geo = shapeGeometry(b);
      this.occ.add(makeOccluder(geo));
      this.vis.add(new THREE.Mesh(geo.clone(), this.visMat), new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), this.lineMat));
    }
  }
  // 등록 중인 모양 (분홍): 찍은 점 + 지금 값으로 만든 모양
  setDraft(b, markerZ) {
    this.clear(this.draft);
    if (!b) return;
    const s = 0.5;
    for (const p of b.pts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 8), this.dotMat);
      dot.position.set(p[0], p[1], (markerZ ?? b.base) + s);
      this.draft.add(dot);
    }
    if (valid(b)) {
      const geo = shapeGeometry(b);
      this.draft.add(new THREE.Mesh(geo, this.draftMat), new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), this.draftLine));
    } else if (b.pts.length > 1) {
      const pts = [...b.pts, b.pts[0]].map(([x, y]) => new THREE.Vector3(x, y, b.base + 0.1));
      this.draft.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.draftLine));
    }
  }
  get count() { return this.occ.children.length; }
}

// 조준한 시선과 바닥 가운데 위로 선 세로줄이 가장 가까운 높이 (꼭대기·처마 높이 재기). O, D: 도로 좌표 시선(cm)
export function heightOnVertical(O, D, cx, cy) {
  const hh = D[0] * D[0] + D[1] * D[1];
  if (hh < 1e-6) return null;
  const t = ((cx - O[0]) * D[0] + (cy - O[1]) * D[1]) / hh;
  if (t <= 0) return null;
  return O[2] + D[2] * t;
}
