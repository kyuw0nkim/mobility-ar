// RAIM AR 자율주행 — AR(WebXR·ARCore) 버전
// 1단계: ARCore가 카메라 움직임을 추적하고, 카메라 영상의 마커로 디오라마 위치를 한 번 맞춘다.
//        맞춘 뒤에는 마커가 화면에 없어도 자동차가 계속 달린다.
// 2단계: 바리케이드 마커(10·11)를 같은 영상에서 찾아, 경로를 막으면 감속·정지하고 치우면 다시 출발한다.
// (건물 가림은 3단계)
import * as THREE from 'three';
import { markerCorners, transformPoint, project } from './geometry.js';
import { RoadPoseTracker, solveBarricade, solveFlatMarker, toFullRes } from './tracking.js';
import { RoadMosaic, snapPathToLane, traceLane } from './lane.js';
import { refineAlongStripe, travelGuide } from './loop.js';
import {
  smoothPath, buildPath, carPoseAt, CarController, BarricadeTracker, blocksPath,
} from './logic.js';
import { loadConfig, storeConfig, loadShared, downloadShared, sharedLabel } from './store.js';
import { makeCar, makeBarricadeVis, disposeObject, clearGroup, coloredLoop } from './scene.js';
import { makeDrawnCar, carEnvironment } from './car-model.js';
import { paintCar } from './car-paint.js';
import { createCarFlow, DEFAULT_VEHICLE } from './car-flow.js';
import { isSheetMap } from './config.js';
import {
  intrinsicsFromProjection, worldFromCv, levelEstimate, AlignmentFuser, roadToWorldMatrix, roadToCv, rayToRoad, worldToRoad,
} from './xr-align.js';
import { XRCameraReader } from './xr-camera.js';
import { XRMarkerMapper } from './xr-mapper.js';
import { createAdminGate } from './admin.js';
import { DepthOcclusion, DEPTH_REQUEST, hideDepthFromThree } from './occlusion.js';
import { DetectClient } from './detect-client.js';
import { PerfMonitor } from './perf.js';
import { RunLog } from './runlog.js';
import {
  roadHeight, markerSizeOf, carDimsOf, driveOptsOf, clearanceOf, liftPose, laneSnapOpts, laneSnapMessage, setupMenuToggle, centerLineOn,
} from './common.js';

const AR = window.AR;
const $ = (id) => document.getElementById(id);
let cfg = loadConfig();
const save = () => storeConfig(cfg);

// ---------- 설정에서 나오는 값 (마커 버전과 같은 규칙) ----------
const roadH = () => roadHeight(cfg);
const markerSize = () => markerSizeOf(cfg);
const carDims = () => carDimsOf(cfg);
const driveOpts = () => driveOptsOf(cfg);
const roadIds = () => new Set(cfg.roadMarkers.map((m) => m.id));
function mapBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of cfg.roadMarkers) { x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x); y1 = Math.max(y1, m.y); }
  return { x0, y0, x1, y1 };
}
// 디오라마 작업 범위: 마커 + 저장된 경로 전체를 덮는 사각형 + 여유.
// (마커를 한두 변에만 붙이면 마커 사각형은 가는 띠라서, 그것만으로 '디오라마 안'을 판단하면 가운데의 바리케이드를 밖으로 봄)
function workArea(pad = Math.max(15, markerSize() * 2)) {
  const b = mapBounds();
  if (!cfg.pathStale) for (const [x, y] of cfg.path) { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); }
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}
const inArea = (a, x, y) => x > a.x0 && x < a.x1 && y > a.y0 && y < a.y1;

// ---------- 3D ----------
// 가벼운 모드 (기본 켬): 보급형 태블릿(갤럭시 탭 A 등)이 버티도록 부하를 줄임 — 가장자리 다듬기(안티에일리어싱) 끔,
// AR 화면 해상도 0.5배, 인식 초당 3번(위치 맞추기 전 6번, 지도·경로 만들 때 4번), 깊이 인식(가림 처리) 안 함, 차 재질 단순화, 화면 글 갱신 0.3초마다.
// 시작 화면 관리자 카드의 [가벼운 모드]로 바꾸거나 주소 뒤에 ?lite=0 / ?lite=1 (이 기기에 저장)
const LITE = (() => {
  const q = new URLSearchParams(location.search).get('lite');
  try {
    if (q === '0' || q === '1') localStorage.setItem('raim-ar-lite', q);
    const v = localStorage.getItem('raim-ar-lite');
    return v === null ? true : v === '1';
  } catch (e) { return q !== '0'; }
})();
// 가벼운 모드에서도 깊이 인식(가림 처리)만 따로 켜기 (기본 끔, 이 기기에 저장). 가벼운 모드를 끄면 원래대로 가림 설정을 따름
let liteDepth = false;
try { liteDepth = localStorage.getItem('raim-ar-lite-depth') === '1'; } catch (e) { /* 무시 */ }
const depthWanted = () => cfg.occlusion.enabled !== false && (!LITE || liteDepth);
const renderer = new THREE.WebGLRenderer({ canvas: $('three'), alpha: true, antialias: !LITE });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.xr.enabled = true;
renderer.localClippingEnabled = true; // 나만의 차: 지붕(뚜껑)과 아래를 벨트 선에서 나눠 그림
renderer.xr.setReferenceSpaceType('local');
// AR 화면 해상도: 태블릿 화면 그대로(2560×1600 등)면 GPU가 카메라 영상 합성과 겹쳐 버벅인다. 차·경로는 0.75배로도 충분히 또렷함
// (?fb=1 로 원래 해상도 시험)
const FB_SCALE = (() => { const v = +new URLSearchParams(location.search).get('fb'); return v > 0.2 && v <= 1 ? v : LITE ? 0.5 : 0.75; })();
renderer.xr.setFramebufferScaleFactor(FB_SCALE);
const perf = new PerfMonitor();
const runLog = new RunLog(); // 지난 AR 기록 (몇 초 만에 멈추는 기기 진단용)
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-0.5, 2, 0.8);
scene.add(sun);

const diorama = new THREE.Group(); // 도로 좌표(cm) → 세계(m)
diorama.matrixAutoUpdate = false;
diorama.visible = false;
scene.add(diorama);
const roadLayer = new THREE.Group(); // 도로 면 높이만큼 올린 층: 차·경로
diorama.add(roadLayer);
const markerLayer = new THREE.Group(); // 마커 지도 위치 표시 (실제 마커와 겹치면 위치가 맞은 것)
diorama.add(markerLayer);
const recordGroup = new THREE.Group();
roadLayer.add(recordGroup);
// 가림 처리: 실제 물체(건물·게이트·바리케이드·손)보다 뒤에 있는 차·경로를 그리지 않음 (ARCore 깊이 인식)
const occlusion = new DepthOcclusion(scene);
let depth = { supported: false, format: 'luminance-alpha' };
let showDepth = false;
const cardVis = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 32), new THREE.MeshBasicMaterial({ color: 0xff9f0a, side: THREE.DoubleSide }));
cardVis.visible = false;
roadLayer.add(cardVis);
let carObj = null, pathLine = null, P = null, controller = null;
const barVis = makeBarricadeVis(); // 바리케이드 자리 (노랑: 경로 밖, 빨강: 경로를 막음)
roadLayer.add(barVis.group);
let barTracker = null;
let barricade = null; // 추적 중인 바리케이드 {x, y, dx, dy, width} (도로 좌표)
let barricadeSeenNow = false;
const clearance = () => clearanceOf(cfg);
const markerVis = new Map();
// 나만의 차: 관람객이 스캔한 도안(없으면 기본 그림)을 입힌 차. 태블릿이 차에 가까이 가면 지붕이 사라지고 실내가 보임
let carFlow = null; // 스캔·미리보기 화면 (아래에서 만듦)
let defaultPainted = null; // 스캔 없이 달릴 때: 빈 도안 그림의 기본 차 (처음에 불러 둠)
let peek = 0; // 지붕 열림 0~1 (부드럽게 따라감)
function makeArCar() {
  const painted = (carFlow && carFlow.painted) || defaultPainted;
  let car;
  if (painted) car = makeDrawnCar(carDims(), painted, { lite: LITE, envMap: LITE ? null : carEnvironment(renderer) });
  else { // 기본 그림을 아직 못 불러왔을 때만: 예전 상자 차
    car = makeCar(carDims());
    const bm = car.userData.brakeMat;
    car.userData = { brakeMat: bm, setOpen: () => {}, open: 0, setBrake: (on) => bm.color.set(on ? 0xff2222 : 0x551111) };
  }
  car.userData.setOpen(peek);
  return car;
}
paintCar(DEFAULT_VEHICLE).then((p) => { defaultPainted = p; if (!(carFlow && carFlow.painted)) replaceCar(); }).catch(() => { /* 기본 그림 없음: 상자 차 */ });
function replaceCar() {
  const vis = carObj ? carObj.visible : false;
  disposeObject(carObj);
  carObj = makeArCar();
  carObj.visible = vis;
  roadLayer.add(carObj);
}
// 지붕이 열리는 거리(m): 차 길이에 맞춰 (설정 car.peekNear·peekFar로 바꿀 수 있음)
function peekRange() {
  const Lm = carDims().length * 0.01;
  const near = cfg.car.peekNear ?? Math.max(0.25, Lm * 2.2);
  const far = cfg.car.peekFar ?? near + Math.max(0.12, Lm * 1.5);
  return { near, far: Math.max(far, near + 0.02) };
}
const carWorld = new THREE.Vector3();

