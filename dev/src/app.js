// RAIM AR 자율주행 — 마커 버전 프로토타입
import * as THREE from 'three';
import { applyH, makeK, estimateFocal, transformPoint, inv3, mul3, project } from './geometry.js';
import { RoadPoseTracker, solveBarricade, toFullRes } from './tracking.js';
import { MarkerMapper } from './mapping.js';
import { RoadMosaic, snapPathToLane } from './lane.js';
import { snapToStripe, refineAlongStripe, travelGuide } from './loop.js';
import {
  smoothPath, buildPath, carPoseAt, CarController, BarricadeTracker, blocksPath,
} from './logic.js';
import { DEFAULT_CONFIG, isSheetMap } from './config.js';
import {
  clone, mergeDeep, loadConfig, storeConfig, loadShared, downloadShared, sharedLabel,
} from './store.js';
import { makeCar, makeBarricadeVis, disposeObject, clearGroup, coloredLoop } from './scene.js';
import { createAdminGate } from './admin.js';
import {
  roadHeight, markerSizeOf, carDimsOf, driveOptsOf, clearanceOf, liftPose, laneSnapOpts, laneSnapMessage, setupMenuToggle, centerLineOn,
} from './common.js';

const AR = window.AR;
const $ = (id) => document.getElementById(id);

// ---------- 설정 (AR 버전과 같은 저장소를 씀) ----------
function saveConfig() { storeConfig(cfg); }

let cfg = loadConfig();

// ---------- 상태 ----------
const video = $('video');
const stage = $('stage');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

let detector = null;
const roadTracker = new RoadPoseTracker(); // 마커 1개일 때 바닥 기울기가 뒤집히지 않게 직전 프레임을 기억
let P = null;
let controller = null;
let tracker = null;
let running = false;
let lastFrame = performance.now();
let lastRoadSeen = -Infinity;
let havePose = false;
let camPose = null; // 도로 → 카메라
let focal = null;
let focalSamples = [];
let lastMarkers = [];
let roadCount = 0;
let barricade = null; // 추적 중인 바리케이드 {x,y,dx,dy,width}
let barricadeSeenNow = false;
let showDetections = true;
let showPath = true;
let detMs = 0;
let fps = 0;
// 새 카메라 영상이 왔을 때만 인식한다. 화면은 60~120Hz로 그리지만 카메라는 보통 30fps라서,
// 매 화면 프레임마다 인식하면 절반 이상은 같은 영상을 다시 인식하게 됨
const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let newVideoFrame = true;
let lastProcessed = -Infinity;
let lastPoseTime = -Infinity;
let flashUntil = 0; // 안내 문구를 잠시 유지하는 동안에도 인식·판단·제어 카드는 계속 갱신
function watchVideoFrames() {
  if (!HAS_RVFC || video.__raimWatching) return;
  video.__raimWatching = true;
  const onFrame = () => { newVideoFrame = true; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
}
const recording = { active: false, pts: [], snapped: null };
let mosaic = null; // 경로 기록 중 모으는 도로 평면 영상 (차선 맞추기용)
const mapping = { active: false, mapper: null, busy: false };

// ---------- 3D ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('three'), alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const cam3 = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 5000);
cam3.matrixAutoUpdate = false;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-20, -30, 60);
scene.add(sun);

const world = new THREE.Group();
scene.add(world);
let carObj = null;
let pathLine = null;
const recordGroup = new THREE.Group();
world.add(recordGroup);
const barVis = makeBarricadeVis();
world.add(barVis.group);

const smoothQ = new THREE.Quaternion();
const smoothT = new THREE.Vector3();

// 설정에서 나오는 값 (AR 버전과 같은 규칙, common.js)
const roadH = () => roadHeight(cfg);
const driveOpts = () => driveOptsOf(cfg);
const carDims = () => carDimsOf(cfg);
const clearance = () => clearanceOf(cfg);

// keepProgress: 차 크기·도로 높이만 바뀐 경우(같은 지도·경로). 차 위치와 추적 중인 바리케이드를 그대로 둔다
// (바리케이드를 잊으면, 화면 밖에서 '기억 중'이던 바리케이드를 차가 그냥 지나감)
function rebuildWorld(keepProgress = true) {
  const frac = controller && P ? controller.s / P.length : 0;
  // 탭한 점의 손떨림을 펴 주는 정도: 원래 차 길이의 0.3배 (A4 시트 약 1cm, 10cm 마커 디오라마 약 3.6cm)
  const pts = smoothPath(cfg.path, true, 0.5, cfg.car.length * 0.3);
  P = buildPath(pts, true);
  controller = new CarController(driveOpts());
  if (keepProgress) controller.s = frac * P.length;
  if (!keepProgress || !tracker) {
    tracker = new BarricadeTracker(cfg.barricadeTracking);
    barricade = null;
  }
  if (AR && !detector) detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });

  disposeObject(carObj);
  carObj = makeCar(carDims());
  carObj.visible = !recording.active && !cfg.pathStale;
  world.add(carObj);

  disposeObject(pathLine);
  const geo = new THREE.BufferGeometry().setFromPoints(P.pts.map((p) => new THREE.Vector3(p[0], p[1], 0.05)));
  pathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.8 }));
  world.add(pathLine);

  const b = cfg.barricade;
  barVis.box.scale.set(b.width, 0.8, b.height);
  barVis.edges.scale.set(b.width, 0.8, b.height);
  if (!keepProgress) { focalSamples = []; roadTracker.reset(); }
  world.position.z = roadH(); // 차·경로·바리케이드 표시를 모두 도로 면 높이에 올림
  const key = JSON.stringify(cfg.roadMarkers) + '|' + roadH();
  if (!mosaic || mosaic.key !== key) { mosaic = RoadMosaic.forMarkers(cfg.roadMarkers); mosaic.key = key; }
}

