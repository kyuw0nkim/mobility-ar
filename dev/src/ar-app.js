// RAIM AR 자율주행 — AR(WebXR·ARCore) 버전
// 1단계: ARCore가 카메라 움직임을 추적하고, 카메라 영상의 마커로 디오라마 위치를 한 번 맞춘다.
//        맞춘 뒤에는 마커가 화면에 없어도 자동차가 계속 달린다.
// 2단계: 바리케이드 마커(10·11)를 같은 영상에서 찾아, 경로를 막으면 감속·정지하고 치우면 다시 출발한다.
// (건물 가림은 3단계)
import * as THREE from 'three';
import { markerCorners, transformPoint, project } from './geometry.js';
import { RoadPoseTracker, solveBarricade, solveFlatMarker, toFullRes } from './tracking.js';
import { clusterToRoad, panelSizeRatio } from './barricade-color.js';
import { RoadMosaic, snapPathToLane, traceLane } from './lane.js';
import {
  smoothPath, buildPath, carPoseAt, CarController, BarricadeTracker, blocksPath,
} from './logic.js';
import { loadConfig, storeConfig, loadShared, downloadShared, sharedLabel } from './store.js';
import { makeCar, makeBarricadeVis, disposeObject, clearGroup } from './scene.js';
import { isSheetMap } from './config.js';
import {
  intrinsicsFromProjection, worldFromCv, levelEstimate, AlignmentFuser, roadToWorldMatrix, roadToCv, rayToRoad, worldToRoad,
} from './xr-align.js';
import { XRCameraReader } from './xr-camera.js';
import { XRMarkerMapper } from './xr-mapper.js';
import { DetectClient } from './detect-client.js';
import {
  roadHeight, markerSizeOf, carDimsOf, driveOptsOf, clearanceOf, liftPose, laneSnapOpts, laneSnapMessage, setupMenuToggle,
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
const renderer = new THREE.WebGLRenderer({ canvas: $('three'), alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
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

// keepProgress: 차 크기·도로 높이만 바뀐 경우(같은 지도·경로). 차 위치와 추적 중인 바리케이드를 그대로 둔다
// (바리케이드를 잊으면, 화면 밖에서 '기억 중'이던 바리케이드를 차가 그냥 지나감)
function rebuildWorld(keepProgress = true) {
  const frac = controller && P ? controller.s / P.length : 0;
  P = buildPath(smoothPath(cfg.path, true, 0.5, cfg.car.length * 0.3), true);
  controller = new CarController(driveOpts());
  if (keepProgress) controller.s = frac * P.length;
  disposeObject(carObj);
  carObj = makeCar(carDims());
  roadLayer.add(carObj);
  disposeObject(pathLine);
  pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P.pts.map((p) => new THREE.Vector3(p[0], p[1], 0.05))),
    new THREE.LineBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.8 }));
  roadLayer.add(pathLine);
  roadLayer.position.z = roadH();
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
let lastT = null, lastDet = -Infinity, detMs = 0, fps = 0;
// 영상 인식은 한 번에 한 프레임씩: GPU에서 읽기(gpu) → 워커에서 인식(detect) → 결과 반영. 그동안 화면은 계속 그린다
const detectClient = new DetectClient();
let inflight = null; // 인식 중인 프레임 {stage, gen, t, now, wc, proj}
let gen = 0; // AR 세션 번호 (끝난 세션의 늦은 결과는 버림)
let lastSeen = new Map(); // 마커 id → 마지막으로 본 시각
let showPath = true, showMarkers = true;
let lastYellow = null; // 인식 표시용: 마지막 영상의 노란 후보와 판정
// AR 지도 만들기 (setup: 한 바퀴 설치 — 지도 만들기 + 중앙선 찾기를 같이)
const mapping = { active: false, setup: false, mapper: null, view: null, A0: null, loop: null, finding: false, lastFind: -1e9 };
let trackingPoor = false;
const recording = { active: false, pts: [], snapped: null };
const heightMeasure = { active: false, until: 0, samples: [] };
let flashUntil = 0;
let lastSnap = null;