// keepProgress: 차 크기·도로 높이만 바뀐 경우(같은 지도·경로). 차 위치와 추적 중인 바리케이드를 그대로 둔다
// (바리케이드를 잊으면, 화면 밖에서 '기억 중'이던 바리케이드를 차가 그냥 지나감)
function rebuildWorld(keepProgress = true) {
  const frac = controller && P ? controller.s / P.length : 0;
  P = buildPath(smoothPath(cfg.path, true, 0.5, cfg.car.length * 0.3), true);
  controller = new CarController(driveOpts());
  if (keepProgress) controller.s = frac * P.length;
  replaceCar();
  disposeObject(pathLine);
  pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P.pts.map((p) => new THREE.Vector3(p[0], p[1], 0.05))),
    new THREE.LineBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.8 }));
  roadLayer.add(pathLine);
  roadLayer.position.z = roadH();
  occlusion.setMargin(cfg.occlusion.margin ?? 0.03, cfg.occlusion.marginRel ?? 0.03);
  showOcclusionButton();
  const b = cfg.barricade;
  barVis.box.scale.set(b.width, 0.8, b.height);
  barVis.edges.scale.set(b.width, 0.8, b.height);
  if (!keepProgress || !barTracker) {
    barTracker = new BarricadeTracker(cfg.barricadeTracking);
    barricade = null;
  }
  // 마커 테두리
  clearGroup(markerLayer); markerVis.clear();
  for (const m of cfg.roadMarkers) {
    const cs = markerCorners(m).map(([x, y]) => new THREE.Vector3(x, y, 0.05));
    const mat = new THREE.LineBasicMaterial({ color: 0x3ddc84 });
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(cs), mat);
    markerLayer.add(line); markerVis.set(m.id, mat);
  }
  const key = JSON.stringify(cfg.roadMarkers) + '|' + roadH();
  // 도로 영상(차선 맞추기·자동 경로용)은 인식 워커가 모은다. 지도나 도로 높이가 바뀌면 새로 시작
  if (mosaicKey !== key) {
    mosaicKey = key;
    detectClient.resetMosaic(RoadMosaic.specForMarkers(cfg.roadMarkers, Math.min(120, markerSize() * 15)));
    scanPercent = 0;
  }
}

// ---------- 상태 ----------
let session = null, refSpace = null, binding = null, reader = null, hitSource = null;
const roadTracker = new RoadPoseTracker();
const fuser = new AlignmentFuser();
let mosaicKey = null; // 도로 영상 설정 키 (실제 영상은 detectClient 쪽)
let scanPercent = 0; // 경로 기록 중 비춘 범위(%) — 워커가 1초에 한 번 알려 줌
let laneBusy = false; // 자동 경로·차선 맞추기 계산 중
let lastT = null, lastDet = -Infinity, detMs = 0, fps = 0, detCount = 0;
// 영상 인식은 한 번에 한 프레임씩: GPU에서 읽기(gpu) → 워커에서 인식(detect) → 결과 반영. 그동안 화면은 계속 그린다
const detectClient = new DetectClient();
let inflight = null; // 인식 중인 프레임 {stage, gen, t, now, wc, proj}
let gen = 0; // AR 세션 번호 (끝난 세션의 늦은 결과는 버림)
let lastSeen = new Map(); // 마커 id → 마지막으로 본 시각
let showPath = true, showMarkers = true; // showMarkers: 마커 테두리·인식 표시 (관리자 모드에서만 보임)
// AR 지도 만들기 (setup: 한 바퀴 설치 — 지도 만들기 + 중앙선 찾기를 같이)
const mapping = { active: false, setup: false, mapper: null, view: null, A0: null, loop: null, finding: false, lastFind: -1e9 };
let trackingPoor = false;
const recording = { active: false, pts: [], snapped: null };
const heightMeasure = { active: false, until: 0, samples: [] };
let flashUntil = 0;
let lastPeekDist = null;
let lastSnap = null;