// ---------- 화면 배치 ----------
function videoSize() {
  return { w: video.videoWidth || 1280, h: video.videoHeight || 720 };
}
function fitStage() {
  const { w, h } = videoSize();
  const W = window.innerWidth, Hh = window.innerHeight;
  const s = Math.min(W / w, Hh / h);
  const cw = Math.floor(w * s), ch = Math.floor(h * s);
  stage.style.width = cw + 'px';
  stage.style.height = ch + 'px';
  renderer.setSize(cw, ch, false);
  overlay.width = w;
  overlay.height = h;
}
window.addEventListener('resize', fitStage);

// ---------- 카메라 / 영상 ----------
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    begin();
  } catch (e) {
    showStartError('카메라를 열 수 없어요: ' + (e && e.message ? e.message : e) +
      '\nHTTPS 주소인지, 카메라 권한을 허용했는지 확인해 주세요.');
  }
}
async function startFile(file) {
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.loop = true;
  await video.play();
  begin();
}
function begin() {
  $('start').hidden = true;
  $('ui').hidden = false;
  const onReady = () => { fitStage(); };
  if (video.readyState >= 1) onReady(); else video.addEventListener('loadedmetadata', onReady, { once: true });
  watchVideoFrames();
  if (!running) { running = true; requestAnimationFrame(loop); }
}
function showStartError(msg) {
  $('startMsg').textContent = msg;
}