// ---------- 시작 화면 ----------
function describeMap() {
  const n = cfg.roadMarkers.length;
  const isSheet = isSheetMap(cfg.roadMarkers);
  $('mapInfo').innerHTML = `마커 지도: <b>${n}개</b> · 마커 크기 ${markerSize()}cm${isSheet ? ' (A4 테스트 시트 기본값)' : ''}<br>` +
    `경로: ${cfg.pathStale ? '<b>없음</b> · AR 안에서 [경로 기록]으로 만들어요' : `점 ${cfg.path.length}개`} · 도로 높이 ${roadH().toFixed(2)}cm` +
    (isSheet ? '<br><span style="color:var(--amber)">디오라마에서 쓰려면 AR을 시작한 뒤 [지도 만들기]를 먼저 해 주세요.</span>' : '');
}
async function checkSupport() {
  describeMap();
  if (!AR) { $('startMsg').textContent = '마커 인식 라이브러리를 불러오지 못했어요.'; return; }
  if (!window.isSecureContext) { $('startMsg').textContent = 'https 주소로 열어야 AR을 쓸 수 있어요.'; return; }
  let ok = false;
  try { ok = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { /* 아래 */ }
  if (!ok) {
    $('startMsg').innerHTML = '이 기기·브라우저는 AR(WebXR)을 지원하지 않아요.<br>갤럭시 기기의 Chrome에서 열거나, <a href="index.html">마커 버전</a>을 쓰세요.';
    return;
  }
  $('startMsg').textContent = '';
  $('btnStart').disabled = false;
}

async function startAR() {
  $('btnStart').disabled = true;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['camera-access', 'hit-test', 'dom-overlay', 'anchors'],
      domOverlay: { root: $('ui') },
    });
  } catch (e) {
    $('startMsg').textContent = 'AR을 시작하지 못했어요: ' + (e.message || e);
    $('btnStart').disabled = false;
    return;
  }
  const f = session.enabledFeatures || [];
  if (f.length && !f.includes('camera-access')) {
    session.end();
    $('startMsg').textContent = '이 기기는 AR 중 카메라 영상 접근(camera-access)이 안 돼서 마커로 위치를 맞출 수 없어요.';
    return;
  }
  session.addEventListener('end', onEnd);
  session.addEventListener('select', onSelect);
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  // three.js는 'layers' 기능이 있을 때만 binding을 만들어서 안드로이드에서는 직접 만든다
  try { binding = renderer.xr.getBinding() || new XRWebGLBinding(session, renderer.getContext()); } catch (e) { binding = null; flash('카메라 영상 연결 실패: ' + e.message, 8000); }
  try { reader = new XRCameraReader(renderer.getContext()); } catch (e) { flash('카메라 영상 준비 실패: ' + e.message, 8000); }
  renderer.resetState();
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
  } catch (e) { hitSource = null; }
  gen++; inflight = null;
  fuser.reset(); roadTracker.reset();
  diorama.visible = false;
  lastT = null;
  $('start').hidden = true;
  $('ui').hidden = false;
  if (cfg.pathStale) flash('경로가 없어요 · 위치가 맞으면 [경로 기록]으로 만들어 주세요', 5000);
  renderer.setAnimationLoop(onXRFrame);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  if (reader) reader.cancel();
  gen++; inflight = null;
  session = null; hitSource = null; binding = null; reader = null;
  setRecording(false);
  $('ui').hidden = true;
  $('start').hidden = false;
  $('btnStart').disabled = false;
  describeMap();
}

