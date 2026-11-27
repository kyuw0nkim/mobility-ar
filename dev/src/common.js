// 두 버전(마커·AR)이 함께 쓰는 설정 계산과 화면 도우미
import { isSheetMap } from './config.js';

// 흰 중앙선 기능(탭마다 중앙선에 붙이기, 중앙선 맞추기)을 쓸지: 디오라마 지도일 때만.
// A4 테스트 시트는 가운데가 가는 점선이라 이 방식이 맞지 않음 (엉뚱한 줄에 붙음). 설정 lane.centerLine: false로 끌 수 있음
export const centerLineOn = (cfg) => cfg.lane.centerLine !== false && !isSheetMap(cfg.roadMarkers);
export const roadHeight = (cfg) => cfg.roadHeight || 0;
export const markerSizeOf = (cfg) => (cfg.roadMarkers[0] ? cfg.roadMarkers[0].size : 3);

// 화면에 쓰는 자동차 크기 (설정값 × car.scale)
export function carDimsOf(cfg) {
  const k = cfg.car.scale || 1;
  return { length: cfg.car.length * k, width: cfg.car.width * k, height: cfg.car.height * k, color: cfg.car.color };
}
// 주행 설정 (설정값 × drive.speedScale). 빨라지면 같은 감속도로는 못 멈추니
// 가속·감속·감속 시작 거리도 같은 비율로 늘린다 → 바리케이드 앞 정지 위치는 그대로
export function driveOptsOf(cfg) {
  const d = cfg.drive, k = d.speedScale || 1;
  return {
    cruise: d.cruise * k, accel: d.accel * k, decel: d.decel * k, brakeDist: d.brakeDist * k,
    stopGap: d.stopGap, carLength: carDimsOf(cfg).length,
  };
}
// 바리케이드와 경로 사이에 있어야 할 거리: 차 폭 절반 + 여유
export const clearanceOf = (cfg) => carDimsOf(cfg).width / 2 + cfg.drive.margin;

// 도로 면 높이: 마커를 붙인 면보다 도로가 높으면(예: 마커는 테이블, 도로는 레고 판 위) +.
// 도로 면(z = h)을 기준으로 한 자세 = 원래 자세에서 원점을 법선 방향으로 h만큼 옮긴 것
export function liftPose(pose, h) {
  const R = pose.R, t = pose.t;
  return { R, t: [t[0] + R[2] * h, t[1] + R[5] * h, t[2] + R[8] * h] };
}

// 차선 맞추기(탭한 경로 → 차선 가운데) 옵션과 결과 문구
export function laneSnapOpts(cfg, mosaic) {
  const size = markerSizeOf(cfg);
  return { search: cfg.lane.search || size * 1.2, step: Math.max(mosaic.cell * 2, size / 10), laneWidth: cfg.lane.width || null };
}
export function laneSnapMessage(res) {
  if (res.ok) return `차선에 맞췄어요 · 흰 선을 찾은 구간 ${(res.validFrac * 100).toFixed(0)}% · 차선 폭 약 ${res.laneWidth.toFixed(1)}cm`;
  return res.reason === 'coverage' ? '경로 주변 도로를 덜 비췄어요 · 탭한 곳을 따라 천천히 한 번 더 비춘 뒤 다시 눌러 주세요'
    : '흰 선을 찾지 못했어요 · 더 가까이서 비추거나, 탭을 더 촘촘히 해 주세요';
}

// 좁은 화면에서 버튼 접기 (이 기기에만 기억)
export function setupMenuToggle(storageKey) {
  const grid = document.getElementById('mainButtons'), btn = document.getElementById('btnMenu');
  const set = (c) => {
    grid.classList.toggle('collapsed', c);
    btn.textContent = c ? '메뉴 펴기' : '메뉴 접기';
    btn.setAttribute('aria-expanded', String(!c));
    try { localStorage.setItem(storageKey, c ? '1' : '0'); } catch (e) { /* 무시 */ }
  };
  btn.onclick = () => set(!grid.classList.contains('collapsed'));
  try { if (localStorage.getItem(storageKey) === '1') set(true); } catch (e) { /* 무시 */ }
}