// ---------- 인식 ----------
function currentFocal(w, h) {
  const base = cfg.tracking.focalFactor * Math.max(w, h);
  if (!cfg.tracking.focalAuto || focalSamples.length < 20) return base;
  const s = focalSamples.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function setPoseSmoothed(pose, now) {
  const m = new THREE.Matrix4().set(
    pose.R[0], pose.R[1], pose.R[2], 0,
    pose.R[3], pose.R[4], pose.R[5], 0,
    pose.R[6], pose.R[7], pose.R[8], 0,
    0, 0, 0, 1,
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const t = new THREE.Vector3(pose.t[0], pose.t[1], pose.t[2]);
  // smoothing은 60Hz 화면 프레임 하나당 따라가는 비율로 맞춰 둔 값 → 실제 영상 간격에 맞게 환산
  const dtPose = Math.max(0, Math.min(0.2, (now - lastPoseTime) / 1000));
  lastPoseTime = now;
  const a = 1 - Math.pow(1 - cfg.tracking.smoothing, Math.max(1, dtPose * 60));
  const stale = now - lastRoadSeen > 400;
  if (!havePose || stale || t.distanceTo(smoothT) > 15) {
    smoothQ.copy(q); smoothT.copy(t);
  } else {
    smoothQ.slerp(q, a); smoothT.lerp(t, a);
  }
  havePose = true;
  const rm = new THREE.Matrix4().makeRotationFromQuaternion(smoothQ).elements; // 열 우선
  camPose = {
    R: [rm[0], rm[4], rm[8], rm[1], rm[5], rm[9], rm[2], rm[6], rm[10]],
    t: [smoothT.x, smoothT.y, smoothT.z],
  };
}

function processFrame(now) {
  const { w: vw, h: vh } = videoSize();
  if (!detector || !video.videoWidth) return;
  const pw = Math.min(cfg.tracking.procWidth, vw);
  const ph = Math.round((vh * pw) / vw);
  if (proc.width !== pw || proc.height !== ph) { proc.width = pw; proc.height = ph; }
  pctx.drawImage(video, 0, 0, pw, ph);
  const img = pctx.getImageData(0, 0, pw, ph);
  const t0 = performance.now();
  const markers = detector.detect(img);
  detMs = detMs * 0.8 + (performance.now() - t0) * 0.2;
  const sc = vw / pw;
  lastMarkers = markers.map((m) => ({ id: m.id, c: toFullRes(m.corners, sc) }));
  if (mapping.active) {
    if (!mapping.busy) mapping.mapper.addFrame(lastMarkers);
    return;
  }

  focal = currentFocal(vw, vh);
  let K = makeK(focal, vw / 2, vh / 2);

  // 1) 도로 마커 → 카메라 자세
  let road = roadTracker.update(lastMarkers, cfg.roadMarkers, K, now);
  roadCount = road.count;
  if (road.H && cfg.tracking.focalAuto && road.nPts >= 8) {
    const e = estimateFocal(road.H, vw / 2, vh / 2);
    const L = Math.max(vw, vh);
    if (e && e > 0.4 * L && e < 2.5 * L) {
      focalSamples.push(e);
      if (focalSamples.length > 150) focalSamples.shift();
      const f2 = currentFocal(vw, vh);
      if (Math.abs(f2 - focal) > 0.5) {
        focal = f2;
        K = makeK(focal, vw / 2, vh / 2);
        road = roadTracker.update(lastMarkers, cfg.roadMarkers, K, now);
      }
    }
  }
  if (road.pose) {
    setPoseSmoothed(road.pose, now);
    lastRoadSeen = now;
    // 경로 기록 중에는 보이는 도로를 위에서 본 영상으로 모은다 (차선 맞추기용)
    if (recording.active && mosaic && road.rms < 3) mosaic.accumulate(img, makeK(focal / sc, vw / 2 / sc, vh / 2 / sc), liftPose(road.pose, roadH()));
  }
  const tracking = havePose && now - lastRoadSeen < cfg.tracking.lostMs;

  // 2) 바리케이드 마커 → 도로 좌표
  // 자세 보정(smoothing)으로 생기는 지연을 피하려고, 이번 프레임에 도로를 봤으면 그 자세를 쓴다
  let obs = null;
  if (tracking) obs = solveBarricade(lastMarkers, cfg.barricade, K, road.pose || camPose);
  barricadeSeenNow = !!obs;
  let inView = false;
  if (tracking && tracker.est) {
    const c = transformPoint(camPose, [tracker.est.x, tracker.est.y, 1]);
    if (c[2] > 0) {
      const u = project(K, camPose.R, camPose.t, [tracker.est.x, tracker.est.y, 1]);
      inView = u[0] > vw * 0.08 && u[0] < vw * 0.92 && u[1] > vh * 0.08 && u[1] < vh * 0.92;
    }
  }
  const est = tracker.update(now, obs, inView);
  barricade = est ? { ...est, width: cfg.barricade.width } : null;
  lastK = K;
}
let lastK = null;

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!showDetections || !gate.on) return; // 마커 인식 표시는 관리자 모드에서만
  const lw = Math.max(2, overlay.width / 400);
  octx.lineWidth = lw;
  octx.font = `${Math.round(lw * 9)}px system-ui, sans-serif`;
  const roadIds = new Set(cfg.roadMarkers.map((m) => m.id));
  for (const m of lastMarkers) {
    const isBar = cfg.barricade.markerIds.includes(m.id);
    const isRoad = roadIds.has(m.id);
    let color = isBar ? '#ffc400' : isRoad ? '#3ddc84' : '#999';
    let label = isBar ? '바리케이드' : isRoad ? `도로 ${m.id}` : `#${m.id}`;
    if (mapping.active && !isBar) {
      const mp = mapping.mapper;
      if (m.id === mp.refId) { color = '#38d9ff'; label = `${m.id} 기준`; }
      else if (mp.confirmed(m.id)) { color = '#3ddc84'; label = `${m.id} 등록됨`; }
      else { color = '#ff9f0a'; label = `${m.id} 확인 중 ${(mp.samples.get(m.id) || []).length}/${mp.minSamples}`; }
    }
    octx.strokeStyle = color;
    octx.beginPath();
    m.c.forEach((p, i) => (i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1])));
    octx.closePath();
    octx.stroke();
    octx.fillStyle = color;
    octx.fillText(label, m.c[0][0], m.c[0][1] - lw * 3);
  }
}

// ---------- 3D 갱신 ----------
function updateCamera3() {
  const { w: vw, h: vh } = videoSize();
  cam3.fov = (2 * Math.atan(vh / (2 * focal)) * 180) / Math.PI;
  cam3.aspect = vw / vh;
  cam3.updateProjectionMatrix();
  const R = camPose.R, t = camPose.t;
  const view = new THREE.Matrix4().set(
    R[0], R[1], R[2], t[0],
    -R[3], -R[4], -R[5], -t[1],
    -R[6], -R[7], -R[8], -t[2],
    0, 0, 0, 1,
  );
  cam3.matrix.copy(view).invert();
  cam3.matrixWorldNeedsUpdate = true;
  cam3.updateMatrixWorld(true);
}


function updateWorld(dt) {
  controller.update(dt, P, barricade, clearance());
  const q = carPoseAt(P, controller.s, carDims().length * 0.6);
  carObj.position.set(q.x, q.y, 0);
  carObj.rotation.set(0, 0, q.heading);
  carObj.userData.brakeMat.color.set(controller.state === 'drive' ? 0x551111 : 0xff2222);

  if (barricade) {
    barVis.group.visible = true;
    barVis.group.position.set(barricade.x, barricade.y, cfg.barricade.height / 2);
    barVis.group.rotation.set(0, 0, Math.atan2(barricade.dy, barricade.dx));
    const blocking = controller.gap !== null;
    const col = blocking ? 0xff3b30 : 0xffc400;
    barVis.fillMat.color.set(col);
    barVis.lineMat.color.set(col);
  } else {
    barVis.group.visible = false;
  }
  pathLine.visible = !cfg.pathStale && (showPath || recording.active);
  carObj.visible = !recording.active && !cfg.pathStale;
}