// ---------- 프레임 ----------
function onXRFrame(t, frame) {
  if (!frame || !session) return; // AR이 끝난 직후 한 번 더 불릴 수 있음
  const dt = lastT === null ? 0 : Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (dt > 0) fps = fps * 0.9 + 0.1 / dt;
  const pose = frame.getViewerPose(refSpace);
  if (pose) {
    trackingPoor = !!pose.emulatedPosition;
    const view = pose.views[0];
    const rate = 6; // 초당 인식 횟수 (위치 맞춤 + 바리케이드)
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
  carObj.userData.brakeMat.color.set(controller.state === 'drive' ? 0x551111 : 0xff2222);
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
  pathLine.visible = !cfg.pathStale && (showPath || recording.active) && !mapping.active;
  markerLayer.visible = showMarkers && !mapping.active;
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
  renderer.render(scene, camera);
  updateHud(t);
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
  const wantYellow = !mapping.active && fuser.ready && cfg.barricade.color !== false;
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
  detectClient.run(img, { yellow: wantYellow, acc }).then((res) => {
    if (inflight === job) inflight = null;
    if (!res) return;
    const r = reader;
    try {
      if (job.gen !== gen || !session || !r) return;
      if (res.error) flash(`인식 오류: ${res.error}`, 5000);
      if (res.coverage !== null && res.coverage !== undefined) scanPercent = res.coverage;
      detMs = detMs * 0.8 + res.ms * 0.2;
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
  let obs = solveBarricade(markers, cfg.barricade, K, camPose);
  let src = obs ? '마커' : null;
  // 마커가 안 보이면 노랑·검정 줄무늬 색으로 찾기 (노란 조각 2개 이상인 덩어리 → 패널 높이 면에 투영)
  if (!obs && cfg.barricade.color !== false) {
    const zPanel = roadH() + (cfg.barricade.colorHeight ?? cfg.barricade.height * 0.65);
    const area = workArea();
    const panelH = cfg.barricade.colorPanelHeight ?? cfg.barricade.height * 0.35;
    // 노란 덩어리마다 판정하고 이유를 남긴다 (인식 표시 화면용)
    const items = [];
    for (const c of res.yellow || []) {
      const it = { bbox: c.bbox, verdict: '', ok: false, single: c.single };
      items.push(it);
      if (c.single) { it.verdict = '줄무늬 아님(노란 조각 1개)'; continue; }
      const r = clusterToRoad(c, K, camPose, zPanel);
      if (!r || !inArea(area, r.x, r.y)) { it.verdict = r ? `디오라마 밖 (${r.x.toFixed(0)}, ${r.y.toFixed(0)})cm` : '디오라마 밖'; continue; }
      const ratio = panelSizeRatio(c, r, K, camPose, zPanel, panelH);
      if (ratio === null || ratio < 0.25 || ratio > 4) { it.verdict = `크기 안 맞음 ×${ratio === null ? '?' : ratio.toFixed(1)}`; continue; }
      if (obs) { it.verdict = '다른 후보 사용 중'; continue; }
      obs = { x: r.x, y: r.y, dx: r.dx, dy: r.dy };
      src = '색';
      it.ok = true; it.verdict = `바리케이드 (크기 ×${ratio.toFixed(1)})`;
    }
    lastYellow = { w: img.width, h: img.height, items, t: performance.now() };
  }
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
function onSelect(e) {
  if (!recording.active || !fuser.ready) return;
  const p = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
  if (!p) return;
  const m = p.transform.matrix;
  const o = [m[12], m[13], m[14]];
  const d = [-m[8], -m[9], -m[10]];
  const L = Math.hypot(...d);
  const q = rayToRoad(fuser.result, o, d.map((v) => v / L), roadH());
  if (!q) return;
  recording.pts.push([+q[0].toFixed(2), +q[1].toFixed(2)]);
  recording.snapped = null; recording.partial = null; recording.stopAt = null;
  refreshRecordVis();
}
// 버튼을 누를 때는 AR 탭(select)이 생기지 않게
$('ui').addEventListener('beforexrselect', (e) => { if (e.target.closest('button')) e.preventDefault(); });

function refreshRecordVis() {
  clearGroup(recordGroup);
  const s = cfg.car.width / 1.8;
  const geo = new THREE.SphereGeometry(0.35 * s, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff00aa });
  for (const p of recording.pts) {
    const b = new THREE.Mesh(geo, mat);
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
    const sp = smoothPath(recording.snapped, true, 0.5);
    recordGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...sp, sp[0]].map((p) => new THREE.Vector3(p[0], p[1], 0.15))),
      new THREE.LineBasicMaterial({ color: 0x3ddc84 })));
  }
}
function setRecording(on) {
  recording.active = on;
  recording.pts = [];
  recording.snapped = null;
  recording.partial = null; recording.stopAt = null;
  refreshRecordVis();
  $('recordBar').hidden = !on;
  $('mainButtons').hidden = on;
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
  withMosaic((mosaic) => snapWith(mosaic));
}
function snapWith(mosaic) {
  if (!recording.active || recording.pts.length < 4) return;
  const res = snapPathToLane(mosaic, recording.pts, laneSnapOpts(cfg, mosaic));
  lastSnap = res;
  flash(laneSnapMessage(res), 4000);
  if (!res.ok) return;
  recording.snapped = res.pts;
  refreshRecordVis();
}

