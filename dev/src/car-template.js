// 나만의 차 도안 (A4 가로) — 도안 PDF(tools/make-car-sheet.mjs)와 3D 차(car-model.js)·스캔(car-scan.js)이 함께 쓰는 치수.
// 단위: 종이 mm, 원점 = 종이 왼쪽 위, x 오른쪽, y 아래쪽.
// 차는 도안에서 오른쪽을 보고 있어요(앞 = 오른쪽). 3D 차 좌표: x 앞, y 왼쪽, z 위 (scene.js의 makeCar와 같음).
//
// 다른 도안으로 바꾸려면 이 파일의 숫자만 고치면 돼요:
//  - MARKERS: 네 모서리 표식(ArUco, ARUCO_MIP_36h12)의 번호와 중심 위치, 검은 사각형 한 변
//  - REGIONS: 각 그림 칸(옆·앞·뒤·위·실내)의 종이 위 사각형
//  - PROFILE·INTERIOR: 차 모양(옆에서 본 단면, 실내 배치) — 0~1 비율

export const SHEET = { w: 297, h: 210 };

// 표식: 도로 마커(0~19)·바리케이드(10·11)·경로 카드(20)와 겹치지 않는 번호
export const MARKER_SIZE = 20; // 검은 사각형 한 변 (mm)
export const MARKERS = [
  { id: 60, x: 20, y: 20 }, // 왼쪽 위
  { id: 61, x: 277, y: 20 }, // 오른쪽 위
  { id: 62, x: 277, y: 190 }, // 오른쪽 아래
  { id: 63, x: 20, y: 190 }, // 왼쪽 아래
];
export const MARKER_IDS = MARKERS.map((m) => m.id);
// 표식 네 귀퉁이의 종이 위치 (검출기가 주는 순서: 표식 기준 왼쪽 위부터 시계 방향)
export function markerPaperCorners(m) {
  const h = MARKER_SIZE / 2;
  return [[m.x - h, m.y - h], [m.x + h, m.y - h], [m.x + h, m.y + h], [m.x - h, m.y + h]];
}

// 차 비율: 길이 1 기준 폭·높이
export const RATIO = { width: 0.5, height: 0.4 };

// 옆모습 단면 (a: 뒤 0 → 앞 1, b: 바닥 0 → 지붕 1, 차 높이 기준)
export const PROFILE = {
  sill: 0.12, // 차체 아래 끝 (바퀴 사이 바닥)
  belt: 0.5, // 차체 위 끝 = 보닛·트렁크 높이 = 실내가 열리는 높이
  roof: 0.95, // 지붕 높이
  cabin: [0.25, 0.33, 0.66, 0.78], // 지붕(뚜껑) 앞뒤: 뒷유리 아래, 뒷유리 위, 앞유리 위, 앞유리 아래
  wheels: [0.2, 0.8], // 바퀴 가운데 (길이 비율)
  wheelR: 0.17, // 바퀴 반지름 (높이 비율)
  cabinInset: 0.08, // 지붕 옆면이 차체 옆면보다 안쪽으로 들어간 정도 (폭 비율, 한쪽)
  wall: 0.08, // 차체 벽 두께 (폭 비율) = 지붕 옆면 들어간 정도와 같게 (틈이 안 보이게)
  floor: 0.16, // 실내 바닥 높이 (높이 비율)
};

// 실내 배치 (위에서 본 모습: a 뒤 0 → 앞 1, c: 오른쪽 0 → 왼쪽 1). 운전석은 왼쪽(c 큰 쪽)
export const INTERIOR = {
  seats: [
    { a0: 0.52, a1: 0.64, c0: 0.56, c1: 0.88, back: 0.04 }, // 운전석
    { a0: 0.52, a1: 0.64, c0: 0.12, c1: 0.44, back: 0.04 }, // 조수석
    { a0: 0.29, a1: 0.42, c0: 0.12, c1: 0.88, back: 0.04 }, // 뒷좌석
  ],
  seatTop: 0.3, // 방석 높이 (차 높이 비율)
  backTop: 0.56, // 등받이 높이
  dash: { a0: 0.71, a1: 0.77, c0: 0.08, c1: 0.92, top: 0.47 },
  wheel: { a: 0.685, c: 0.72, r: 0.09 }, // 운전대 (r: 폭 비율)
};

// 그림 칸 (종이 mm). 옆·위·실내는 길이 120mm 기준: 폭 60, 높이 48
const L = 120;
const W = L * RATIO.width, H = L * RATIO.height;
const bodyBand = (PROFILE.belt - PROFILE.sill) * H; // 앞·뒤 칸 높이 = 차체 띠
export const REGIONS = {
  side: { x: 22, y: 44, w: L, h: H, label: '옆모습' },
  front: { x: 158, y: 44 + (1 - PROFILE.belt) * H, w: W, h: bodyBand, label: '앞모습' },
  back: { x: 224, y: 44 + (1 - PROFILE.belt) * H, w: W, h: bodyBand, label: '뒷모습' },
  top: { x: 22, y: 112, w: L, h: W, label: '위에서 본 모습 (지붕)' },
  interior: { x: 158, y: 112, w: L, h: W, label: '안쪽 (실내) · 가까이 가면 보여요' },
};

// 칸 안의 비율 좌표 (a: 왼쪽 0 → 오른쪽 1, b: 아래 0 → 위 1) → 종이 mm
export function paperPoint(region, a, b) {
  const r = REGIONS[region];
  return [r.x + a * r.w, r.y + (1 - b) * r.h];
}
// → 텍스처 좌표 (텍스처 = 펴서 찍은 종이 전체, three.js 기본 flipY: v는 아래 0)
export function paperUV(region, a, b) {
  const [x, y] = paperPoint(region, a, b);
  return [x / SHEET.w, 1 - y / SHEET.h];
}

// 옆모습 외곽선 (a, b) — 차체 아래 띠 + 지붕. 도안 그리기와 3D 옆면이 같은 모양을 쓴다
export function sideOutline() {
  const p = PROFILE, [r0, r1, f1, f0] = p.cabin;
  return [[0, p.sill], [1, p.sill], [1, p.belt], [f0, p.belt], [f1, p.roof], [r1, p.roof], [r0, p.belt], [0, p.belt]];
}