// ---------- HUD ----------
let hudTimer = 0;
const STATE_KO = { drive: '달리는 중', brake: '속도를 줄이는 중', stop: '멈춤' };
function updateHud(now, tracking) {
  if (now - hudTimer < 100) return;
  hudTimer = now;
  const holdStatus = performance.now() < flashUntil; // 안내 문구를 보여 주는 중이면 상태 줄만 그대로 둠
  if (mapping.active) {
    const st = mapping.mapper.status();
    const visible = lastMarkers.filter((m) => !cfg.barricade.markerIds.includes(m.id)).length;
    if (!holdStatus) {
      $('status').textContent = mapping.busy ? '계산 중…' : visible >= 2 ? '좋아요 · 계속 천천히 옆으로 이동하세요'
        : visible === 1 ? '이웃한 마커가 함께 보이게 조금 물러나세요' : '테두리의 마커를 비춰 주세요';
      $('status').classList.toggle('warn', visible < 2);
    }
    $('mapInfo').textContent = st.refId === null ? '아직 본 마커가 없어요'
      : `기준 ${st.refId} · 등록 ${st.confirmed.length}개 (${st.confirmed.join(', ')})` +
        (st.pending.length ? ` · 확인 중 ${st.pending.map((q) => q.id).join(', ')}` : '');
    $('debug').textContent = `${fps.toFixed(0)}fps · 인식 ${detMs.toFixed(0)}ms · 저장된 장면 ${st.frames}`;
    return;
  }
  if (!holdStatus && !gate.on) {
    // 관람객 안내
    const msg = !tracking ? '디오라마 가장자리의 검은 사각형 표식이 화면에 보이게 비춰 주세요'
      : cfg.pathStale ? '아직 준비 중이에요 · 직원에게 알려 주세요'
        : barricade && controller.state === 'stop' ? '바리케이드 앞에서 멈췄어요 · 치우면 다시 출발해요'
          : barricade && controller.state === 'brake' ? '바리케이드를 알아보고 속도를 줄이고 있어요'
            : '자율주행차가 달리고 있어요 · 도로에 바리케이드를 세워 보세요';
    $('status').textContent = msg;
    $('status').classList.toggle('warn', !tracking || cfg.pathStale);
  } else if (!holdStatus) {
    let msg = tracking
      ? recording.active ? (recording.snapped ? '맞춘 경로(초록) · 괜찮으면 [완료·저장]'
        : `${aimOn ? '조준점(+)을 흰 중앙선에 맞추고 화면을 톡' : '흰 중앙선 위를 톡'} · 직선 30~50cm, 곡선 10~15cm마다 · 점 ${recording.pts.length}개(중앙선에 붙음 ${recording.pts.filter((p) => tapState.get(p) === 'ok').length}) · 한 바퀴 돌면 [중앙선 맞추기]`) : '도로 인식됨'
      : '도로 마커를 화면에 비춰 주세요';
    if (tracking && !recording.active && roadCount === 1) msg = '도로 인식됨 · 마커가 2개 이상 보이면 더 안정적이에요';
    if (tracking && cfg.pathStale && !recording.active) msg = '마커 지도가 바뀌었어요 · [경로 기록]으로 새 경로를 만들어 주세요';
    $('status').textContent = msg;
    $('status').classList.toggle('warn', !tracking);
  }

  // 인식 · 판단 · 제어 카드 (관람객도 읽을 수 있는 말로, 관리자는 자세한 값 덧붙임)
  $('hudSense').textContent = (barricadeSeenNow ? '바리케이드를 찾았어요' : barricade ? '바리케이드를 기억하고 있어요' : '길 위에 장애물이 없어요') +
    (gate.on ? ` · 도로 마커 ${roadCount}개` : '');
  const onPath = barricade && blocksPath(P, barricade, clearance());
  let judge = '가는 길이 비어 있어요';
  if (barricade && !onPath) judge = '바리케이드가 있지만 길 밖이에요';
  if (onPath) judge = controller.gap !== null ? `길을 막고 있어요 · 앞 ${controller.gap.toFixed(1)}cm` : '길 위에 있지만 아직 멀어요';
  $('hudJudge').textContent = judge;
  $('hudControl').textContent = `${STATE_KO[controller.state]} · ${controller.v.toFixed(1)}cm/s`;
  $('speedBar').style.width = `${Math.min(100, (controller.v / controller.o.cruise) * 100)}%`;
  $('speedBar').className = controller.state;
  ['cardSense', 'cardJudge', 'cardControl'].forEach((id) => $(id).classList.remove('hot'));
  if (barricadeSeenNow) $('cardSense').classList.add('hot');
  if (onPath) $('cardJudge').classList.add('hot');
  if (controller.state === 'brake') $('cardControl').classList.add('hot');
  $('cardControl').classList.toggle('stop', controller.state === 'stop');
  $('debug').textContent = `${fps.toFixed(0)}fps · 인식 ${detMs.toFixed(0)}ms · f ${focal ? focal.toFixed(0) : '-'}${cfg.tracking.focalAuto ? (focalSamples.length >= 20 ? '(자동)' : `(보정 ${focalSamples.length}/20)`) : ''}`;
}