// ---------- 도로 높이 자동 측정: ARCore가 찾은 바닥(도로 면)의 높이 ----------
function measureHeight(frame, t) {
  if (t > heightMeasure.until) {
    heightMeasure.active = false;
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

// ---------- 인식 표시: 노란 후보 상자 (카메라 영상은 화면과 같은 범위) ----------
function drawDetections() {
  const cv = $('dbg');
  const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (mapping.active) {
    const v = mapping.view;
    if (!v || performance.now() - v.t > 800) return;
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
    return;
  }
  if (!showMarkers || !lastYellow || performance.now() - lastYellow.t > 1000) return;
  const sx = W / lastYellow.w, sy = H / lastYellow.h;
  g.lineWidth = 2;
  g.font = '600 12px system-ui, sans-serif';
  for (const it of lastYellow.items) {
    const [x0, y0, x1, y1] = it.bbox;
    const col = it.ok ? '#3ddc84' : it.verdict.startsWith('크기') ? '#ff9f0a' : '#a8b0bb';
    g.strokeStyle = col;
    g.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
    const tw = g.measureText(it.verdict).width;
    g.fillStyle = 'rgba(13,17,23,.8)';
    g.fillRect(x0 * sx, y0 * sy - 17, tw + 8, 16);
    g.fillStyle = col;
    g.fillText(it.verdict, x0 * sx + 4, y0 * sy - 5);
  }
}

// ---------- 화면 글 ----------
// 경로 기록 중 도로 평면 영상을 모은 범위(%): 디오라마 작업 범위 안 칸 중 본 칸 비율 (워커가 1초에 한 번 계산)
const scanCoverage = () => scanPercent;
let hudT = 0;
function flash(msg, ms = 3000) {
  $('status').textContent = msg;
  $('status').className = 'ok';
  flashUntil = performance.now() + ms;
}
function updateHud(t) {
  if (t - hudT < 150) return;
  hudT = t;
  const now = performance.now();
  const seen = [...lastSeen.entries()].filter(([, s]) => now - s < 600).length;
  drawDetections();
  // 위치를 맞추기 전에는 [경로 기록]이 안 된다는 걸 버튼에 표시
  const recLabel = fuser.ready ? '경로 기록' : '경로 기록 (위치 맞춘 뒤)';
  if ($('btnRecord').textContent !== recLabel) { $('btnRecord').textContent = recLabel; $('btnRecord').classList.toggle('off', !fuser.ready); }
  $('debug').textContent = `${fps.toFixed(0)}fps · 인식 ${detMs.toFixed(0)}ms${detectClient.mode === 'worker' ? '' : '(화면 스레드)'} · 마커 ${seen}개 · 맞춤 ${fuser.count}${reader && reader.flipLocked ? '' : ' · 영상 방향 확인 중'}`;
  // 인식 · 판단 · 제어 카드
  const st = controller.state === 'drive' ? '주행' : controller.state === 'brake' ? '감속' : '정지';
  const onPath = barricade && blocksPath(P, barricade, clearance());
  const yel = lastYellow && performance.now() - lastYellow.t < 1000 ? lastYellow.items : [];
  // 줄무늬 후보(노란 조각 2개 이상)가 탈락했을 때만 이유를 보여 줌 (노란 블록 하나는 늘 있을 수 있어서 제외)
  const rej = barricadeSeenNow ? [] : yel.filter((i) => !i.single && !i.ok);
  const rejected = rej.length ? ` · 노랑 후보 ${rej.length}개(${rej[0].verdict})` : '';
  $('hudSense').textContent = `도로 마커 ${seen}개 · 바리케이드 ${barricadeSeenNow ? `보임(${barricadeSeenNow})` : barricade ? '기억 중' : '없음'}${rejected}`;
  $('hudJudge').textContent = !barricade ? '장애물 없음' : !onPath ? '바리케이드 있음 · 경로 밖'
    : controller.gap !== null ? `경로 위 · 앞 ${controller.gap.toFixed(1)}cm` : '경로 위 · 아직 멀리 있음';
  $('hudControl').textContent = `${st} · ${controller.v.toFixed(1)}cm/s`;
  $('speedBar').style.width = `${Math.min(100, (controller.v / controller.o.cruise) * 100)}%`;
  $('speedBar').className = controller.state;
  $('cardSense').classList.toggle('hot', !!barricadeSeenNow);
  $('cardJudge').classList.toggle('hot', !!onPath);
  $('cardControl').classList.toggle('hot', controller.state !== 'drive');
  if (now < flashUntil) return;
  let msg, ok = false;
  if (mapping.setup) {
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
    $('mapStat').textContent = msg;
    ok = st.confirmed.length > 0;
  } else if (heightMeasure.active) msg = `도로 면을 찾는 중… 도로 위를 비스듬히 비춰 주세요 (${heightMeasure.samples.length}점)`;
  else if (trackingPoor) msg = '카메라 추적이 불안정해요 · 천천히 움직이며 바닥을 비춰 주세요';
  else if (!fuser.ready) msg = `디오라마 테두리의 도로 마커를 비춰 주세요 · 위치 맞추는 중 ${fuser.count}/${fuser.minCount}`;
  else if (recording.active) {
    const cardNow = performance.now() - card.seen < 500;
    msg = recording.snapped ? '찾은 경로(초록) · 괜찮으면 [완료·저장]'
      : cardNow ? `경로 카드 보임 · 1초 그대로 두면 점이 찍혀요 · 점 ${recording.pts.length}개`
        : `경로 카드(마커 ${cfg.pathCard.id})를 차선 가운데에 놓고 비춰 주세요 · 한 바퀴 돌면 [완료·저장] · 점 ${recording.pts.length}개`;
    ok = true;
  }
  else if (cfg.pathStale) msg = '경로가 없어요 · [경로 기록]으로 만들어 주세요';
  else { msg = seen ? '위치 맞춤 완료 · 마커를 볼 때마다 더 정확해져요' : '위치 맞춤 완료 · 마커가 안 보여도 계속 달려요'; ok = true; }
  $('status').textContent = msg;
  $('status').className = ok ? 'ok' : 'warn';
}

// ---------- 버튼 ----------
$('btnStart').onclick = startAR;
$('btnExit').onclick = () => { if (session) session.end(); };
$('btnClear').onclick = () => { barTracker.clear(); barricade = null; flash('바리케이드를 해제했어요', 1500); };
$('btnRealign').onclick = () => { fuser.reset(); roadTracker.reset(); flash('위치를 다시 맞춰요 · 도로 마커를 비춰 주세요'); };
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
const roadWidthIn = () => parseFloat($('setupRoad').value) || cfg.lane.roadWidth || 30;
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
    const n = res.pts.length, col = [], pos = [];
    const ok = new THREE.Color(res.ok ? 0x3ddc84 : 0x38d9ff), weak = new THREE.Color(0xff9f0a);
    for (let i = 0; i <= n; i++) {
      const p = res.pts[i % n], c = res.weak && res.weak[i % n] ? weak : ok;
      pos.push(p[0], p[1], 0.2); col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    setupGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true })));
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
  flash(`설치 완료 · 마커 ${map.markers.length}개 · 경로 ${(res.length / 100).toFixed(2)}m · 다른 태블릿과 쓰려면 [AR 끝내기] → [전시 설정 내보내기]`, 9000);
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
$('recUndo').onclick = () => { if (recording.snapped) recording.snapped = null; else recording.pts.pop(); refreshRecordVis(); };
$('recCancel').onclick = () => setRecording(false);
$('recSnap').onclick = snapRecording;
$('recAuto').onclick = autoPath;
// 경로 기록 중: 탭 없이 흰 중앙선 한 바퀴 찾기 (비춘 도로 영상으로)
$('recLoop').onclick = async () => {
  if (laneBusy) return;
  laneBusy = true;
  try {
    flash('중앙선 한 바퀴를 찾는 중…', 3000);
    const res = await detectClient.findLoop({ roadWidth: cfg.lane.roadWidth || 30 });
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
$('btnHeightAuto').onclick = () => {
  if (!fuser.ready) { flash('먼저 마커로 위치를 맞춰 주세요'); return; }
  if (!hitSource) { flash('이 기기는 바닥 인식(hit-test)이 안 돼요 · 높이 −/+로 맞춰 주세요', 4000); return; }
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
  get state() {
    return { roadMarkers: cfg.roadMarkers, path: cfg.path, ready: fuser.ready, count: fuser.count, align: fuser.result, s: controller.s, v: controller.v,
      carState: controller.state, gap: controller.gap, barricade, barricadeSeenNow, recPts: recording.pts, snapped: recording.snapped, lastSnap, partial: recording.partial, scan: scanCoverage(),
      yellow: lastYellow ? lastYellow.items.map((i) => i.verdict) : [],
      mapping: mapping.active ? mapping.mapper.status() : null,
      setup: mapping.setup ? { A0: mapping.A0, loop: mapping.loop && { ok: mapping.loop.ok, found: mapping.loop.found, refined: mapping.loop.refined, length: mapping.loop.length } } : null, lastMapResult, card: cardMean(1000), cardHist: card.hist.length, roadHeight: roadH(),
      detectMode: detectClient.mode, detMs, gpu: { ...renderer.info.memory } };
  },
};