// ---------- 시작 화면 ----------
function showLite() {
  $('btnLite').textContent = LITE ? '가벼운 모드 켬' : '가벼운 모드 끔';
  $('btnLite').classList.toggle('off', !LITE);
  $('btnLiteDepth').hidden = !LITE;
  $('btnLiteDepth').textContent = liteDepth ? '가벼운 모드 가림 켬' : '가벼운 모드 가림 끔';
  $('btnLiteDepth').classList.toggle('off', !liteDepth);
  const lr = RunLog.describe();
  $('lastRun').hidden = !lr;
  $('lastRun').innerHTML = lr;
}
// 가벼운 모드 바꾸기: 렌더러를 새로 만들어야 해서 페이지를 다시 연다
$('btnLite').onclick = () => {
  try { localStorage.setItem('raim-ar-lite', LITE ? '0' : '1'); } catch (e) { /* 무시 */ }
  location.replace(location.pathname);
};
$('btnLiteDepth').onclick = () => {
  liteDepth = !liteDepth;
  try { localStorage.setItem('raim-ar-lite-depth', liteDepth ? '1' : '0'); } catch (e) { /* 무시 */ }
  if (liteDepth && cfg.occlusion.enabled === false) { cfg.occlusion.enabled = true; save(); }
  showLite();
};
function describeMap() {
  showLite();
  const n = cfg.roadMarkers.length;
  const isSheet = isSheetMap(cfg.roadMarkers);
  $('mapInfo').innerHTML = `마커 지도: <b>${n}개</b> · 마커 크기 ${markerSize()}cm${isSheet ? ' (A4 테스트 시트 기본값)' : ''}<br>` +
    `경로: ${cfg.pathStale ? '<b>없음</b> · AR 안에서 [경로 기록]으로 만들어요' : `점 ${cfg.path.length}개`} · 도로 높이 ${roadH().toFixed(2)}cm<br>` +
    `차 크기 ×${(cfg.car.scale || 1).toFixed(2)} · 속도 ×${(cfg.drive.speedScale || 1).toFixed(2)}` +
    (isSheet ? '<br><span style="color:var(--warn)">디오라마에서 쓰려면 AR을 시작한 뒤 [지도 만들기]를 먼저 해 주세요.</span>' : '');
}
async function checkSupport() {
  describeMap();
  if (!AR) { $('startMsg').textContent = '마커 인식 라이브러리를 불러오지 못했어요.'; return; }
  if (!window.isSecureContext) { $('startMsg').textContent = 'https 주소로 열어야 AR을 쓸 수 있어요.'; return; }
  let ok = false;
  try { ok = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { /* 아래 */ }
  if (!ok) {
    $('startMsg').textContent = '이 기기에서는 AR을 쓸 수 없어요.\n갤럭시 태블릿의 Chrome에서 열어 주세요.';
    return;
  }
  $('startMsg').textContent = cfg.pathStale ? '아직 경로가 준비되지 않았어요 · 직원에게 알려 주세요' : '';
  setStartButton('idle');
}

// ---------- AR 시작 ----------
// 시작 버튼 상태: 'idle' | 'starting'(세션 요청 중) | 'cooldown'(방금 끝난 AR을 ARCore가 정리하는 중)
let startState = 'idle', startAttempt = 0, endedAt = -1e9;
const START_TIMEOUT = window.__raimStartTimeout || 12000; // 이만큼 지나도 세션이 안 열리면 포기하고 다시 누르게 (늦게 열리면 바로 닫음)
const COOLDOWN = 1500; // AR을 끝낸 직후 바로 다시 누르면 ARCore가 카메라를 아직 놓지 않아 요청이 멈추거나 거절됨
function setStartButton(state, label) {
  startState = state;
  $('btnStart').disabled = state !== 'idle';
  $('btnStart').textContent = label || '시작하기';
  $('btnGo').disabled = state !== 'idle';
  $('btnGo').textContent = label || '이 차로 달리기';
}
function startFailed(msg) {
  $('startMsg').textContent = msg;
  $('goMsg').textContent = msg;
  setStartButton('idle');
  runLog.startNote(msg);
}
// 세션 요청 이유를 사람이 읽을 말로
function startErrorText(e) {
  const n = e && e.name;
  if (n === 'InvalidStateError') return '이전 AR이 아직 정리 중이에요 · 잠시 뒤 다시 눌러 주세요';
  if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라·AR 사용이 허용되지 않았어요 · 다시 눌러 주세요 (권한 창이 뜨면 허용)';
  if (n === 'NotSupportedError') return '이 기기에서 AR을 시작할 수 없어요 (ARCore 확인 필요)';
  return 'AR을 시작하지 못했어요 · 다시 눌러 주세요' + (e && e.message ? ` (${e.message})` : '');
}
async function startAR() {
  if (startState !== 'idle' || session) return;
  const my = ++startAttempt;
  setStartButton('starting', 'AR 시작 중…');
  $('startMsg').textContent = '';
  $('goMsg').textContent = '';
  const t0 = performance.now();
  runLog.startNote(null);
  // 시간이 지나도 안 열리면 포기 (그 뒤에 열리면 아래에서 바로 닫음)
  const timer = setTimeout(() => {
    if (startAttempt !== my || startState !== 'starting') return;
    startAttempt++;
    startFailed('AR이 열리지 않아요 · 다시 눌러 주세요 (계속 안 되면 Chrome을 닫았다 열어 주세요)');
  }, START_TIMEOUT);
  try {
    await openSession(my);
  } catch (e) {
    clearTimeout(timer);
    if (startAttempt === my) startFailed(startErrorText(e));
    return;
  }
  clearTimeout(timer);
  if (startAttempt !== my) { // 포기한 뒤에 늦게 열림 → 닫기
    const s2 = session; session = null;
    try { s2.end(); } catch (e) { /* 무시 */ }
    return;
  }
  runLog.startNote(`세션 열림 ${Math.round(performance.now() - t0)}ms`);
  try {
    await enterAR();
  } catch (e) {
    reportError('AR 준비', e);
    const s2 = session;
    try { s2.end(); } catch (e2) { /* 무시 */ }
    startFailed('AR 준비 중 문제가 생겼어요 · 다시 눌러 주세요');
  }
}
// 세션 요청은 버튼을 누른 직후(사용자 동작 안)에 한 번에: 깊이 인식은 선택 기능이라 지원 안 하는 기기는 그냥 빠진다.
// 그래도 깊이 옵션 때문에 바로 거절되는 기기면(1초 안), 깊이 없이 한 번 더
async function openSession(my) {
  const opts = {
    requiredFeatures: ['local'],
    // hit-test는 [높이 자동] 때만 켠다 (켜 두면 ARCore가 매 프레임 바닥 찾기를 계산). anchors는 안 씀
    optionalFeatures: ['camera-access', 'hit-test', 'dom-overlay'],
    domOverlay: { root: $('ui') },
  };
  let s1;
  if (!depthWanted()) s1 = await navigator.xr.requestSession('immersive-ar', opts);
  else {
    const t0 = performance.now();
    try {
      s1 = await navigator.xr.requestSession('immersive-ar', { ...opts, optionalFeatures: [...opts.optionalFeatures, DEPTH_REQUEST.optional], depthSensing: DEPTH_REQUEST.depthSensing });
    } catch (e) {
      if (!(e && (e.name === 'NotSupportedError' || e.name === 'TypeError')) || performance.now() - t0 > 1000) throw e;
      s1 = await navigator.xr.requestSession('immersive-ar', opts);
    }
  }
  if (startAttempt !== my) { try { s1.end(); } catch (e) { /* 무시 */ } throw Object.assign(new Error('늦게 열림'), { name: 'Late' }); }
  session = s1;
}
async function enterAR() {
  const f = [...(session.enabledFeatures || [])];
  depth = { requested: depthWanted(), supported: f.includes('depth-sensing') && session.depthUsage === 'cpu-optimized', format: session.depthDataFormat || 'luminance-alpha' };
  if (f.length && !f.includes('camera-access')) {
    const s2 = session; session = null; s2.end();
    startFailed('이 기기는 AR 중 카메라 영상 접근(camera-access)이 안 돼서 마커로 위치를 맞출 수 없어요.');
    return;
  }
  session.addEventListener('end', onEnd);
  session.addEventListener('select', onSelect);
  runLog.start({ lite: LITE, fb: FB_SCALE, features: f.join(','), depth: depth.supported, usage: session.depthUsage || null, layers: session.renderState.layers !== undefined });
  // three.js(r170)는 'depth-sensing'이 켜져 있으면 매 프레임 GPU 방식 깊이(XRWebGLBinding.getDepthInformation)를 읽는데,
  // 우리는 CPU 방식이라 그 호출이 오류를 낸다 (WebXR 층(layers)이 있는 Chrome에서 binding이 생기면). 그래서 three.js에는 늘 숨긴다
  if (session.depthUsage !== 'gpu-optimized') hideDepthFromThree(session);
  guardFrames(session);
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  // three.js는 'layers' 기능이 있을 때만 binding을 만들어서 안드로이드에서는 직접 만든다
  try { binding = renderer.xr.getBinding() || new XRWebGLBinding(session, renderer.getContext()); } catch (e) { binding = null; flash('카메라 영상 연결 실패: ' + e.message, 8000); }
  try { reader = new XRCameraReader(renderer.getContext()); } catch (e) { flash('카메라 영상 준비 실패: ' + e.message, 8000); }
  renderer.resetState();
  hitSource = null;
  gen++; inflight = null;
  perf.reset();
  document.body.classList.add('in-ar');
  fuser.reset(); roadTracker.reset();
  diorama.visible = false;
  lastT = null;
  peek = 0; lastPeekDist = null;
  if (carFlow) carFlow.leave();
  replaceCar();
  $('start').hidden = true;
  $('ui').hidden = false;
  if (cfg.pathStale) flash('경로가 없어요 · 위치가 맞으면 [경로 기록]으로 만들어 주세요', 5000);
  renderer.setAnimationLoop(onXRFrame);
  setStartButton('starting', 'AR 실행 중');
}

// 프레임 콜백 안에서 오류가 한 번 나면 three.js는 다음 프레임을 요청하지 않아 AR 화면이 그대로 멈춘다.
// session.requestAnimationFrame을 감싸서, 오류가 나도 기록하고 다음 프레임을 이어 간다
let frameErrors = 0, injectError = false;
function reportError(where, e) {
  frameErrors++;
  const msg = `${where}: ${(e && (e.message || e.name)) || e}`.slice(0, 140);
  runLog.ev('error', msg);
  runLog.note(msg);
  if (gate.on) flash(`오류(${frameErrors}번): ${msg}`, 4000);
  console.error(e);
}
function guardFrames(s) {
  const raf = s.requestAnimationFrame.bind(s);
  s.requestAnimationFrame = (cb) => raf(function guarded(t, frame) {
    try { cb(t, frame); } catch (e) {
      reportError('프레임', e);
      if (session === s) raf(guarded); // 원래 콜백이 다음 프레임을 요청하기 전에 오류가 났으면 대신 요청
    }
  });
}
window.addEventListener('error', (e) => { if (session) reportError('스크립트', e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { if (session) reportError('비동기', e.reason); });
function onEnd() {
  renderer.setAnimationLoop(null);
  if (reader) reader.cancel();
  gen++; inflight = null;
  session = null; hitSource = null; binding = null; reader = null;
  document.body.classList.remove('in-ar');
  runLog.end();
  setRecording(false);
  $('ui').hidden = true;
  $('start').hidden = false;
  // 다음 관람객은 새 도안으로 (기본 차로 돌려 둠)
  if (carFlow) { carFlow.reset(); replaceCar(); }
  // 방금 끝난 AR을 ARCore가 정리할 시간 (바로 누르면 요청이 멈추거나 거절됨)
  endedAt = performance.now();
  setStartButton('cooldown', '잠시만요…');
  setTimeout(() => { if (startState === 'cooldown') setStartButton('idle'); }, COOLDOWN);
  describeMap();
}

// ---------- 프레임 ----------
function onXRFrame(t, frame) {
  if (!frame || !session) return; // AR이 끝난 직후 한 번 더 불릴 수 있음
  const w0 = performance.now();
  if (injectError) { injectError = false; throw new Error('시험 오류'); }
  perf.frame(t);
  const dt = lastT === null ? 0 : Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (dt > 0) fps = fps * 0.9 + 0.1 / dt;
  const pose = frame.getViewerPose(refSpace);
  if (pose) {
    trackingPoor = !!pose.emulatedPosition;
    const view = pose.views[0];
    lastCenterRay = centerRay(view);
    // 초당 인식 횟수 (위치 맞춤 + 바리케이드). 가벼운 모드: 위치를 맞추기 전엔 6번(빨리 맞추게), 맞춘 뒤엔 3번, 지도·경로 만들 때 4번
    const rate = !LITE || !fuser.ready ? 6 : mapping.active || recording.active ? 4 : 3;
    if (inflight && performance.now() - inflight.now > 3000) { if (reader) reader.cancel(); inflight = null; } // 안전장치: 결과가 안 오면 버림
    if (!inflight && reader && binding && view.camera && t - lastDet > 1000 / rate) {
      lastDet = t;
      capture(view, t);
    }
    if (heightMeasure.active) measureHeight(frame, t);
  }
  if (inflight && inflight.stage === 'gpu') collect();
  const A = fuser.result;
  if (fuser.ready) {
    diorama.matrix.set(...roadToWorldMatrix(A));
    diorama.matrixWorldNeedsUpdate = true;
  }
  diorama.visible = fuser.ready && (!mapping.active || mapping.setup);
  // 차: 바리케이드가 경로를 막으면 감속·정지
  controller.update(dt, P, barricade, clearance());
  carObj.userData.setBrake(controller.state !== 'drive');
  if (barricade) {
    barVis.group.visible = true;
    barVis.group.position.set(barricade.x, barricade.y, cfg.barricade.height / 2);
    barVis.group.rotation.set(0, 0, Math.atan2(barricade.dy, barricade.dx));
    const col = controller.gap !== null ? 0xff3b30 : 0xffc400;
    barVis.fillMat.color.set(col);
    barVis.lineMat.color.set(col);
  } else {
    barVis.group.visible = false;
  }
  const q = carPoseAt(P, controller.s, carDims().length * 0.6);
  carObj.position.set(q.x, q.y, 0);
  carObj.rotation.set(0, 0, q.heading);
  carObj.visible = !recording.active && !cfg.pathStale && !mapping.active;
  // 태블릿(카메라)이 차에 가까이 오면 지붕을 열어 실내를 보여 줌
  if (pose && carObj.visible && diorama.visible) {
    carObj.getWorldPosition(carWorld);
    const p = pose.views[0].transform.position;
    const dist = Math.hypot(p.x - carWorld.x, p.y - carWorld.y, p.z - carWorld.z);
    const { near, far } = peekRange();
    const target = Math.min(1, Math.max(0, (far - dist) / (far - near)));
    peek += (target - peek) * Math.min(1, dt * 5);
    lastPeekDist = dist;
  } else peek += (0 - peek) * Math.min(1, dt * 5);
  carObj.userData.setOpen(peek);
  pathLine.visible = !cfg.pathStale && (showPath || recording.active) && !mapping.active;
  markerLayer.visible = showMarkers && gate.on && !mapping.active;
  if (mapping.setup && mapping.A0 && !mapping.finding && performance.now() - mapping.lastFind > 3000) findSetupLoop();
  // 경로 카드 위치 표시: 주황 = 확인 중, 초록 = 방금 찍음
  const cm = recording.active ? cardMean(400) : null;
  cardVis.visible = !!cm;
  if (cm) {
    cardVis.position.set(cm.x, cm.y, 0.2);
    cardVis.scale.setScalar(cfg.pathCard.size / 5);
    cardVis.material.color.set(performance.now() - card.captured < 800 ? 0x3ddc84 : 0xff9f0a);
  }
  const now = performance.now();
  for (const [id, mat] of markerVis) mat.color.set(now - (lastSeen.get(id) || -1e9) < 600 ? 0x3ddc84 : 0x1f6f45);
  occlusion.update(frame, pose ? pose.views[0] : null, { enabled: !!pose && cfg.occlusion.enabled !== false && !mapping.active, supported: depth.supported, format: depth.format });
  renderer.render(scene, camera);
  updateHud(t);
  const ms = performance.now() - w0;
  perf.work(ms);
  if (fuser.ready) runLog.ev('aligned');
  if (carObj.visible && diorama.visible) runLog.ev('car');
  if (occlusion.status === 'on') runLog.ev('depth', occlusion.size && occlusion.size.join('×'));
  runLog.frame(t, ms, () => ({ det: Math.round(detMs) }));
}

// 1) 이번 프레임의 카메라 영상을 작은 텍스처에 그리고 GPU 읽기를 걸어 둔다 (기다리지 않음)
function capture(view, t) {
  // 카메라 영상을 읽으려면 잠시 다른 프레임버퍼에 그려야 한다. 끝나면 three.js 상태를 초기화하고
  // AR 층(렌더 타깃)을 다시 지정해야 한다 — 안 하면 이 프레임의 차가 보이지 않는 화면에 그려져 깜빡인다
  const rt = renderer.getRenderTarget();
  let ok = false;
  try { ok = reader.capture(binding, view); } catch (e) { ok = false; }
  renderer.resetState();
  renderer.setRenderTarget(rt);
  if (!ok) return;
  runLog.ev('camera', `${reader.w}×${reader.h}`);
  // 그 순간의 휴대폰 자세·투영을 같이 기억 (결과는 몇 프레임 뒤에 오지만 계산은 찍은 순간 기준)
  inflight = { stage: 'gpu', gen, t, now: performance.now(), wc: worldFromCv(view.transform.matrix), proj: Array.from(view.projectionMatrix) };
}
// 2) GPU 읽기가 끝났으면 워커로 넘겨 인식
function collect() {
  let img = null;
  try { img = reader.poll(); } catch (e) { reader.cancel(); inflight = null; return; }
  if (!img) return;
  const job = inflight;
  job.stage = 'detect';
  // 경로 기록 중: 차선 맞추기용 도로 영상 모으기 (찍은 순간의 휴대폰 자세 + 지금까지 맞춘 위치)
  let acc = null;
  if (recording.active && !mapping.active && fuser.ready) {
    const K = intrinsicsFromProjection(job.proj, img.width, img.height);
    acc = { K, pose: liftPose(roadToCv(fuser.result, job.wc), roadH()), area: workArea(0) };
  } else if (mapping.setup && mapping.A0) {
    // 한 바퀴 설치: 처음 등록된 마커로 정한 좌표계(A0)로 도로 영상을 모음 (범위는 비추는 대로 넓어짐)
    const K = intrinsicsFromProjection(job.proj, img.width, img.height);
    acc = { K, pose: liftPose(roadToCv(mapping.A0, job.wc), roadH()), area: null };
  }
  detectClient.run(img, { acc }).then((res) => {
    if (inflight === job) inflight = null;
    if (!res) return;
    const r = reader;
    try {
      if (job.gen !== gen || !session || !r) return;
      if (res.error) flash(`인식 오류: ${res.error}`, 5000);
      if (res.coverage !== null && res.coverage !== undefined) scanPercent = res.coverage;
      detMs = detMs * 0.8 + res.ms * 0.2;
      runLog.ev('detect', `${Math.round(res.ms)}ms`);
      detCount++;
      handleDetections(job, { width: img.width, height: img.height, data: res.data }, res);
    } finally {
      if (r) r.recycle(res.data);
    }
  });
}
// 3) 인식 결과 반영: 위치 맞춤, 바리케이드, 경로 기록
function handleDetections(job, img, res) {
  const ids = roadIds();
  const markers = res.markers.map((m) => ({ id: m.id, c: toFullRes(m.corners, 1) }));
  const K = intrinsicsFromProjection(job.proj, img.width, img.height);
  const wc = job.wc;
  const t = job.t, now = job.now;
  if (mapping.active) {
    const usable = markers.filter((m) => !cfg.barricade.markerIds.includes(m.id) && m.id !== cfg.pathCard.id && m.id <= 49);
    reader.feedback(usable.length > 0);
    mapping.mapper.addFrame(usable, K, wc);
    const mp = mapping.mapper;
    if (mapping.setup && !mapping.A0 && mp.status().confirmed.length) startSetupMosaic();
    mapping.view = {
      w: img.width, h: img.height, t: performance.now(),
      items: usable.map((m) => {
        const n = (mp.samples.get(m.id) || []).length;
        const ok = mp.confirmed(m.id);
        return { c: m.c, label: m.id === mp.status().refId ? `${m.id} 기준` : ok ? `${m.id} 등록됨` : `${m.id} 확인 중 ${n}/${mp.minSamples}`, col: m.id === mp.status().refId ? '#38d9ff' : ok ? '#3ddc84' : '#ff9f0a' };
      }),
    };
    return;
  }
  const road = markers.filter((m) => ids.has(m.id));
  reader.feedback(road.length > 0);
  for (const m of road) lastSeen.set(m.id, now);
  if (road.length) {
    const r = roadTracker.update(road, cfg.roadMarkers, K, t);
    if (r.pose) {
      const vis = cfg.roadMarkers.filter((m) => road.some((q) => q.id === m.id));
      const anchor = [vis.reduce((s, m) => s + m.x, 0) / vis.length, vis.reduce((s, m) => s + m.y, 0) / vis.length, 0];
      fuser.add(levelEstimate(r.pose, wc, anchor), r.count);
    }
  }
  if (!fuser.ready) return;
  // 지금 카메라에서 본 도로 자세 (마커가 안 보여도 ARCore + 맞춘 위치로 계산)
  const camPose = roadToCv(fuser.result, wc);
  // 바리케이드: 마커 10·11 → 도로 좌표. 여러 프레임 확인 후 등장, 그 자리가 보이는데 안 잡히면 해제
  const obs = solveBarricade(markers, cfg.barricade, K, camPose);
  const src = obs ? '마커' : null;
  barricadeSeenNow = src;
  let inView = false;
  if (barTracker.est) {
    const X = [barTracker.est.x, barTracker.est.y, roadH() + 1];
    if (transformPoint(camPose, X)[2] > 0) {
      const u = project(K, camPose.R, camPose.t, X);
      inView = u[0] > img.width * 0.08 && u[0] < img.width * 0.92 && u[1] > img.height * 0.08 && u[1] < img.height * 0.92;
    }
  }
  const est = barTracker.update(now, obs, inView);
  barricade = est ? { ...est, width: cfg.barricade.width } : null;
  // 경로 기록 중: 경로 카드(마커 20)가 보이면 위치를 모으고, 1초 동안 거의 안 움직이면 점으로 찍는다
  if (recording.active) {
    const pc = cfg.pathCard;
    const m = markers.find((q) => q.id === pc.id);
    const r = m ? solveFlatMarker(m, pc.size, K, camPose) : null;
    if (r && r.tilt < 20) {
      card.hist.push({ t: now, x: r.x, y: r.y });
      card.seen = now;
    }
    card.hist = card.hist.filter((h) => now - h.t < 1200);
    autoCapture(now);
  }
}

// ---------- 화면 탭 → 경로 점 ----------
// 조준점 켬(기본): 손가락 위치 대신 화면 가운데(조준점)를 지나는 시선을 쓴다. 손가락은 화면에서 2~3mm 빗나가고,
// 그게 디오라마에서는 태블릿 1~2cm·휴대폰 3~5cm가 된다. 태블릿을 움직여 조준점을 중앙선에 맞추면 그 오차가 없다.
let aimOn = true;
try { aimOn = localStorage.getItem('raim-ar-aim') !== '0'; } catch (e) { /* 무시 */ }
let lastCenterRay = null; // 화면 가운데를 지나는 시선 {o, d} (세계, 매 프레임)
function centerRay(view) {
  const M = view.transform.matrix, P = view.projectionMatrix;
  // 투영 중심이 화면 가운데에서 벗어난 만큼(P[8], P[9])까지 고려한 화면 가운데 방향 (뷰 공간)
  const dv = [P[8] / P[0], P[9] / P[5], -1];
  const d = [M[0] * dv[0] + M[4] * dv[1] + M[8] * dv[2], M[1] * dv[0] + M[5] * dv[1] + M[9] * dv[2], M[2] * dv[0] + M[6] * dv[1] + M[10] * dv[2]];
  const L = Math.hypot(...d);
  return { o: [M[12], M[13], M[14]], d: d.map((v) => v / L) };
}
function onSelect(e) {
  if (!recording.active || !fuser.ready) return;
  let o, d;
  if (aimOn && lastCenterRay) ({ o, d } = lastCenterRay);
  else {
    const p = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
    if (!p) return;
    const m = p.transform.matrix;
    o = [m[12], m[13], m[14]];
    d = [-m[8], -m[9], -m[10]];
    const L = Math.hypot(...d); d = d.map((v) => v / L);
  }
  const q = rayToRoad(fuser.result, o, d, roadH());
  if (!q) return;
  addTapPoint(q);
}
// 탭한 점을 기록하고, 그 근처의 흰 중앙선에 바로 붙인다 (워커가 모은 도로 영상에서 찾음).
// 점 색: 분홍 = 확인 중, 초록 = 중앙선에 붙음, 주황 = 중앙선을 못 찾아 탭한 자리 그대로
const tapState = new WeakMap();
function addTapPoint(q) {
  const entry = [+q[0].toFixed(2), +q[1].toFixed(2)];
  recording.pts.push(entry);
  recording.snapped = null; recording.snapWeak = null; recording.partial = null; recording.stopAt = null;
  if (!centerLineOn(cfg)) { refreshRecordVis(); return; } // A4 시트 등: 붙이지 않음
  tapState.set(entry, 'pending');
  refreshRecordVis();
  const roadWidth = cfg.lane.roadWidth || 24;
  // 앞서 찍은 점으로 예상한 경로 선 (가로지르는 주차선, 도로 위 흰 기둥 자국에 붙지 않게)
  const guide = travelGuide(recording.pts.filter((q) => q !== entry && tapState.get(q) === 'ok'), entry);
  detectClient.snapPoint(entry.slice(), { roadWidth, guide }).then((r) => {
    if (!recording.pts.includes(entry)) return; // 그새 되돌리기
    if (r && r.ok) {
      entry[0] = +r.x.toFixed(2); entry[1] = +r.y.toFixed(2);
      tapState.set(entry, 'ok');
    } else {
      tapState.set(entry, 'miss');
      flash(r && r.reason === 'unscanned' ? '그 자리 도로를 아직 덜 비췄어요 · 탭한 자리 그대로 찍었어요(주황)'
        : '근처에서 흰 중앙선을 못 찾아 탭한 자리 그대로 찍었어요(주황) · 조준점을 중앙선에 더 가깝게 맞춰 보세요', 3000);
    }
    refreshRecordVis();
  });
}
function setAim(on) {
  aimOn = on;
  try { localStorage.setItem('raim-ar-aim', on ? '1' : '0'); } catch (e) { /* 무시 */ }
  $('recAim').textContent = on ? '조준점 켬' : '조준점 끔(손가락)';
  $('recAim').classList.toggle('off', !on);
  $('aim').hidden = !(recording.active && on);
}
// 버튼을 누를 때는 AR 탭(select)이 생기지 않게
$('ui').addEventListener('beforexrselect', (e) => { if (e.target.closest('button, input, label, .glass, [data-noselect]')) e.preventDefault(); });

function refreshRecordVis() {
  clearGroup(recordGroup);
  const s = cfg.car.width / 1.8;
  const geo = new THREE.SphereGeometry(0.35 * s, 12, 8);
  const mats = { pending: new THREE.MeshBasicMaterial({ color: 0xff00aa }), ok: new THREE.MeshBasicMaterial({ color: 0x3ddc84 }), miss: new THREE.MeshBasicMaterial({ color: 0xff9f0a }) };
  for (const p of recording.pts) {
    const b = new THREE.Mesh(geo, mats[tapState.get(p) || 'pending']);
    b.position.set(p[0], p[1], 0.35 * s);
    recordGroup.add(b);
  }
  if (recording.pts.length > 1) {
    recordGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...recording.pts, recording.pts[0]].map((p) => new THREE.Vector3(p[0], p[1], 0.1))),
      new THREE.LineBasicMaterial({ color: 0xff00aa, transparent: true, opacity: recording.snapped ? 0.35 : 1 })));
  }
  if (recording.partial) {
    recordGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(recording.partial.map((p) => new THREE.Vector3(p[0], p[1], 0.15))),
      new THREE.LineBasicMaterial({ color: 0xff9f0a })));
  }
  if (recording.stopAt) {
    const s2 = cfg.car.width / 1.8;
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.6 * s2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
    b.position.set(recording.stopAt[0], recording.stopAt[1], 0.6 * s2);
    recordGroup.add(b);
  }
  if (recording.snapped) {
    if (recording.snapWeak) recordGroup.add(coloredLoop(recording.snapped, recording.snapWeak, 0x3ddc84, 0.15));
    else {
      const sp = smoothPath(recording.snapped, true, 0.5);
      recordGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...sp, sp[0]].map((p) => new THREE.Vector3(p[0], p[1], 0.15))),
        new THREE.LineBasicMaterial({ color: 0x3ddc84 })));
    }
  }
}
function setRecording(on) {
  recording.active = on;
  recording.pts = [];
  recording.snapped = null; recording.snapWeak = null;
  recording.partial = null; recording.stopAt = null;
  refreshRecordVis();
  $('recordBar').hidden = !on;
  $('mainButtons').hidden = on;
  setAim(aimOn);
}
// ---------- 경로 카드로 점 찍기 ----------
const card = { hist: [], seen: -1e9, captured: -1e9 };
function cardMean(windowMs) {
  const now = performance.now();
  const h = card.hist.filter((q) => now - q.t < windowMs);
  if (!h.length) return null;
  const x = h.reduce((s, q) => s + q.x, 0) / h.length, y = h.reduce((s, q) => s + q.y, 0) / h.length;
  const spread = Math.max(...h.map((q) => Math.hypot(q.x - x, q.y - y)));
  return { x, y, n: h.length, spread, span: now - h[0].t };
}
function addCardPoint(p) {
  recording.pts.push([+p.x.toFixed(2), +p.y.toFixed(2)]);
  recording.snapped = null; recording.partial = null; recording.stopAt = null;
  card.captured = performance.now();
  refreshRecordVis();
  flash(`점 ${recording.pts.length} 찍었어요 · 카드를 다음 자리로 옮겨 주세요 (곡선은 5~10cm, 직선은 20~30cm 간격)`, 2500);
}
function autoCapture(now) {
  const m = cardMean(1000);
  // 1초 가까이(0.7초 이상, 3번 이상 인식) 거의 안 움직였을 때만. 흔들림 허용치는 카드 크기에 비례 (5cm 카드 → 0.75cm)
  if (!m || m.n < 3 || m.span < 700 || m.spread > Math.max(0.6, cfg.pathCard.size * 0.15)) return;
  const last = recording.pts.at(-1);
  if (last && Math.hypot(m.x - last[0], m.y - last[1]) < Math.max(2, cfg.pathCard.size * 0.6)) return; // 같은 자리는 한 번만
  addCardPoint(m);
}

