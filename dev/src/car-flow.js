// 관람객 흐름: [시작하기] → 도안 두 장 스캔(① 겉모습, ② 앞·뒤와 실내, 순서 상관없음) → 3D 미리보기 → [이 차로 달리기] → AR
//  - 화면 위 진행 단계: 1 겉모습 → 2 앞·뒤와 실내 → 3 나만의 차 확인 (찍은 쪽은 ✓, 지금 할 단계는 진하게)
//  - 큰 안내 카드: 제목(무엇을) + 설명(어떻게) + 작은 도안 그림(카메라에서 찾은 모서리 무늬가 초록)
//  - 표식 번호로 어느 차(PBV·로보택시·배송 트럭)의 몇 쪽인지 알아서, 아무 장이나 먼저 비춰도 된다
//  - 한 장만 찍고 [이 장만으로 만들기]를 누르면 나머지 쪽은 빈 도안 그림으로
// 카메라(getUserMedia)는 미리보기로 넘어갈 때 끈다 (AR이 시작될 때 ARCore가 카메라를 써야 해서).
import * as THREE from 'three';
import { sheetMarkers, sheetHomography, rectify, normalizeColors, scanImage, MARKER_MAP } from './car-scan.js';
import { CAR_TEMPLATES } from './car-templates.js';
import { paintCar } from './car-paint.js';
import { makeDrawnCar, carEnvironment } from './car-model.js';
import { disposeObject } from './scene.js';

const $ = (id) => document.getElementById(id);
const DET_W = 960; // 찾기용 축소 영상 폭
const AUTO_FRAMES = 4; // 표식이 4개 이만큼 이어서 보이고 흔들림이 작으면 저절로 찍음
const PAGE_NAME = { ext: '① 겉모습', int: '② 앞·뒤와 실내' };
export const DEFAULT_VEHICLE = 'taxi';
const STEPS = ['겉모습', '앞·뒤와 실내', '나만의 차 확인'];
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// 진행 단계 표시. states: 단계마다 'done' | 'current' | 'todo'
export function stepperHtml(states) {
  return '<ol class="stepper">' + STEPS.map((label, i) => {
    const s = states[i];
    return `<li class="st ${s}"${s === 'current' ? ' aria-current="step"' : ''}><span class="st-dot">${s === 'done' ? CHECK : i + 1}</span>` +
      `<span class="st-label"><small>${i + 1}단계</small>${label}</span>${s === 'done' ? '<span class="sr-only">(완료)</span>' : ''}</li>`;
  }).join('') + '</ol>';
}
// 표식(종이 위 자리) → 작은 도안 그림의 모서리 번호 (0 왼쪽 위, 1 오른쪽 위, 2 오른쪽 아래, 3 왼쪽 아래)
function cornerOf(id) {
  const c = MARKER_MAP.get(id).c[0];
  const left = c[0] < 105, top = c[1] < 148.5;
  return top ? (left ? 0 : 1) : (left ? 3 : 2);
}