// ---------- 루프 ----------
function loop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  fps = fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
  lastFrame = now;
  // 새 영상이 왔을 때만 (requestVideoFrameCallback이 없거나 소식이 끊기면 250ms마다는 처리)
  if (video.readyState >= 2 && (newVideoFrame || !HAS_RVFC || now - lastProcessed > 250)) {
    newVideoFrame = false;
    lastProcessed = now;
    processFrame(now);
    drawOverlay();
  }
  const tracking = havePose && now - lastRoadSeen < cfg.tracking.lostMs;
  updateWorld(dt);
  world.visible = tracking && !mapping.active;
  if (tracking) updateCamera3();
  renderer.render(scene, cam3);
  updateHud(now, tracking);
  requestAnimationFrame(loop);
}

// ---------- 경로 기록 ----------
function screenToTable(clientX, clientY) {
  if (!camPose || !lastK) return null;
  const rect = stage.getBoundingClientRect();
  const { w: vw, h: vh } = videoSize();
  const u = ((clientX - rect.left) / rect.width) * vw;
  const v = ((clientY - rect.top) / rect.height) * vh;
  const { R, t } = liftPose(camPose, roadH()); // 탭한 곳 = 시선이 도로 면(z = 도로 높이)과 만나는 점
  const M = [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]];
  const H = mul3(lastK, M);
  const Hi = inv3(H);
  if (!Hi) return null;
  return applyH(Hi, u, v);
}
function refreshRecordVis() {
  clearGroup(recordGroup);
  const mats = { ok: new THREE.MeshBasicMaterial({ color: 0x3ddc84 }), miss: new THREE.MeshBasicMaterial({ color: 0xff9f0a }), pending: new THREE.MeshBasicMaterial({ color: 0xff00aa }) };
  const geo = new THREE.SphereGeometry(0.35, 12, 8);
  for (const p of recording.pts) {
    const s = new THREE.Mesh(geo, mats[tapState.get(p) || 'pending']);
    s.scale.setScalar(cfg.car.width / 1.8);
    s.position.set(p[0], p[1], 0.35 * (cfg.car.width / 1.8));
    recordGroup.add(s);
  }
  if (recording.pts.length > 1) {
    const g = new THREE.BufferGeometry().setFromPoints(
      [...recording.pts, recording.pts[0]].map((p) => new THREE.Vector3(p[0], p[1], 0.1)));
    recordGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff00aa, transparent: true, opacity: recording.snapped ? 0.35 : 1 })));
  }
  if (recording.snapped && recording.snapWeak) recordGroup.add(coloredLoop(recording.snapped, recording.snapWeak, 0x3ddc84, 0.15));
  else if (recording.snapped) {
    const sp = smoothPath(recording.snapped, true, 0.5);
    const g = new THREE.BufferGeometry().setFromPoints([...sp, sp[0]].map((p) => new THREE.Vector3(p[0], p[1], 0.15)));
    recordGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3ddc84 })));
  }
}

// 탭한 점들을 흰 선 사이(차선 가운데)로 옮긴다
// [중앙선 맞추기]: 탭한 점 사이 곡선까지 흰 중앙선에 붙인다 (중앙선에 못 붙은 점은 붙은 점이 충분하면 뺌).
// 흰 중앙선이 없는 도로(A4 시트 등)면 예전 차선 맞추기로
function snapRecording() {
  if (recording.pts.length < 4) { flash('점을 4개 이상 찍은 뒤 눌러 주세요'); return; }
  const nOk = recording.pts.filter((p) => tapState.get(p) === 'ok').length;
  const base = nOk >= 4 && nOk >= recording.pts.length * 0.5 ? recording.pts.filter((p) => tapState.get(p) !== 'miss') : recording.pts;
  const res = centerLineOn(cfg) ? refineAlongStripe(mosaic, base, { roadWidth: cfg.lane.roadWidth || 30 }) : { ok: false };
  if (res.ok) {
    lastSnap = { ...res, method: 'stripe' };
    recording.snapped = res.pts; recording.snapWeak = res.weak;
    refreshRecordVis();
    flash(`중앙선에 맞췄어요 · 확인 ${Math.round(res.refined * 100)}%${res.weak.some(Boolean) ? ' · 주황 부분은 중앙선을 못 봐서 이어 붙였어요' : ''} · 괜찮으면 [완료·저장]`, 5000);
    return;
  }
  const lane = snapPathToLane(mosaic, recording.pts, laneSnapOpts(cfg, mosaic));
  lastSnap = { ...lane, method: 'lane' };
  flash(laneSnapMessage(lane), 3500, lane.ok ? 'ok' : 'warn');
  if (!lane.ok) return;
  recording.snapped = lane.pts; recording.snapWeak = null;
  refreshRecordVis();
}
let lastSnap = null;