// 모은 도로 영상 받아 계산하기 (워커에서 복사해 옴). 계산 중 버튼을 또 누르면 무시
async function withMosaic(fn) {
  if (laneBusy) return;
  laneBusy = true;
  try {
    const mosaic = await detectClient.mosaic();
    if (!mosaic) { flash('도로 영상이 아직 없어요 · 도로를 천천히 비춘 뒤 다시 눌러 주세요', 4000); return; }
    fn(mosaic);
  } finally {
    laneBusy = false;
  }
}
// 자동 경로: 두 번 탭(출발점 → 진행 방향 쪽)한 차선을 따라 한 바퀴 추적
function autoPath() {
  if (recording.pts.length < 2) { flash('차선 위를 두 번 탭해 주세요: 출발점, 그다음 진행 방향 쪽으로 조금 앞', 4000); return; }
  withMosaic((mosaic) => autoPathWith(mosaic));
}
function autoPathWith(mosaic) {
  if (!recording.active || recording.pts.length < 2) return;
  const [a, b] = recording.pts.slice(-2);
  const res = traceLane(mosaic, a, b, { search: cfg.lane.search || markerSize() * 1.5, step: Math.max(mosaic.cell * 3, markerSize() / 8), laneWidth: cfg.lane.width || null });
  lastSnap = res;
  recording.partial = null; recording.stopAt = null;
  if (res.ok) {
    recording.snapped = res.pts;
    refreshRecordVis();
    flash(`한 바퀴 찾았어요 · 길이 ${(res.length / 100).toFixed(2)}m · 차선 폭 약 ${res.laneWidth.toFixed(1)}cm${res.bridged ? ' · 출발점 근처는 이어 붙임' : ''} · 괜찮으면 [완료·저장]`, 6000);
    return;
  }
  if (res.pts && res.pts.length > 1) { recording.partial = res.pts; recording.stopAt = res.stopAt; }
  refreshRecordVis();
  flash(res.reason === 'nolane' ? '탭한 곳에서 차선(양옆이 흰 검은 노면)을 못 찾았어요 · 차선 가운데를 다시 탭해 주세요'
    : res.reason === 'unscanned' ? `${(res.length / 100).toFixed(2)}m 따라가다 아직 안 비춘 곳에서 멈췄어요(빨간 점) · 그 주변 도로를 비춘 뒤 다시 눌러 주세요`
      : `${(res.length / 100).toFixed(2)}m 따라가다 차선을 놓쳤어요(빨간 점) · 그 주변을 가까이서 비추거나, 탭으로 이어서 [차선 맞추기]를 써 주세요`, 7000);
}