export function createCarFlow({ getAR, onRun, onBack }) {
  let stream = null, timer = null, detector = null, busy = false;
  let last = null, steady = 0, prevCenters = null, lastKey = null;
  let scan = { vehicle: null, ext: null, int: null }; // 찍은 쪽 (펴진 캔버스)
  let painted = null; // 미리보기·AR에 쓰는 그림 (paintCar 결과)
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const video = $('scanVideo'), overlay = $('scanOverlay');

  // 안내 카드: title = 무엇을 할지(크게), sub = 어떻게(작게)
  const guide = (title, sub = '', ok = false) => {
    if ($('scanGuide').textContent !== title) $('scanGuide').textContent = title;
    if ($('scanSub').textContent !== sub) $('scanSub').textContent = sub;
    $('scanGuide').classList.toggle('ok', ok);
  };
  // 찾은 모서리 무늬를 작은 도안 그림·종이 자리에 표시
  let shownCorners = '';
  function showCorners(markers, ready) {
    const on = new Set(markers.map((m) => cornerOf(m.id)));
    const key = [...on].sort().join() + (ready ? '!' : '');
    if (key === shownCorners) return;
    shownCorners = key;
    for (const el of document.querySelectorAll('#scanSheet .mk')) el.classList.toggle('on', on.has(+el.dataset.c));
    $('scanSheet').classList.toggle('hunt', on.size < 4);
    $('scanFrame').classList.toggle('ready', !!ready);
  }
  const ensureDetector = () => {
    const AR = getAR();
    if (AR && !detector) detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
    return detector;
  };
  const captured = () => ['ext', 'int'].filter((p) => scan[p]);
  function showProgress() {
    const v = scan.vehicle && CAR_TEMPLATES[scan.vehicle];
    // 지금 할 단계: 아직 안 찍은 쪽 중 앞의 것 (순서는 상관없지만 ①부터 권함)
    const next = ['ext', 'int'].find((p) => !scan[p]);
    $('scanSteps').innerHTML = stepperHtml([...['ext', 'int'].map((p) => (scan[p] ? 'done' : p === next ? 'current' : 'todo')), 'todo']);
    $('scanChip').hidden = !v;
    $('scanChip').textContent = v ? `${v.name} 도안` : '';
    $('scanSkip').textContent = captured().length ? '이 장만으로 만들기' : '기본 차로 달리기';
  }
  const HOW = '네 모서리의 검은 무늬 4개가\n모두 보이게 비춰 주세요';
  function idleGuide() {
    const have = captured();
    if (!have.length) guide('도안 한 장을 비춰 주세요', `${HOW}\n어느 장부터 해도 괜찮아요`);
    else guide(`좋아요! 이제 ${PAGE_NAME[have[0] === 'ext' ? 'int' : 'ext']} 장을 비춰 주세요`, HOW, true);
  }

  // ── 스캔 화면 ──
  async function open() {
    scan = { vehicle: null, ext: null, int: null }; painted = null;
    $('start').hidden = true; $('preview').hidden = true; $('scan').hidden = false;
    $('scanShot').disabled = true;
    last = null; steady = 0; prevCenters = null; busy = false; lastKey = null;
    shownCorners = null; showCorners([], false);
    showProgress(); clearOverlay();
    if (!ensureDetector()) { guide('표식 인식 라이브러리를 불러오지 못했어요', '[기본 차로 달리기]로 계속할 수 있어요'); return; }
    guide('카메라를 켜는 중이에요…', '잠깐만 기다려 주세요');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      stream = null;
      guide('카메라를 열 수 없어요', '카메라 사용을 허용했는지 확인해 주세요\n[기본 차로 달리기]로 계속할 수도 있어요');
      return;
    }
    if ($('scan').hidden) { stopCamera(); return; } // 그사이 나감
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 자동 재생 실패해도 프레임은 옴 */ }
    idleGuide();
    loop();
  }
  function stopCamera() {
    clearTimeout(timer); timer = null;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
  }
  function close() { stopCamera(); $('scan').hidden = true; }

  function loop() {
    timer = setTimeout(loop, 120);
    if (busy || !stream || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, sc = Math.max(1, vw / DET_W);
    small.width = Math.round(vw / sc); small.height = Math.round(vh / sc);
    sctx.drawImage(video, 0, 0, small.width, small.height);
    const found = sheetMarkers(detector.detect(sctx.getImageData(0, 0, small.width, small.height)), sc);
    const hm = sheetHomography(found.markers);
    drawOverlay(found.markers, vw, vh);
    const key = found.vehicle ? `${found.vehicle}/${found.page}` : null;
    const centers = found.markers.map((m) => [m.id, (m.c[0][0] + m.c[2][0]) / 2, (m.c[0][1] + m.c[2][1]) / 2]);
    const moved = prevCenters && key === lastKey && centers.length === prevCenters.length
      ? Math.max(...centers.map(([id, x, y]) => { const p = prevCenters.find((q) => q[0] === id); return p ? Math.hypot(x - p[1], y - p[2]) : 1e9; })) : 1e9;
    prevCenters = centers; lastKey = key;
    const ready = hm && hm.ok;
    $('scanShot').disabled = !ready;
    if (ready) last = { found, sc };
    const n = found.markers.length;
    showCorners(found.markers, n === 4 && ready);
    if (!n) { steady = 0; idleGuide(); return; }
    const already = scan[found.page] && scan.vehicle === found.vehicle;
    const what = `${CAR_TEMPLATES[found.vehicle].name} ${PAGE_NAME[found.page]}`;
    if (already) { steady = 0; guide(`${what}은 이미 찍었어요`, '다른 장을 비춰 주세요\n다시 찍으려면 [찍기]를 눌러요', true); return; }
    if (n === 4 && ready && moved < vw * 0.012) steady++; else steady = 0;
    if (n === 4) guide(`${what}을 찾았어요!`, steady ? '그대로 잠깐만 들고 있으면 저절로 찍혀요' : '흔들리지 않게 잠깐만 멈춰 주세요', true);
    else if (n === 3) guide(`${what} · 무늬 3개를 찾았어요`, '하나 더 보이게 하거나 [찍기]를 눌러요', true);
    else guide('네 모서리가 모두 보이게 비춰 주세요', `${what} · 무늬 ${n}개를 찾았어요 (4개 필요)\n종이를 조금 더 멀리 두고 비춰 보세요`);
    if (steady >= AUTO_FRAMES) capture();
  }
  function clearOverlay() { const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height); }
  // 찾은 표식을 화면(영상은 object-fit: cover)에 초록 사각형으로
  function drawOverlay(found, vw, vh) {
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    const s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    ctx.lineWidth = 4; ctx.strokeStyle = '#3ddc84'; ctx.fillStyle = 'rgba(61,220,132,.25)';
    for (const m of found) {
      ctx.beginPath();
      m.c.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * s, oy + y * s) : ctx.moveTo(ox + x * s, oy + y * s)));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  // 찍기: 원본 해상도로 다시 찾아 펴기
  async function capture() {
    if (busy || !stream || !last) return;
    busy = true; steady = 0;
    guide('찍었어요!', '그림을 반듯하게 펴는 중이에요…', true);
    $('scanShot').disabled = true;
    await new Promise((r) => setTimeout(r, 30)); // 안내가 먼저 보이게
    const vw = video.videoWidth, vh = video.videoHeight;
    const full = document.createElement('canvas');
    full.width = vw; full.height = vh;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(video, 0, 0);
    const img = fctx.getImageData(0, 0, vw, vh);
    let found = sheetMarkers(detector.detect(img), 1);
    let hm = sheetHomography(found.markers);
    if (!hm || !hm.ok || found.vehicle !== last.found.vehicle || found.page !== last.found.page) { found = last.found; hm = sheetHomography(found.markers); }
    const flat = rectify(img, hm.H, 4);
    normalizeColors(flat);
    await addPage(found.vehicle, found.page, toCanvas(flat));
    busy = false;
  }
  function toCanvas(flat) {
    const cv = document.createElement('canvas');
    cv.width = flat.width; cv.height = flat.height;
    cv.getContext('2d').putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
    return cv;
  }
  // 한 장을 받음: 다른 차 도안이면 새로 시작. 두 장이 다 모이면 미리보기
  async function addPage(vehicle, page, cv) {
    if (scan.vehicle && scan.vehicle !== vehicle) {
      scan = { vehicle: null, ext: null, int: null };
      guide(`${CAR_TEMPLATES[vehicle].name} 도안으로 새로 시작해요`, '', true);
    }
    scan.vehicle = vehicle; scan[page] = cv;
    showProgress();
    if (scan.ext && scan.int) await finish();
    else idleGuide();
  }
  async function finish() {
    const vehicle = scan.vehicle || DEFAULT_VEHICLE;
    guide('나만의 차를 만드는 중이에요…', '잠깐만 기다려 주세요', true);
    painted = await paintCar(vehicle, { ext: scan.ext, int: scan.int });
    close();
    openPreview(!!(scan.ext || scan.int));
  }
  // ── 미리보기 ──
  let pv = null;
  function openPreview(scanned) {
    $('start').hidden = true; $('scan').hidden = true; $('preview').hidden = false;
    const v = CAR_TEMPLATES[painted.vehicle];
    $('previewTitle').textContent = scanned ? `나만의 ${v.name} 완성!` : `기본 ${v.name}로 달려요`;
    $('goMsg').textContent = '';
    $('previewSteps').innerHTML = stepperHtml([scan.ext ? 'done' : 'todo', scan.int ? 'done' : 'todo', 'current']);
    for (const p of ['ext', 'int']) {
      const c = $(p === 'ext' ? 'previewFlat' : 'previewFlat2');
      c.width = 420; c.height = 594;
      c.getContext('2d').drawImage(painted[p], 0, 0, c.width, c.height);
    }
    $('previewFlatWrap').hidden = !scanned;
    startPreview3D();
  }
  function startPreview3D() {
    stopPreview3D();
    // 앞 미리보기가 GPU 연결(컨텍스트)을 돌려준 캔버스는 다시 못 쓰니 새 캔버스로 바꿈
    const oldCv = $('previewCanvas'), canvas = document.createElement('canvas');
    canvas.id = 'previewCanvas';
    oldCv.replaceWith(canvas);
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { return; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.localClippingEnabled = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-2, -3, 6); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.up.set(0, 0, 1);
    const car = makeDrawnCar({ length: 10 }, painted, { envMap: carEnvironment(renderer) });
    scene.add(car);
    const H = car.userData.shape.H;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(8, 48), new THREE.MeshBasicMaterial({ color: 0x00448b, transparent: true, opacity: 0.08 }));
    scene.add(disc);
    pv = { renderer, scene, camera, car, raf: 0, open: 0, target: 0, t0: performance.now(), last: 0 };
    const frame = () => {
      pv.raf = requestAnimationFrame(frame);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio())) renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      const now = performance.now(), t = (now - pv.t0) / 1000, ang = (pv.fixAng ?? (-2.1 + t * 0.4));
      const dt = Math.min(0.1, (now - (pv.last || now)) / 1000); pv.last = now;
      // 안쪽 보기: 카메라가 차 위로 다가가며 지붕이 사라짐 (AR에서 가까이 갈 때와 같음)
      pv.open += (pv.target - pv.open) * Math.min(1, dt * 4);
      if (Math.abs(pv.target - pv.open) < 0.01) pv.open = pv.target;
      const r = 24 - pv.open * 8, z = 7 + pv.open * 8;
      camera.position.set(Math.cos(ang) * r, Math.sin(ang) * r, z);
      camera.lookAt(0, 0, H * 0.45);
      car.userData.setOpen(pv.open);
      renderer.render(scene, camera);
    };
    frame();
    setInsideButton();
  }
  function stopPreview3D() {
    if (!pv) return;
    cancelAnimationFrame(pv.raf);
    disposeObject(pv.car);
    pv.renderer.dispose();
    try { pv.renderer.forceContextLoss(); } catch (e) { /* 무시 */ }
    pv = null;
  }
  function setInsideButton() { $('btnInside').textContent = pv && pv.target > 0.5 ? '지붕 닫기' : '안쪽 보기'; }
  function closePreview() { stopPreview3D(); $('preview').hidden = true; }

  // ── 버튼 ──
  $('scanShot').onclick = () => capture();
  $('scanSkip').onclick = async () => { if (busy) return; busy = true; try { await finish(); } finally { busy = false; } };
  $('scanBack').onclick = () => { close(); $('start').hidden = false; onBack(); };
  $('btnRescan').onclick = () => { closePreview(); open(); };
  $('btnInside').onclick = () => { if (pv) { pv.target = pv.target > 0.5 ? 0 : 1; setInsideButton(); } };
  $('btnGo').onclick = () => onRun();
  $('previewBack').onclick = () => { closePreview(); $('start').hidden = false; onBack(); };

  return {
    open,
    get painted() { return painted; },
    // AR이 시작되면 미리보기 정리 (GPU 자원을 AR에 돌려줌)
    leave() { closePreview(); close(); },
    reset() { painted = null; scan = { vehicle: null, ext: null, int: null }; },
    // 시험용: 사진(ImageData) 한 장으로 바로 스캔
    async scanImageData(img) {
      if (!ensureDetector()) return { ok: false };
      const res = scanImage(detector, img, 4);
      if (res.ok) await addPage(res.vehicle, res.page, toCanvas(res.image));
      return { ok: res.ok, found: res.found, err: res.err, vehicle: res.vehicle, page: res.page };
    },
    get previewOpen() { return pv ? pv.open : null; },
    // 시험용: 빈 도안 차를 미리보기로, 보는 각도 고정(라디안, null이면 돌기)
    async previewBlank(vehicle) { painted = await paintCar(vehicle); close(); openPreview(false); },
    setPreviewAngle(a) { if (pv) pv.fixAng = a; },
  };
}
