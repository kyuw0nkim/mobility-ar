// 두 버전(마커·AR)이 함께 쓰는 3D 모델
import * as THREE from 'three';

export function makeCar(c) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.5, metalness: 0.1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(c.length, c.width, c.height * 0.5), bodyMat);
  body.position.z = c.height * 0.35;
  g.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(c.length * 0.5, c.width * 0.85, c.height * 0.4),
    new THREE.MeshStandardMaterial({ color: 0xdde8f0, roughness: 0.2, metalness: 0.3 }),
  );
  cabin.position.set(-c.length * 0.05, 0, c.height * 0.8);
  g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(c.height * 0.22, c.height * 0.22, c.width * 0.18, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(sx * c.length * 0.32, sy * c.width * 0.5, c.height * 0.22);
    g.add(w);
  }
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6c0 });
  for (const sy of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, c.width * 0.2, c.height * 0.12), lightMat);
    l.position.set(c.length / 2 + 0.02, sy * c.width * 0.3, c.height * 0.4);
    g.add(l);
  }
  // 브레이크등
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x551111 });
  for (const sy of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, c.width * 0.22, c.height * 0.12), brakeMat);
    l.position.set(-c.length / 2 - 0.02, sy * c.width * 0.3, c.height * 0.4);
    g.add(l);
  }
  g.userData.brakeMat = brakeMat;
  return g;
}

export function makeBarricadeVis() {
  const group = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.25, depthWrite: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffc400 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), fillMat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMat);
  group.add(box, edges);
  group.visible = false;
  return { group, box, edges, fillMat, lineMat };
}

// 장면에서 뺀 물체의 GPU 자원(모양·재질) 돌려주기. 같은 모양·재질을 여러 물체가 써도 한 번만 정리
export function disposeObject(obj) {
  if (!obj) return;
  const seen = new Set();
  obj.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const r of [o.geometry, ...mats, ...mats.map((m) => m && m.map)]) {
      if (r && r.dispose && !seen.has(r)) { seen.add(r); r.dispose(); }
    }
  });
  if (obj.parent) obj.parent.remove(obj);
}
// 묶음 안의 물체를 모두 빼고 GPU 자원도 정리
export function clearGroup(group) {
  while (group.children.length) disposeObject(group.children[0]);
}

// 고리 선: 점마다 색(약한 곳 주황)
export function coloredLoop(pts, weak, okColor, z) {
  const n = pts.length, col = [], pos = [];
  const a = new THREE.Color(okColor), w = new THREE.Color(0xff9f0a);
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n], c = weak && weak[i % n] ? w : a;
    pos.push(p[0], p[1], z); col.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
}