function snapRecording() {
  if (recording.pts.length < 4) { flash('점을 4개 이상 찍은 뒤 눌러 주세요'); return; }
  flash('중앙선에 맞추는 중…', 2000);
  withMosaic((mosaic) => snapWith(mosaic));
}
// [중앙선 맞추기]: 탭한 점 사이 곡선까지 흰 중앙선에 붙인다. 흰 중앙선이 없는 도로(A4 시트 등)면 예전 차선 맞추기로
function snapWith(mosaic) {
  if (!recording.active || recording.pts.length < 4) return;
  // 중앙선에 붙은 점이 충분하면, 못 붙은(주황) 점은 빼고 맞춤 (잘못 조준한 탭이 곡선을 끌고 가지 않게)
  const good = recording.pts.filter((p) => tapState.get(p) !== 'miss');
  const nOk = recording.pts.filter((p) => tapState.get(p) === 'ok').length;
  const base = nOk >= 4 && nOk >= recording.pts.length * 0.5 ? good : recording.pts;
  const res = centerLineOn(cfg) ? refineAlongStripe(mosaic, base, { roadWidth: cfg.lane.roadWidth || 24 }) : { ok: false };
  if (res.ok) {
    lastSnap = { ...res, method: 'stripe' };
    recording.snapped = res.pts; recording.snapWeak = res.weak;
    refreshRecordVis();
    const nWeak = res.weak.filter(Boolean).length;
    flash(`중앙선에 맞췄어요 · 확인 ${Math.round(res.refined * 100)}%${nWeak ? ' · 주황 부분은 중앙선을 못 봐서 이어 붙였어요(그 도로를 더 비추고 다시 누르면 좋아져요)' : ''} · 괜찮으면 [완료·저장]`, 6000);
    return;
  }
  const lane = snapPathToLane(mosaic, recording.pts, laneSnapOpts(cfg, mosaic));
  lastSnap = { ...lane, method: 'lane' };
  flash(lane.ok ? laneSnapMessage(lane) : '흰 중앙선을 찾지 못했어요 · 탭한 곳 주변 도로를 천천히 더 비춘 뒤 다시 눌러 주세요', 5000);
  if (!lane.ok) return;
  recording.snapped = lane.pts; recording.snapWeak = null;
  refreshRecordVis();
}

// ---------- 도로 높이 자동 측정: ARCore가 찾은 바닥(도로 면)의 높이 ----------
function measureHeight(frame, t) {
  if (t > heightMeasure.until) {
    heightMeasure.active = false;
    stopHitTest();
    const s = heightMeasure.samples.sort((a, b) => a - b);
    if (s.length < 10) { flash('도로 면을 찾지 못했어요 · 도로를 비스듬히 비추며 다시 눌러 주세요', 4000); return; }
    const med = s[s.length >> 1];
    setRoadHeight(med, `도로 높이 ${med >= 0 ? '+' : ''}${med.toFixed(2)}cm (자동 · ${s.length}점)`);
    return;
  }
  if (!hitSource || !fuser.ready) return;
  const hits = frame.getHitTestResults(hitSource);
  if (!hits.length) return;
  const p = hits[0].getPose(refSpace);
  if (!p) return;
  const w = p.transform.position;
  const r = worldToRoad(fuser.result, [w.x, w.y, w.z]);
  if (inArea(workArea(0), r[0], r[1]) && Math.abs(r[2]) < 20) heightMeasure.samples.push(r[2]);
}
function setRoadHeight(h, msg) {
  cfg.roadHeight = +Math.max(-10, Math.min(20, h)).toFixed(3);
  save();
  rebuildWorld(true);
  flash(msg || `도로 높이 ${cfg.roadHeight >= 0 ? '+' : ''}${cfg.roadHeight.toFixed(2)}cm · 차가 도로에 붙어 보이면 맞아요`, 2500);
}