function flash(msg, ms = 3500, cls = 'ok') {
  $('status').textContent = msg;
  $('status').classList.toggle('warn', cls === 'warn');
  flashUntil = performance.now() + ms;
}
// 조준점 켬(기본): 손가락 위치 대신 화면 가운데(조준점)를 쓴다 (손가락은 화면에서 2~3mm 빗나가고, 디오라마에서는 그 몇 배)
let aimOn = true;
try { aimOn = localStorage.getItem('raim-ar-aim') !== '0'; } catch (e) { /* 무시 */ }
function setAim(on) {
  aimOn = on;
  try { localStorage.setItem('raim-ar-aim', on ? '1' : '0'); } catch (e) { /* 무시 */ }
  $('recAim').textContent = on ? '조준점 켬' : '조준점 끔(손가락)';
  $('recAim').classList.toggle('off', !on);
  $('aim').hidden = !(recording.active && on);
}
// 탭한 점은 근처 흰 중앙선에 바로 붙인다. 점 색: 초록 = 붙음, 주황 = 못 찾아 탭한 자리 그대로
const tapState = new WeakMap();
stage.addEventListener('pointerdown', (e) => {
  if (!recording.active) return;
  const tracking = havePose && performance.now() - lastRoadSeen < cfg.tracking.lostMs;
  if (!tracking) return;
  const rect = stage.getBoundingClientRect();
  const p = aimOn ? screenToTable(rect.left + rect.width / 2, rect.top + rect.height / 2) : screenToTable(e.clientX, e.clientY);
  if (!p) return;
  const entry = [+p[0].toFixed(2), +p[1].toFixed(2)];
  const roadWidth = cfg.lane.roadWidth || 30;
  const guide = travelGuide(recording.pts.filter((q) => tapState.get(q) === 'ok'), entry);
  if (centerLineOn(cfg)) {
    const r = mosaic ? snapToStripe(mosaic, entry, { roadWidth, guide }) : { ok: false };
    if (r.ok) { entry[0] = +r.x.toFixed(2); entry[1] = +r.y.toFixed(2); }
    tapState.set(entry, r.ok ? 'ok' : 'miss');
  }
  recording.pts.push(entry);
  recording.snapped = null; recording.snapWeak = null;
  refreshRecordVis();
});
// ---------- 마커 지도 만들기 ----------
function setMapping(on) {
  mapping.active = on;
  mapping.busy = false;
  if (on) {
    const size = parseFloat($('mapSize').value) || 10;
    mapping.mapper = new MarkerMapper({ size, excludeIds: [...cfg.barricade.markerIds, cfg.pathCard.id] });
  }
  $('mapBar').hidden = !on;
  $('mainButtons').hidden = on;
  $('hud').hidden = on;
  $('mapMsg').textContent = '';
}
function finishMapping() {
  const mp = mapping.mapper;
  const st = mp.status();
  if (st.confirmed.length < 2) {
    $('mapMsg').textContent = '등록된 마커가 2개 이상 필요해요. 이웃한 마커가 함께 보이게 더 비춰 주세요.';
    return;
  }
  mapping.busy = true;
  $('mapMsg').textContent = '모든 장면을 모아 마커 위치를 계산하고 있어요…';
  setTimeout(() => {
    const { w: vw, h: vh } = videoSize();
    const res = mp.solve({ imgW: vw, imgH: vh, f0: currentFocal(vw, vh) });
    const oldSize = cfg.roadMarkers.length ? cfg.roadMarkers[0].size : mp.size;
    const r = mp.size / oldSize;
    if (Math.abs(r - 1) > 0.01 && isSheetMap(cfg.roadMarkers)) {
      // A4 시트(3cm 마커)에서 디오라마 지도로 처음 넘어갈 때만 자동차 크기와 속도도 같은 비율로 키운다
      // (디오라마 지도끼리 마커 크기를 바꿀 때는 맞춰 둔 차 크기·속도를 그대로 둠)
      for (const k of ['length', 'width', 'height']) cfg.car[k] = +(cfg.car[k] * r).toFixed(2);
      if (cfg.lane.width) cfg.lane.width = +(cfg.lane.width * r).toFixed(2);
      for (const k of ['cruise', 'brakeDist', 'stopGap', 'accel', 'decel', 'margin']) cfg.drive[k] = +(cfg.drive[k] * r).toFixed(2);
    }
    cfg.roadMarkers = res.markers;
    cfg.pathStale = true; // 좌표가 바뀌었으니 이전 경로는 쓸 수 없음
    if (res.focal) { cfg.tracking.focalFactor = +(res.focal / Math.max(vw, vh)).toFixed(4); cfg.tracking.focalAuto = false; }
    saveConfig();
    focalSamples = [];
    const q = res.errorPx === null ? '' : res.errorPx < 1.5 ? '정확도 좋음' : res.errorPx < 3 ? '정확도 보통' : '정확도 낮음 · 다시 만드는 걸 권해요';
    const warn = res.unconnected.length ? ` · 연결 안 된 마커 ${res.unconnected.join(', ')}(제외됨)` : '';
    setMapping(false);
    rebuildWorld(false);
    havePose = false;
    lastMapResult = res;
    setRecording(true);
    flash(`마커 ${res.markers.length}개 저장 · ${q}${warn} · 이제 차선 위를 탭해 경로를 만드세요`, 4000);
  }, 30);
}
let lastMapResult = null;

function setRecording(on) {
  recording.active = on;
  recording.pts = [];
  recording.snapped = null; recording.snapWeak = null;
  setAim(aimOn);
  refreshRecordVis();
  $('recordBar').hidden = !on;
  $('mainButtons').hidden = on;
  $('hud').hidden = on;
  carObj.visible = !on;
}

