// AR 버전 마커 지도 만들기
// ARCore가 휴대폰 위치·방향을 하나의 고정된 '세계 좌표'로 계속 알려 주므로, 마커를 하나씩 따로 비춰도
// 각 마커의 세계 위치를 바로 계산할 수 있다 (마커 버전처럼 이웃 마커가 한 화면에 같이 보일 필요가 없음).
//  1) 마커 하나의 네 모서리 → 카메라 기준 마커 자세 (거울 해 중 '마커 면이 수평'에 가까운 쪽 = 중력 이용)
//  2) 카메라 기준 → 세계 기준 (ARCore가 준 그 순간의 휴대폰 자세)
//  3) 마커마다 여러 번 본 값의 중앙값 → 튀는 값에 강함
//  4) 처음 등록된 마커를 원점, 그 마커의 오른쪽을 x축으로 하는 수평 도로 좌표계를 만들어 지도(id, x, y, rot)로 저장
import { homography, poseFromHomography, refinePose, flipPose, markerCorners, mul3 } from './geometry.js';
import { CM, worldToRoad } from './xr-align.js';

export class XRMarkerMapper {
  // minSize: 화면에서 마커 크기(넓이의 제곱근)가 이 픽셀보다 작으면 부정확해서 버림 (8cm 마커 정면이면 약 2m 안)
  constructor({ size = 8, excludeIds = [], maxId = 49, minSamples = 6, keep = 60, maxTilt = 15, minSize = 20 } = {}) {
    this.size = size; this.exclude = new Set(excludeIds); this.maxId = maxId; this.minSize = minSize;
    this.minSamples = minSamples; this.keep = keep; this.maxTilt = maxTilt;
    this.samples = new Map(); // id → [{p:[x,y,z](m), yaw(rad), tilt(°), dist(cm)}]
    this.order = []; // 처음 본 순서
    this.local = markerCorners({ x: 0, y: 0, size, rot: 0 });
  }

  // markers: [{id, c:[[u,v]x4]}] (영상 px), K: 영상 카메라 행렬, wc: 세계 ← 카메라(cv) {R, t(m)}
  addFrame(markers, K, wc) {
    const added = [];
    for (const m of markers) {
      if (this.exclude.has(m.id) || m.id < 0 || m.id > this.maxId) continue;
      const side = Math.min(...m.c.map((p, i) => Math.hypot(p[0] - m.c[(i + 1) % 4][0], p[1] - m.c[(i + 1) % 4][1])));
      const c4 = m.c;
      const area = Math.abs((c4[2][0] - c4[0][0]) * (c4[3][1] - c4[1][1]) - (c4[3][0] - c4[1][0]) * (c4[2][1] - c4[0][1])) / 2;
      if (side < 12 || Math.sqrt(area) < this.minSize) continue; // 너무 작게 보이면 부정확
      const H = homography(this.local.map((p) => [p[0], p[1]]), m.c);
      if (!H) continue;
      const init = poseFromHomography(H, K);
      const cands = [init, flipPose(init, this.local)].filter(Boolean)
        .map((s) => refinePose(K, s, this.local, m.c, 8)).filter((c) => c.t[2] > 0 && c.rms < 3);
      if (!cands.length) continue;
      const minRms = Math.min(...cands.map((c) => c.rms));
      // 세계에서 본 마커 면의 기울기: 마커 법선(자세의 셋째 열)이 세계 위(y)와 이루는 각
      let best = null;
      for (const c of cands) {
        if (c.rms > minRms * 1.5 + 0.5) continue;
        const Rw = mul3(wc.R, c.R);
        const tilt = Math.acos(Math.max(-1, Math.min(1, Rw[5]))) * 180 / Math.PI;
        if (!best || tilt < best.tilt) best = { c, Rw, tilt };
      }
      if (!best || best.tilt > this.maxTilt) continue; // 바닥에 평평히 붙은 마커만
      const { c, Rw } = best;
      const tc = c.t.map((v) => v * CM);
      const p = [0, 1, 2].map((k) => wc.R[k * 3] * tc[0] + wc.R[k * 3 + 1] * tc[1] + wc.R[k * 3 + 2] * tc[2] + wc.t[k]);
      // 마커 오른쪽(x축)의 수평 방향 → yaw (xr-align의 levelRotation과 같은 규칙: x축 = (cosψ, 0, -sinψ))
      const yaw = Math.atan2(-Rw[6], Rw[0]);
      const list = this.samples.get(m.id) || [];
      if (!this.samples.has(m.id)) { this.samples.set(m.id, list); this.order.push(m.id); }
      list.push({ p, yaw, tilt: best.tilt, dist: Math.hypot(...c.t) });
      if (list.length > this.keep) list.shift();
      added.push(m.id);
    }
    return added;
  }

  confirmed(id) { return (this.samples.get(id) || []).length >= this.minSamples; }
  status() {
    const confirmed = this.order.filter((id) => this.confirmed(id));
    const pending = this.order.filter((id) => !this.confirmed(id)).map((id) => ({ id, n: this.samples.get(id).length }));
    return { confirmed, pending, refId: confirmed[0] ?? null };
  }

  // 반환: {markers:[{id,x,y,size,rot}], align:{p,yaw}(도로 → 세계), spreadCm, heightSpreadCm} 또는 null
  // align을 주면 그 도로 좌표계로 마커 위치를 냄 (한 바퀴 설치: 처음 마커를 본 순간 정한 좌표계를 끝까지 씀)
  solve({ align: fixed = null } = {}) {
    const ids = this.order.filter((id) => this.confirmed(id));
    if (ids.length < 1) return null;
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const est = ids.map((id) => {
      // 가까이서 본 절반만 사용 (멀수록 모서리 잡음이 위치 오차로 크게 번짐)
      const all = this.samples.get(id).slice().sort((a, b) => a.dist - b.dist);
      const L = all.slice(0, Math.max(3, Math.ceil(all.length / 2)));
      const y0 = L[0].yaw;
      const yaws = L.map((s) => y0 + Math.atan2(Math.sin(s.yaw - y0), Math.cos(s.yaw - y0)));
      const p = [0, 1, 2].map((k) => med(L.map((s) => s.p[k])));
      const spread = med(L.map((s) => Math.hypot(s.p[0] - p[0], s.p[2] - p[2]))) / CM;
      return { id, p, yaw: med(yaws), spread, estErr: (spread * 1.25) / Math.sqrt(L.length) };
    });
    const ref = est[0];
    const h = med(est.map((e) => e.p[1])); // 모든 마커가 같은 높이(도로 면)라고 보고 높이는 중앙값
    const align = fixed || { p: [ref.p[0], h, ref.p[2]], yaw: ref.yaw };
    const markers = est.map((e) => {
      const r = worldToRoad(align, e.p);
      let rot = ((e.yaw - align.yaw) * 180) / Math.PI;
      rot = ((rot + 540) % 360) - 180;
      return { id: e.id, x: +r[0].toFixed(2), y: +r[1].toFixed(2), size: this.size, rot: +rot.toFixed(2) };
    });
    const heightSpreadCm = (Math.max(...est.map((e) => e.p[1])) - Math.min(...est.map((e) => e.p[1]))) / CM;
    // estErrCm: 표본 잡음으로 본 위치 추정 오차(마커별 최대). ARCore 밀림은 여기 안 잡히니 화면에서 초록 사각형이 실제 마커에 겹치는지 확인
    return { markers, align, spreadCm: Math.max(...est.map((e) => e.spread)), estErrCm: Math.max(...est.map((e) => e.estErr)), heightSpreadCm };
  }
}