// ---------- 인식 표시: 지도 만들기 중 마커 상자 (카메라 영상은 화면과 같은 범위) ----------
// 화면 전체 크기 캔버스라서, 지우거나 그릴 때마다 AR 화면 위 층 전체를 다시 합성한다 → 그릴 것이 있을 때만
let dbgDrawn = false, dbgKey = null;
function drawDetections() {
  const v = mapping.active ? mapping.view : null;
  const live = !!v && v.items.length > 0 && performance.now() - v.t <= 800;
  const key = live ? v : null;
  if (key === dbgKey) return; // 새 인식 결과가 없으면 그대로
  dbgKey = key;
  const cv = $('dbg');
  if (!live) {
    if (dbgDrawn) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); dbgDrawn = false; }
    return;
  }
  const W = window.innerWidth, H = window.innerHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  dbgDrawn = true;
  const sx = W / v.w, sy = H / v.h;
  g.lineWidth = 3; g.font = '700 13px system-ui, sans-serif';
  for (const it of v.items) {
    g.strokeStyle = it.col; g.beginPath();
    it.c.forEach((p, i) => (i ? g.lineTo(p[0] * sx, p[1] * sy) : g.moveTo(p[0] * sx, p[1] * sy)));
    g.closePath(); g.stroke();
    const tw = g.measureText(it.label).width;
    g.fillStyle = 'rgba(13,17,23,.8)'; g.fillRect(it.c[0][0] * sx, it.c[0][1] * sy - 19, tw + 8, 17);
    g.fillStyle = it.col; g.fillText(it.label, it.c[0][0] * sx + 4, it.c[0][1] * sy - 6);
  }
}

// ---------- 화면 글 ----------
// 경로 기록 중 도로 평면 영상을 모은 범위(%): 디오라마 작업 범위 안 칸 중 본 칸 비율 (워커가 1초에 한 번 계산)
const scanCoverage = () => scanPercent;
let hudT = 0;
// AR 화면 위 글·모양은 바뀔 때만 고친다 (같은 글을 다시 넣어도 그 층을 다시 그림)
const shown = new Map();
function setText(id, text) { if (shown.get(id) !== text) { shown.set(id, text); $(id).textContent = text; } }
function setClass(id, cls, on) { const k = id + '.' + cls; if (shown.get(k) !== on) { shown.set(k, on); $(id).classList.toggle(cls, on); } }
function setGuide(msg, ok) {
  setText('status', msg);
  setClass('status', 'warn', !ok);
}
function flash(msg, ms = 3000) {
  setGuide(msg, true);
  flashUntil = performance.now() + ms;
}
function updateHud(t) {
  if (t - hudT < (LITE ? 300 : 200)) return;
  hudT = t;
  const now = performance.now();
  const seen = [...lastSeen.entries()].filter(([, s]) => now - s < 600).length;
  drawDetections();
  // 위치를 맞추기 전에는 [경로 기록]이 안 된다는 걸 버튼에 표시
  const recLabel = fuser.ready ? '경로 기록' : '경로 기록 (위치 맞춘 뒤)';
  if ($('btnRecord').textContent !== recLabel) { $('btnRecord').textContent = recLabel; $('btnRecord').classList.toggle('off', !fuser.ready); }
  if (gate.on) setText('debug', `${fps.toFixed(0)}fps · 인식 ${detMs.toFixed(0)}ms${detectClient.mode === 'worker' ? '' : '(화면 스레드)'} · 마커 ${seen}개 · 맞춤 ${fuser.count}${reader && reader.flipLocked ? '' : ' · 영상 방향 확인 중'} · 가림 ${({ on: occlusion.size ? `켬(깊이 ${occlusion.size.join('×')})` : '켬', off: '끔', unsupported: '깊이 인식 미지원', waiting: '깊이 기다리는 중' })[occlusion.status]}${perf.text()}`);
  // 인식 · 판단 · 제어 카드 (관람객도 읽을 수 있는 말로, 관리자는 자세한 값 덧붙임)
  const st = controller.state === 'drive' ? '달리는 중' : controller.state === 'brake' ? '속도를 줄이는 중' : '멈춤';
  const onPath = barricade && blocksPath(P, barricade, clearance());
  setText('hudSense', (barricadeSeenNow ? `바리케이드를 찾았어요${gate.on ? `(${barricadeSeenNow})` : ''}` : barricade ? '바리케이드를 기억하고 있어요' : '길 위에 장애물이 없어요') +
    (gate.on ? ` · 도로 마커 ${seen}개` : ''));
  setText('hudJudge', !barricade ? '가는 길이 비어 있어요' : !onPath ? '바리케이드가 있지만 길 밖이에요'
    : controller.gap !== null ? `길을 막고 있어요 · 앞 ${controller.gap.toFixed(1)}cm` : '길 위에 있지만 아직 멀어요');
  setText('hudControl', `${st} · ${controller.v.toFixed(1)}cm/s`);
  // 속도 막대: 폭(width) 대신 transform으로 (배치 다시 계산 없이 합성만)
  const sp = (Math.min(100, (controller.v / controller.o.cruise) * 100) / 100).toFixed(2);
  if (shown.get('speedBar') !== sp) { shown.set('speedBar', sp); $('speedBar').style.transform = `scaleX(${sp})`; }
  if (shown.get('speedBar.cls') !== controller.state) { shown.set('speedBar.cls', controller.state); $('speedBar').className = controller.state; }
  setClass('cardSense', 'hot', !!barricadeSeenNow);
  setClass('cardJudge', 'hot', !!onPath);
  setClass('cardControl', 'hot', controller.state === 'brake');
  setClass('cardControl', 'stop', controller.state === 'stop');
  if (now < flashUntil) return;
  let msg, ok = false;
  if (!gate.on) {
    // 관람객 안내
    if (trackingPoor) msg = '태블릿을 천천히 움직여 주세요';
    else if (!fuser.ready) msg = '디오라마 가장자리의 검은 사각형 표식을 화면에 비춰 주세요';
    else if (cfg.pathStale) msg = '아직 준비 중이에요 · 직원에게 알려 주세요';
    else if (barricade && controller.state === 'stop') { msg = '바리케이드 앞에서 멈췄어요 · 치우면 다시 출발해요'; ok = true; }
    else if (barricade && controller.state === 'brake') { msg = '바리케이드를 알아보고 속도를 줄이고 있어요'; ok = true; }
    else { msg = '자율주행차가 달리고 있어요 · 도로에 바리케이드를 세워 보세요'; ok = true; }
  } else if (mapping.setup) {
    const st = mapping.mapper.status(), L = mapping.loop;
    msg = !mapping.A0 ? '테두리의 마커가 화면에 들어오게 비추며 걷기 시작하세요 (첫 마커가 등록되면 도로 영상을 모아요)'
      : `마커 ${st.confirmed.length}개 등록${st.pending.length ? ` (확인 중 ${st.pending.length})` : ''} · ` +
        (!L ? '도로를 비추며 천천히 한 바퀴 돌아 주세요'
          : L.ok ? `한 바퀴 찾음 ${(L.length / 100).toFixed(1)}m(초록) · 다 돌았으면 [완료·저장]`
            : L.pts ? `중앙선 ${Math.round((L.refined || 0) * 100)}% 확인 · 주황 부분 도로를 더 비춰 주세요` : '중앙선 찾는 중 · 계속 돌아 주세요');
    ok = !!(L && L.ok);
  } else if (mapping.active) {
    const st = mapping.mapper.status();
    msg = st.refId === null ? '테두리의 마커를 하나씩 1~2초씩 비춰 주세요 (같이 보일 필요 없어요)'
      : `등록 ${st.confirmed.length}개 (${st.confirmed.join(', ')})${st.pending.length ? ` · 확인 중 ${st.pending.map((q) => q.id).join(', ')}` : ''} · 다 비췄으면 [완료·저장]`;
    setText('mapStat', msg);
    ok = st.confirmed.length > 0;
  } else if (heightMeasure.active) msg = `도로 면을 찾는 중… 도로 위를 비스듬히 비춰 주세요 (${heightMeasure.samples.length}점)`;
  else if (trackingPoor) msg = '카메라 추적이 불안정해요 · 천천히 움직이며 바닥을 비춰 주세요';
  else if (!fuser.ready) msg = `디오라마 테두리의 도로 마커를 비춰 주세요 · 위치 맞추는 중 ${fuser.count}/${fuser.minCount}`;
  else if (recording.active) {
    const cardNow = performance.now() - card.seen < 500;
    const nOk = recording.pts.filter((p) => tapState.get(p) === 'ok').length;
    msg = recording.snapped ? '찾은 경로(초록) · 괜찮으면 [완료·저장]'
      : cardNow ? `경로 카드 보임 · 1초 그대로 두면 점이 찍혀요 · 점 ${recording.pts.length}개`
        : `${aimOn ? '조준점(+)을 흰 중앙선에 맞추고 화면을 톡' : '흰 중앙선 위를 톡'} · 직선 30~50cm, 곡선 10~15cm마다 · 점 ${recording.pts.length}개(중앙선에 붙음 ${nOk}) · 한 바퀴 돌면 [중앙선 맞추기]`;
    ok = true;
  }
  else if (cfg.pathStale) msg = '경로가 없어요 · [경로 기록]으로 만들어 주세요';
  else { msg = seen ? '위치 맞춤 완료 · 마커를 볼 때마다 더 정확해져요' : '위치 맞춤 완료 · 마커가 안 보여도 계속 달려요'; ok = true; }
  setGuide(msg, ok);
}