// ---------- 마커 인쇄 ----------
function openMarkerSheet() {
  const dict = new AR.Dictionary('ARUCO_MIP_36h12');
  const items = [
    ...cfg.roadMarkers.map((m) => ({ id: m.id, size: m.size, label: `도로 마커 ${m.id}` })),
    ...cfg.barricade.markerIds.map((id) => ({ id, size: cfg.barricade.markerSize, label: `바리케이드 마커 ${id}` })),
  ];
  const cells = items.map((it) => {
    const svg = dict.generateSVG(it.id).replace('<svg ', `<svg width="${(it.size * 10) / 8}cm" height="${(it.size * 10) / 8}cm" `);
    return `<figure>${svg}<figcaption>${it.label} · 검은 사각형 ${it.size}cm</figcaption></figure>`;
  }).join('');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>마커 인쇄</title>
<style>@page{margin:1cm}body{font-family:system-ui,sans-serif;margin:0}figure{display:inline-block;margin:0 .6cm .6cm 0;text-align:center;break-inside:avoid}figcaption{font-size:9pt;color:#333;margin-top:2mm}p{font-size:10pt}</style>
<p>인쇄 시 배율을 100%(실제 크기)로 설정하세요. 인쇄 후 검은 사각형의 한 변이 표시된 크기인지 자로 확인하세요.</p>${cells}</html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ---------- 설정 화면 ----------
function openSettings() {
  $('cfgText').value = JSON.stringify(cfg, (k, v) => (k === 'path' ? v.map((p) => p.map((n) => +(+n).toFixed(2))) : v), 2);
  $('cfgMsg').textContent = '';
  $('settings').hidden = false;
}
$('cfgSave').onclick = () => {
  try {
    const next = mergeDeep(clone(DEFAULT_CONFIG), JSON.parse($('cfgText').value));
    if (!Array.isArray(next.roadMarkers) || !next.roadMarkers.length) throw new Error('roadMarkers가 비어 있어요');
    if (!Array.isArray(next.path) || next.path.length < 4) throw new Error('path 점이 4개 이상 필요해요');
    cfg = next;
    saveConfig();
    rebuildWorld(false);
    $('settings').hidden = true;
  } catch (e) {
    $('cfgMsg').textContent = '저장 실패: ' + e.message;
  }
};
$('cfgReset').onclick = () => {
  cfg = clone(DEFAULT_CONFIG);
  saveConfig();
  rebuildWorld(false);
  openSettings();
  $('cfgMsg').textContent = '기본값(A4 테스트 시트)으로 되돌렸어요.';
};
$('cfgPrint').onclick = openMarkerSheet;
$('cfgExport').onclick = () => { downloadShared(cfg); $('cfgMsg').textContent = 'diorama.json을 받았어요. 이 파일을 사이트에 올리면 모든 기기가 같은 지도·경로를 써요.'; };
$('cfgShared').onclick = async () => {
  const r = await loadShared(cfg, { force: true });
  if (r.status === 'applied') { cfg = r.cfg; rebuildWorld(false); openSettings(); $('cfgMsg').textContent = `전시 설정(${sharedLabel(r.shared)})을 다시 불러왔어요.`; }
  else $('cfgMsg').textContent = r.status === 'bad' ? '사이트의 diorama.json 내용이 올바르지 않아요.' : '사이트에 올라간 전시 설정(diorama.json)이 아직 없어요.';
};
$('cfgClose').onclick = () => { $('settings').hidden = true; };

// ---------- 버튼 ----------
$('btnCamera').onclick = startCamera;
$('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) startFile(f); };
$('btnClear').onclick = () => { tracker.clear(); barricade = null; };
$('btnPath').onclick = () => { showPath = !showPath; $('btnPath').classList.toggle('off', !showPath); };
$('btnDetect').onclick = () => { showDetections = !showDetections; $('btnDetect').classList.toggle('off', !showDetections); drawOverlay(); };
$('btnRecord').onclick = () => setRecording(true);
$('btnMap').onclick = () => setMapping(true);
$('mapReset').onclick = () => setMapping(true);
$('mapCancel').onclick = () => setMapping(false);
$('mapDone').onclick = finishMapping;
$('recUndo').onclick = () => {
  if (recording.snapped) { recording.snapped = null; recording.snapWeak = null; } else recording.pts.pop();
  refreshRecordVis();
};
$('recAim').onclick = () => setAim(!aimOn);
$('recSnap').onclick = snapRecording;
function setCarScale(k) {
  cfg.car.scale = +Math.max(0.5, Math.min(5, k)).toFixed(2);
  saveConfig();
  rebuildWorld(true);
  flash(`자동차 크기 ×${cfg.car.scale.toFixed(2)}`, 1500);
}
function setSpeedScale(k) {
  cfg.drive.speedScale = +Math.max(0.25, Math.min(5, k)).toFixed(2);
  saveConfig();
  controller.o = driveOpts(); // 위치·현재 속도는 그대로, 목표 속도만 바뀜
  flash(`자동차 속도 ×${cfg.drive.speedScale.toFixed(2)} · ${controller.o.cruise.toFixed(1)}cm/s`, 1500);
}
// 도로 높이: 마커 크기의 1/40씩 (10cm 마커 → 0.25cm)
function setRoadHeight(h) {
  cfg.roadHeight = +Math.max(-10, Math.min(20, h)).toFixed(3);
  saveConfig();
  rebuildWorld(true);
  const sz = markerSizeOf(cfg);
  flash(`도로 높이 ${cfg.roadHeight >= 0 ? '+' : ''}${cfg.roadHeight.toFixed(sz >= 5 ? 2 : 3)}cm · 휴대폰을 움직여도 파란 경로선이 차선에 붙어 있으면 맞아요`, 2500);
}
function roadStep() { return markerSizeOf(cfg) / 40; }
$('heightUp').onclick = () => setRoadHeight(roadH() + roadStep());
$('heightDown').onclick = () => setRoadHeight(roadH() - roadStep());
$('speedUp').onclick = () => setSpeedScale((cfg.drive.speedScale || 1) * 1.25);
$('speedDown').onclick = () => setSpeedScale((cfg.drive.speedScale || 1) / 1.25);
$('carBigger').onclick = () => setCarScale((cfg.car.scale || 1) * 1.25);
$('carSmaller').onclick = () => setCarScale((cfg.car.scale || 1) / 1.25);
$('recCancel').onclick = () => setRecording(false);
$('recDone').onclick = () => {
  if (recording.pts.length < 4) { flash('점을 4개 이상 찍어 주세요', 3000, 'warn'); return; }
  cfg.path = (recording.snapped || recording.pts).slice();
  cfg.pathStale = false;
  saveConfig();
  setRecording(false);
  rebuildWorld(false);
};
$('btnSettings').onclick = openSettings;
$('btnSettingsStart').onclick = openSettings;

// ---------- 관람 모드 / 관리자 모드 ----------
// 관람객: 시작 → 카메라 → 정해진 경로로 차가 달리는 걸 봄. 설정(⚙) → 암호 → 관리자 모드(지도·경로·차 크기·속도·높이·설정)
const gate = createAdminGate({
  isBusy: () => recording.active || mapping.active,
  onChange: (on) => {
    if (!on) { // 관람 모드로: 하던 관리 작업은 취소
      if (recording.active) setRecording(false);
      if (mapping.active) setMapping(false);
      $('settings').hidden = true;
    }
    $('versionTag').textContent = `${on ? '관리자 모드' : '관람 모드'} · ${__BUILD_DATE__} 업데이트`;
    flashUntil = 0;
    drawOverlay();
  },
});
const gear = () => (gate.on ? gate.exit() : gate.open());
$('btnGear').onclick = gear;
$('btnGearUI').onclick = gear;
$('btnLeaveAdmin').onclick = () => gate.exit();
$('btnLeaveAdminUI').onclick = () => gate.exit();
$('btnHome').onclick = () => location.reload();
$('versionTag').textContent = `관람 모드 · ${__BUILD_DATE__} 업데이트`;
// 좁은 화면에서 버튼 접기 (이 기기에만 기억)
setupMenuToggle('raim-ar-menu-collapsed');
$('btnFull').onclick = () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
};

// ---------- 시작 ----------
if (!AR) {
  showStartError('마커 인식 라이브러리를 불러오지 못했어요.');
} else {
  rebuildWorld(false);
}
// 사이트에 전시 설정(diorama.json)이 있고 새것이면 불러온다
loadShared(cfg).then((r) => {
  if (r.status !== 'applied') return;
  cfg = r.cfg;
  if (AR) rebuildWorld(false);
  $('sharedMsg').textContent = `전시 설정(${sharedLabel(r.shared)} 저장)을 불러왔어요 · 마커 ${cfg.roadMarkers.length}개`;
});
// AR(WebXR·ARCore)이 되는 기기면 AR 버전을 먼저 권한다
try {
  if (navigator.xr) navigator.xr.isSessionSupported('immersive-ar').then((ok) => { if (ok) $('btnAR').hidden = false; }).catch(() => {});
} catch (e) { /* 무시 */ }
// 숨은 오류가 있으면 화면에 보이게 (현장에서 원인 찾기용)
window.addEventListener('error', (e) => flash(`오류: ${e.message || e}`, 10000, 'warn'));
// 테스트용 진입점
window.__raim = {
  get state() {
    return {
      tracking: havePose && performance.now() - lastRoadSeen < cfg.tracking.lostMs,
      roadCount, barricade, barricadeSeenNow, s: controller && controller.s,
      v: controller && controller.v, carState: controller && controller.state,
      gap: controller && controller.gap, focal, camPose, recPts: recording.pts,
      mapping: mapping.active ? mapping.mapper.status() : null, lastMapResult, roadMarkers: cfg.roadMarkers,
      snapped: recording.snapped, lastSnap, mosaicFrames: mosaic && mosaic.frames, path: cfg.path, carScale: cfg.car.scale, speedScale: cfg.drive.speedScale, admin: gate.on, roadHeight: roadH(), worldZ: world.position.z, cruise: controller && controller.o.cruise, gpu: { ...renderer.info.memory },
    };
  },
  startCamera,
};
