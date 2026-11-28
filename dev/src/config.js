// 기본 설정 = A4 가로 테스트 시트 (단위: cm, 원점: 시트 왼쪽 아래, x 오른쪽, y 위쪽)
// 실제 디오라마에서는 설정 화면에서 마커 위치와 크기를 실측값으로 바꾼다.
import { roundedRectPath } from './logic.js';

export const SHEET = { width: 29.7, height: 21.0 };

export const ROAD = { x0: 7.5, y0: 6.0, x1: 22.2, y1: 15.0, r: 3.5, laneWidth: 3.4 };

export const DEFAULT_CONFIG = {
  version: 1,
  // 도로(디오라마) 기준 마커: id, 중심 x·y, 검은 사각형 한 변 size, 마커 위쪽 방향 rot(도)
  roadMarkers: [
    { id: 0, x: 2.4, y: 2.4, size: 3.0, rot: 0 },
    { id: 1, x: 14.85, y: 2.4, size: 3.0, rot: 0 },
    { id: 2, x: 27.3, y: 2.4, size: 3.0, rot: 0 },
    { id: 3, x: 27.3, y: 18.6, size: 3.0, rot: 0 },
    { id: 4, x: 14.85, y: 18.6, size: 3.0, rot: 0 },
    { id: 5, x: 2.4, y: 18.6, size: 3.0, rot: 0 },
  ],
  roadHeight: 0, // 도로 면이 마커 면보다 몇 cm 높은지 (화면의 [높이 −/+]로 조절)
  pathCard: { id: 20, size: 5 }, // AR 경로 기록용 카드 마커 (차선 가운데에 놓고 1초 두면 점이 찍힘)
  barricade: {
    markerIds: [10, 11], // 앞면·뒷면
    markerSize: 3.0,
    // 전시용 레고 바리케이드: 전체 17×11cm. 마커 10(앞면)·11(뒷면)로만 인식
    // (A4 시트 종이 바리케이드로 시험할 때: width 10, height 5.5)
    width: 17.0, // 바닥에서 도로를 막는 폭
    height: 11.0, // 바리케이드 전체 높이 (화면 표시용)
  },
  car: { length: 3.6, width: 1.8, height: 1.3, color: '#e2453c', scale: 1.5 }, // scale: 화면의 [차 −/+]로 조절
  drive: {
    cruise: 3.0, // cm/s
    speedScale: 1, // 화면의 [속도 −/+]로 조절 (cruise·accel·decel·brakeDist에 곱함)
    brakeDist: 6.0, // 이 거리 안에서 감속 시작 (cm)
    stopGap: 1.2, // 바리케이드 앞 정지 여유 (cm)
    accel: 2.5,
    decel: 1.5,
    margin: 0.6, // 차 폭 절반에 더하는 여유 (cm)
  },
  tracking: {
    procWidth: 640, // 인식용 축소 영상 폭 (px)
    smoothing: 0.45, // 카메라 자세 보정 (0~1, 클수록 빠르게 따라감)
    lostMs: 700,
    focalAuto: true,
    focalFactor: 0.8, // 기본 초점거리 = 영상 긴 변 × 값
  },
  lane: {
    width: null, // 차선 폭(cm). null이면 영상에서 자동으로 잼
    search: null, // 탭한 경로 좌우로 차선을 찾는 범위(cm). null이면 마커 크기 × 1.2
    roadWidth: 24, // 흰 중앙선 찾기에 쓰는 도로 폭(cm): 양쪽 검은 차로 바깥 끝끼리(검-흰 중앙선-검). 흰 가장자리까지는 30. 대충이어도 됨
    centerLine: true, // 경로 기록 때 탭을 흰 중앙선에 붙이고 [중앙선 맞추기]를 씀 (A4 시트 지도에서는 자동으로 꺼짐)
  },
  barricadeTracking: { confirmFrames: 3, windowFrames: 6, clearMs: 2000, smoothing: 0.35 },
  // 가림 처리 (AR 버전, ARCore 깊이 인식): 실제 물체가 차보다 margin(m) + 거리×marginRel 넘게 앞에 있을 때만 가림
  // depthWithBuildings: 건물을 등록했어도 깊이 인식 가림을 같이 쓸지 (기본: 건물이 있으면 깊이 인식은 끔 — 지직거림·부하)
  occlusion: { enabled: true, margin: 0.03, marginRel: 0.03, depthWithBuildings: false },
  // 건물 등록 가림 (AR 버전): 건물·천막·나무 모양. AR 안 [건물 등록]으로 만듦 (buildings.js)
  buildings: [],
  path: roundedRectPath(ROAD.x0, ROAD.y0, ROAD.x1, ROAD.y1, ROAD.r, 8),
  pathStale: false, // 마커 지도를 새로 만든 뒤 경로를 아직 기록하지 않음
};

// 지도가 아직 A4 테스트 시트 기본값인지 (디오라마 지도를 처음 만들 때만 차 크기·속도를 마커 크기 비율로 키우기 위함)
export function isSheetMap(markers) {
  const d = DEFAULT_CONFIG.roadMarkers;
  return Array.isArray(markers) && markers.length === d.length &&
    markers.every((m, i) => m.id === d[i].id && m.size === d[i].size && Math.abs(m.x - d[i].x) < 1e-6 && Math.abs(m.y - d[i].y) < 1e-6);
}