// ---------- 버튼 ----------
// 관람객: [시작하기] → 도안 스캔 → 미리보기 → [이 차로 달리기]. (시험은 window.__raimSkipScan이면 바로 AR)
carFlow = createCarFlow({ getAR: () => AR, onRun: () => startAR(), onBack: () => {} });
$('btnStart').onclick = () => (window.__raimSkipScan ? startAR() : carFlow.open());
$('btnExit').onclick = () => { if (session) session.end(); };
$('btnClear').onclick = () => { barTracker.clear(); barricade = null; flash('바리케이드를 해제했어요', 1500); };
$('btnRealign').onclick = () => { fuser.reset(); roadTracker.reset(); flash('위치를 다시 맞춰요 · 도로 마커를 비춰 주세요'); };
// 관람객: 위치 다시 맞추기 (기억 중인 바리케이드도 지움)
$('btnRealignV').onclick = () => { fuser.reset(); roadTracker.reset(); barTracker.clear(); barricade = null; flash('위치를 다시 맞춰요 · 검은 사각형 표식을 비춰 주세요', 2500); };

// ---------- 관람 모드 / 관리자 모드 ----------
// 관람객: 시작 → AR → 정해진 경로로 차가 달리는 걸 봄. 설정(⚙) → 암호 → 관리자 모드(지도·경로·차 크기·속도·높이 조정)
const gate = createAdminGate({
  rootFor: () => (session ? $('ui') : document.body),
  isBusy: () => recording.active || mapping.active,
  onChange: (on) => {
    if (!on) { // 관람 모드로: 하던 관리 작업은 취소
      if (recording.active) setRecording(false);
      if (mapping.setup) { setSetup(false); fuser.reset(); roadTracker.reset(); rebuildWorld(true); } else if (mapping.active) setMapping(false);
    }
    $('versionTag').textContent = `${on ? '관리자 모드' : '관람 모드'} · ${__BUILD_DATE__} 업데이트`;
    flashUntil = 0;
    drawDetections();
    describeMap();
  },
});
const gear = () => (gate.on ? gate.exit() : gate.open());
$('btnGear').onclick = gear;
$('btnGearAR').onclick = gear;
$('btnLeaveAdmin').onclick = () => gate.exit();
$('btnLeaveAdminAR').onclick = () => gate.exit();
$('versionTag').textContent = `관람 모드 · ${__BUILD_DATE__} 업데이트`;
// ---------- AR 지도 만들기 ----------
function setMapping(on) {
  if (mapping.setup) setSetup(false);
  mapping.active = on; mapping.setup = false;
  mapping.view = null;
  if (on) {
    const size = parseFloat($('arMapSize').value) || 8;
    mapping.mapper = new XRMarkerMapper({ size, excludeIds: [...cfg.barricade.markerIds, cfg.pathCard.id] });
  }
  $('mapBar').hidden = !on;
  $('mainButtons').hidden = on;
  $('hud').hidden = on;
  drawDetections();
}
function finishMapping() {
  const mp = mapping.mapper;
  const st = mp.status();
  if (st.confirmed.length < 2) { flash('마커가 2개 이상 등록돼야 해요 · 다른 마커도 비춰 주세요', 4000); return; }
  const res = mp.solve();
  scaleCarFromSheet(mp.size);
  cfg.roadMarkers = res.markers;
  cfg.pathStale = true; // 좌표가 바뀌었으니 이전 경로는 쓸 수 없음
  save();
  lastMapResult = res;
  setMapping(false);
  rebuildWorld(false);
  roadTracker.reset();
  fuser.seed(res.align); // 지도를 만든 그 위치로 바로 맞춘 상태
  setRecording(true);
  const q = res.estErrCm < 0.5 ? '정확도 좋음' : res.estErrCm < 1.2 ? '정확도 보통' : '정확도 낮음 · 다시 만드는 걸 권해요';
  flash(`마커 ${res.markers.length}개 지도 저장 · ${q} · 초록 사각형이 실제 마커에 겹치는지 둘러본 뒤, 도로를 비추고 두 번 탭 → [자동 경로]`, 8000);
}
let lastMapResult = null;
// A4 시트에서 디오라마로 처음 넘어갈 때만 차 크기·속도를 마커 크기 비율로 (마커 버전과 같은 규칙)
function scaleCarFromSheet(size) {
  const r = size / (cfg.roadMarkers[0] ? cfg.roadMarkers[0].size : size);
  if (!isSheetMap(cfg.roadMarkers) || Math.abs(r - 1) <= 0.01) return;
  for (const k of ['length', 'width', 'height']) cfg.car[k] = +(cfg.car[k] * r).toFixed(2);
  for (const k of ['cruise', 'brakeDist', 'stopGap', 'accel', 'decel', 'margin']) cfg.drive[k] = +(cfg.drive[k] * r).toFixed(2);
}

// ---------- 한 바퀴 설치: 마커 지도 + 중앙선 경로를 한 번 걷기로 ----------
// 걷는 동안 화면에 들어온 마커를 저절로 등록(AR 지도 만들기와 같음)하고, 처음 마커가 등록되면 그 마커로 수평 도로 좌표계(A0)를 정해
// 도로 영상을 모은다. 3초마다 워커에서 흰 중앙선 고리를 찾아 초록(찾음)·주황(덜 찾음) 선으로 보여 준다.
const setupGroup = new THREE.Group();
roadLayer.add(setupGroup);
function setSetup(on) {
  setRecording(false);
  mapping.active = on; mapping.setup = on;
  mapping.view = null; mapping.A0 = null; mapping.loop = null; mapping.finding = false; mapping.lastFind = -1e9;
  if (on) {
    const size = parseFloat($('setupSize').value) || 8;
    // 걸으며 지나가는 동안만 보이니 4번 보면 등록 (멈춰 비추는 [지도 만들기]는 6번)
    mapping.mapper = new XRMarkerMapper({ size, minSamples: 4, excludeIds: [...cfg.barricade.markerIds, cfg.pathCard.id] });
    fuser.reset(); // 기존 지도 위치는 쓰지 않음 (새 좌표계는 처음 등록된 마커로)
  }
  clearGroup(setupGroup);
  $('setupBar').hidden = !on;
  $('mainButtons').hidden = on;
  $('hud').hidden = on;
  drawDetections();
}
function startSetupMosaic() {
  const mp = mapping.mapper;
  mapping.A0 = mp.solve().align;
  fuser.seed(mapping.A0); // 설치 중에도 찾은 고리·마커를 제자리에 그리기 위해
  const c = mp.size / 20;
  detectClient.resetMosaic({ bounds: { x0: -100, y0: -100, x1: 100, y1: 100 }, cell: c, grow: true });
  mosaicKey = null; // 끝나면 지도에 맞는 도로 영상으로 다시 시작
}
const roadWidthIn = () => parseFloat($('setupRoad').value) || cfg.lane.roadWidth || 24;
async function findSetupLoop() {
  mapping.finding = true;
  const res = await detectClient.findLoop({ roadWidth: roadWidthIn() });
  mapping.finding = false; mapping.lastFind = performance.now();
  if (!mapping.setup) return res;
  mapping.loop = res;
  refreshSetupVis();
  return res;
}
function refreshSetupVis() {
  clearGroup(setupGroup);
  const res = mapping.loop;
  if (res && res.pts && res.pts.length > 2) {
    // 중앙선을 확인한 곳은 초록(다 찾았으면) / 하늘색(아직), 이어 채운 곳은 주황 → 주황 쪽을 더 비추면 됨
    setupGroup.add(coloredLoop(res.pts, res.weak, res.ok ? 0x3ddc84 : 0x38d9ff, 0.2));
  }
  // 등록된 마커 자리 (실제 마커와 겹치면 좌표가 맞은 것)
  const st = mapping.mapper.status();
  if (st.confirmed.length && mapping.A0) {
    for (const m of mapping.mapper.solve({ align: mapping.A0 }).markers) {
      const cs = markerCorners(m).map(([x, y]) => new THREE.Vector3(x, y, 0.1 - roadH()));
      setupGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(cs), new THREE.LineBasicMaterial({ color: 0x38d9ff })));
    }
  }
}
async function finishSetup() {
  const mp = mapping.mapper;
  if (!mapping.A0 || mp.status().confirmed.length < 2) { flash('마커가 2개 이상 등록돼야 해요 · 테두리의 다른 마커도 화면에 들어오게 걸어 주세요', 5000); return; }
  if (mapping.finding) { flash('중앙선을 계산하는 중이에요 · 잠시 뒤 다시 눌러 주세요', 2000); return; }
  flash('중앙선 한 바퀴를 계산하는 중…', 3000);
  const res = await findSetupLoop();
  if (!res || !res.ok) {
    flash(!res || !res.pts ? '흰 중앙선을 못 찾았어요 · 도로를 더 가까이·천천히 비추며 한 바퀴 돌아 주세요'
      : `중앙선을 ${Math.round((res.refined || 0) * 100)}%만 확인했어요 · 주황 부분 도로를 더 비춘 뒤 다시 눌러 주세요`, 6000);
    return;
  }
  const map = mp.solve({ align: mapping.A0 });
  const A0 = mapping.A0;
  scaleCarFromSheet(mp.size);
  cfg.roadMarkers = map.markers;
  cfg.path = res.pts;
  cfg.pathStale = false;
  cfg.lane.roadWidth = roadWidthIn();
  save();
  lastMapResult = { ...map, loop: { length: res.length, found: res.found, refined: res.refined } };
  setSetup(false);
  rebuildWorld(false);
  roadTracker.reset();
  fuser.seed(A0);
  flash(`설치 완료 · 마커 ${map.markers.length}개 · 경로 ${(res.length / 100).toFixed(2)}m · 다른 태블릿과 쓰려면 [끝내기] → 시작 화면의 [전시 설정 내보내기]`, 9000);
}
$('btnSetup').onclick = () => setSetup(true);
$('setupReset').onclick = () => setSetup(true);
$('setupCancel').onclick = () => {
  setSetup(false);
  fuser.reset(); roadTracker.reset(); // 설치 중 좌표계(A0)는 버리고 이전 지도로 다시 맞춤
  rebuildWorld(true);
  flash('설치를 취소했어요 · 도로 마커를 비추면 이전 지도로 위치를 맞춰요', 4000);
};
$('setupDone').onclick = finishSetup;
$('btnMapAR').onclick = () => setMapping(true);
$('mapReset').onclick = () => setMapping(true);
$('mapCancel').onclick = () => setMapping(false);
$('mapDone').onclick = finishMapping;

$('btnRecord').onclick = () => {
  if (!fuser.ready) { flash('경로 기록은 위치를 맞춘 뒤에 돼요 · 디오라마 테두리의 도로 마커를 1~2개 비춰 "위치 맞춤 완료"가 뜨면 다시 눌러 주세요', 6000); return; }
  setRecording(true);
};
// 숨은 오류가 있으면 화면에 보이게 (현장에서 원인 찾기용)
window.addEventListener('error', (e) => flash(`오류: ${e.message || e}`, 10000));
window.addEventListener('unhandledrejection', (e) => flash(`오류: ${(e.reason && e.reason.message) || e.reason}`, 10000));
$('recUndo').onclick = () => { if (recording.snapped) { recording.snapped = null; recording.snapWeak = null; } else recording.pts.pop(); refreshRecordVis(); };
$('recAim').onclick = () => setAim(!aimOn);
$('recCancel').onclick = () => setRecording(false);
$('recSnap').onclick = snapRecording;
$('recAuto').onclick = autoPath;
// 경로 기록 중: 탭 없이 흰 중앙선 한 바퀴 찾기 (비춘 도로 영상으로)
$('recLoop').onclick = async () => {
  if (laneBusy) return;
  laneBusy = true;
  try {
    flash('중앙선 한 바퀴를 찾는 중…', 3000);
    const res = await detectClient.findLoop({ roadWidth: cfg.lane.roadWidth || 24 });
    if (!recording.active) return;
    lastSnap = res;
    if (res && res.ok) { recording.snapped = res.pts; refreshRecordVis(); flash(`한 바퀴 찾았어요 · ${(res.length / 100).toFixed(2)}m · 괜찮으면 [완료·저장]`, 5000); }
    else flash(res && res.pts ? `중앙선을 ${Math.round((res.found || 0) * 100)}%만 찾았어요 · 도로를 한 바퀴 더 비춘 뒤 다시 눌러 주세요` : '흰 중앙선을 못 찾았어요 · 도로를 더 가까이 비춰 주세요', 5000);
  } finally { laneBusy = false; }
};
$('recCard').onclick = () => {
  const m = cardMean(500);
  if (!m) { flash(`경로 카드(마커 ${cfg.pathCard.id})가 안 보여요 · 차선 가운데에 놓고 비춰 주세요`, 3000); return; }
  addCardPoint(m);
};
$('recDone').onclick = () => {
  if (!recording.snapped && recording.pts.length < 4) { flash('[자동 경로]로 한 바퀴를 찾거나, 점을 4개 이상 찍어 주세요'); return; }
  cfg.path = (recording.snapped || recording.pts).slice();
  cfg.pathStale = false;
  save();
  setRecording(false);
  rebuildWorld(false);
};
$('btnPath').onclick = () => { showPath = !showPath; $('btnPath').classList.toggle('off', !showPath); };
$('btnMarkers').onclick = () => { showMarkers = !showMarkers; $('btnMarkers').classList.toggle('off', !showMarkers); drawDetections(); };
function setCarScale(k) { cfg.car.scale = +Math.max(0.5, Math.min(5, k)).toFixed(2); save(); rebuildWorld(true); flash(`자동차 크기 ×${cfg.car.scale.toFixed(2)}`, 1500); }
$('carBigger').onclick = () => setCarScale((cfg.car.scale || 1) * 1.25);
$('carSmaller').onclick = () => setCarScale((cfg.car.scale || 1) / 1.25);
function setSpeedScale(k) {
  cfg.drive.speedScale = +Math.max(0.25, Math.min(5, k)).toFixed(2); save();
  controller.o = driveOpts();
  flash(`자동차 속도 ×${cfg.drive.speedScale.toFixed(2)} · ${controller.o.cruise.toFixed(1)}cm/s`, 1500);
}
$('speedUp').onclick = () => setSpeedScale((cfg.drive.speedScale || 1) * 1.25);
$('speedDown').onclick = () => setSpeedScale((cfg.drive.speedScale || 1) / 1.25);
$('heightUp').onclick = () => setRoadHeight(roadH() + markerSize() / 40);
$('heightDown').onclick = () => setRoadHeight(roadH() - markerSize() / 40);
// 가림 처리 켜기·끄기 (이 기기에 저장), 깊이 보기 (현장 확인용: 가까울수록 빨강, 멀수록 파랑)
function showOcclusionButton() {
  const on = cfg.occlusion.enabled !== false;
  $('btnOcclusion').textContent = on ? '가림 켬' : '가림 끔';
  $('btnOcclusion').classList.toggle('off', !on);
}
function setOcclusion(on) { cfg.occlusion.enabled = on; save(); showOcclusionButton(); }
$('btnOcclusion').onclick = () => {
  setOcclusion(cfg.occlusion.enabled === false);
  flash(cfg.occlusion.enabled === false ? '가림 처리를 껐어요' : session && !depth.requested ? '가림 처리를 켰어요 · AR을 껐다 다시 시작하면 적용돼요' : depth.supported ? '가림 처리를 켰어요 · 건물 뒤로 가면 차가 가려져요' : '가림 처리를 켰어요 · 다만 이 기기는 깊이 인식을 지원하지 않아요', 3000);
};
$('btnDepthView').onclick = () => { showDepth = !showDepth; occlusion.setShowDepth(showDepth); $('btnDepthView').classList.toggle('off', !showDepth); };
$('btnDepthView').classList.add('off');
// 바닥 찾기(hit-test)는 잴 때만 켜고 끝나면 끈다
async function startHitTest() {
  if (hitSource) return true;
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
  } catch (e) { hitSource = null; }
  return !!hitSource;
}
function stopHitTest() {
  if (hitSource) { try { hitSource.cancel(); } catch (e) { /* 무시 */ } }
  hitSource = null;
}
$('btnHeightAuto').onclick = async () => {
  if (!fuser.ready) { flash('먼저 마커로 위치를 맞춰 주세요'); return; }
  if (!session || heightMeasure.active) return;
  if (!(await startHitTest())) { flash('이 기기는 바닥 인식(hit-test)이 안 돼요 · 높이 −/+로 맞춰 주세요', 4000); return; }
  heightMeasure.active = true; heightMeasure.samples = []; heightMeasure.until = lastT + 3000;
};
setupMenuToggle('raim-ar-xr-menu-collapsed');
window.addEventListener('resize', () => { if (!session) renderer.setSize(window.innerWidth, window.innerHeight, false); });

rebuildWorld(false);
checkSupport();
// 사이트에 전시 설정(diorama.json)이 있고 새것이면 불러온다
async function applySharedConfig(force) {
  const r = await loadShared(cfg, { force });
  if (r.status === 'applied') {
    cfg = r.cfg;
    fuser.reset(); roadTracker.reset();
    rebuildWorld(false);
    describeMap();
    $('sharedMsg').textContent = `전시 설정(${sharedLabel(r.shared)} 저장)을 불러왔어요`;
  } else if (force) {
    $('sharedMsg').textContent = r.status === 'bad' ? '사이트의 diorama.json 내용이 올바르지 않아요.' : '사이트에 올라간 전시 설정(diorama.json)이 아직 없어요.';
  }
}
applySharedConfig(false);
$('btnExport').onclick = () => { downloadShared(cfg); $('sharedMsg').textContent = 'diorama.json을 받았어요. 이 파일을 사이트에 올리면 모든 기기가 같은 지도·경로를 써요.'; };
$('btnShared').onclick = () => applySharedConfig(true);

// 시험용
window.__raimAR = {
  setCarS: (v) => { controller.s = v; controller.v = 0; }, // 차를 경로 위 한 자리로 (가림 시험)
  pathLength: () => P.length,
  detections: () => detCount,
  injectFrameError: () => { injectError = true; }, // 시험: 다음 프레임에서 오류
  carFlow: () => carFlow,
  carVehicle: () => (carObj && carObj.userData.vehicle) || null,
  peek: () => ({ open: carObj.userData.open, dist: lastPeekDist, ...peekRange() }),
  setPeekRange: (near, far) => { cfg.car.peekNear = near; cfg.car.peekFar = far; }, // 시험: 지붕 열리는 거리(m), 저장 안 함
  carMaterials: () => { const a = []; carObj.traverse((o) => { if (o.isMesh) a.push(o.material.type); }); return a; },
  get state() {
    return { roadMarkers: cfg.roadMarkers, path: cfg.path, ready: fuser.ready, count: fuser.count, align: fuser.result, s: controller.s, v: controller.v,
      carState: controller.state, gap: controller.gap, barricade, barricadeSeenNow, recPts: recording.pts, snapped: recording.snapped, lastSnap, partial: recording.partial, scan: scanCoverage(),
      mapping: mapping.active ? mapping.mapper.status() : null,
      setup: mapping.setup ? { A0: mapping.A0, loop: mapping.loop && { ok: mapping.loop.ok, found: mapping.loop.found, refined: mapping.loop.refined, length: mapping.loop.length } } : null, lastMapResult, card: cardMean(1000), cardHist: card.hist.length, roadHeight: roadH(),
      detectMode: detectClient.mode, detMs, perf: perf.last, lite: LITE, liteDepth, frameErrors, depthRequested: depth.requested, antialias: !LITE, fbScale: FB_SCALE, hitTest: !!hitSource, camPixels: reader ? reader.w * reader.h : 0, admin: gate.on, occlusion: cfg.occlusion.enabled !== false, occlusionStatus: occlusion.status, aimOn, recFlags: recording.pts.map((p) => tapState.get(p) || null), snapWeak: recording.snapWeak, gpu: { ...renderer.info.memory } };
  },
};
