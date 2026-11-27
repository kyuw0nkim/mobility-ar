// 관람객 흐름: [시작하기] → 도안 스캔(카메라) → 3D 미리보기 → [이 차로 달리기] → AR
// 카메라(getUserMedia)는 미리보기로 넘어갈 때 끈다 (AR이 시작될 때 ARCore가 카메라를 써야 해서).
import * as THREE from 'three';
import { sheetMarkers, sheetHomography, rectify, normalizeColors, scanImage } from './car-scan.js';
import { MARKER_IDS, SHEET } from './car-template.js';
import { makeDrawnCar, defaultCarCanvas, canvasTexture, carShape } from './car-model.js';
import { disposeObject } from './scene.js';

const $ = (id) => document.getElementById(id);
const DET_W = 960; // 찾기용 축소 영상 폭
const AUTO_FRAMES = 4; // 표식 4개가 이만큼 이어서 보이고 흔들림이 작으면 저절로 찍음

export function createCarFlow({ getAR, carColor, onRun, onBack }) {
  let stream = null, timer = null, detector = null, busy = false;
  let last = null, steady = 0, prevCenters = null;
  let carCanvas = null; // 펴서 찍은 도안 (없으면 기본 차)
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const video = $('scanVideo'), overlay = $('scanOverlay');

  const guide = (msg, ok = false) => { $('scanGuide').textContent = msg; $('scanGuide').classList.toggle('ok', ok); };
  const ensureDetector = () => {
    const AR = getAR();
    if (AR && !detector) detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
    return detector;
  };

  // ── 스캔 화면 ──
  async function open() {
    $('start').hidden = true; $('preview').hidden = true; $('scan').hidden = false;
    $('scanShot').disabled = true;
    last = null; steady = 0; prevCenters = null; busy = false;
    clearOverlay();
    if (!ensureDetector()) { guide('표식 인식 라이브러리를 불러오지 못했어요'); return; }
    guide('카메라를 켜는 중이에요…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      stream = null;
      guide('카메라를 열 수 없어요 · [사진 고르기]로 도안 사진을 골라 주세요');
      return;
    }
    if ($('scan').hidden) { stopCamera(); return; } // 그사이 나감
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 자동 재생 실패해도 프레임은 옴 */ }
    guide('도안의 네 모서리 검은 표식이 모두 보이게 비춰 주세요');
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
    const hm = sheetHomography(found);
    drawOverlay(found, vw, vh);
    const centers = found.map((m) => [m.id, (m.c[0][0] + m.c[2][0]) / 2, (m.c[0][1] + m.c[2][1]) / 2]);
    const moved = prevCenters && centers.length === prevCenters.length
      ? Math.max(...centers.map(([id, x, y]) => { const p = prevCenters.find((q) => q[0] === id); return p ? Math.hypot(x - p[1], y - p[2]) : 1e9; })) : 1e9;
    prevCenters = centers;
    const ready = hm && hm.ok;
    $('scanShot').disabled = !ready;
    if (ready) last = { found, sc, vw, vh };
    if (found.length === 4 && ready && moved < vw * 0.012) steady++; else steady = 0;
    const n = found.length;
    if (n === 4) guide(steady ? '좋아요! 그대로 잠깐만 들고 있어요…' : '표식 4개를 찾았어요 · 흔들리지 않게 잠깐만요', true);
    else if (n === 3) guide(`표식 3개를 찾았어요 · 하나 더 보이게 하거나 [찍기]를 눌러요`, true);
    else guide(`도안의 네 모서리 검은 표식이 모두 보이게 비춰 주세요 (${n}/4)`);
    if (steady >= AUTO_FRAMES) capture();
  }
  function clearOverlay() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }
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
    busy = true;
    guide('찍었어요! 그림을 펴는 중이에요…', true);
    $('scanShot').disabled = true;
    await new Promise((r) => setTimeout(r, 30)); // 안내가 먼저 보이게
    const vw = video.videoWidth, vh = video.videoHeight;
    const full = document.createElement('canvas');
    full.width = vw; full.height = vh;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(video, 0, 0);
    const img = fctx.getImageData(0, 0, vw, vh);
    stopCamera();
    let found = sheetMarkers(detector.detect(img), 1);
    let hm = sheetHomography(found);
    if (!hm || !hm.ok) { found = last.found; hm = sheetHomography(found); } // 원본에서 못 찾으면 축소 영상 결과로
    const flat = rectify(img, hm.H, 4);
    normalizeColors(flat);
    showResult(toCanvas(flat));
  }
  function toCanvas(flat) {
    const cv = document.createElement('canvas');
    cv.width = flat.width; cv.height = flat.height;
    cv.getContext('2d').putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
    return cv;
  }
  // 사진 고르기 (카메라를 못 쓰는 기기, 또는 미리 찍어 둔 사진)
  async function fromFile(file) {
    if (!file || !ensureDetector()) return;
    busy = true;
    guide('사진에서 도안을 찾는 중이에요…', true);
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
      const res = scanImage(detector, ctx.getImageData(0, 0, cv.width, cv.height), 4);
      if (!res.ok) { guide(`사진에서 표식을 ${res.found.length}개만 찾았어요 · 네 모서리가 모두 보이게 다시 찍어 주세요`); return; }
      stopCamera();
      showResult(toCanvas(res.image));
    } catch (e) {
      guide('사진을 읽지 못했어요 · 다른 사진을 골라 주세요');
    } finally { busy = false; }
  }

  // ── 미리보기 ──
  let pv = null; // { renderer, scene, camera, car, raf, open, target }
  function showResult(cv) {
    carCanvas = cv;
    close();
    openPreview(true);
  }
  function openPreview(scanned) {
    $('start').hidden = true; $('scan').hidden = true; $('preview').hidden = false;
    $('previewTitle').textContent = scanned ? '나만의 차가 완성됐어요!' : '기본 차로 달려요';
    $('goMsg').textContent = '';
    const flatCv = $('previewFlat');
    const src = carCanvas || defaultCarCanvas(carColor());
    flatCv.width = 594; flatCv.height = 420;
    flatCv.getContext('2d').drawImage(src, 0, 0, flatCv.width, flatCv.height);
    $('previewFlatWrap').hidden = !scanned;
    startPreview3D(src);
  }
  function startPreview3D(src) {
    stopPreview3D();
    const canvas = $('previewCanvas');
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { return; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-2, -3, 6); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.up.set(0, 0, 1);
    const car = makeDrawnCar({ length: 10 }, canvasTexture(src));
    scene.add(car);
    const { W, H } = carShape(10);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(8, 48), new THREE.MeshBasicMaterial({ color: 0x00448b, transparent: true, opacity: 0.08 }));
    scene.add(disc);
    pv = { renderer, scene, camera, car, raf: 0, open: 0, target: 0, t0: performance.now(), W, H };
    const frame = () => {
      pv.raf = requestAnimationFrame(frame);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio())) renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      const now = performance.now(), t = (now - pv.t0) / 1000, ang = -0.9 + t * 0.45;
      const dt = Math.min(0.1, (now - (pv.last || now)) / 1000); pv.last = now;
      // 안쪽 보기: 카메라가 차 위로 다가가며 지붕이 사라짐 (AR에서 가까이 갈 때와 같음)
      pv.open += (pv.target - pv.open) * Math.min(1, dt * 4);
      if (Math.abs(pv.target - pv.open) < 0.01) pv.open = pv.target;
      const r = 24 - pv.open * 9, z = 9 + pv.open * 6;
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
  $('scanPhoto').onclick = () => $('scanFile').click();
  $('scanFile').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; fromFile(f); };
  $('scanSkip').onclick = () => { carCanvas = null; close(); openPreview(false); };
  $('scanBack').onclick = () => { close(); $('start').hidden = false; onBack(); };
  $('btnRescan').onclick = () => { closePreview(); open(); };
  $('btnInside').onclick = () => { if (pv) { pv.target = pv.target > 0.5 ? 0 : 1; setInsideButton(); } };
  $('btnGo').onclick = () => onRun();
  $('previewBack').onclick = () => { closePreview(); $('start').hidden = false; onBack(); };

  return {
    open,
    get canvas() { return carCanvas; },
    // AR이 시작되면 미리보기 정리 (GPU 자원을 AR에 돌려줌)
    leave() { closePreview(); close(); },
    reset() { carCanvas = null; },
    // 시험용: 사진(ImageData)으로 바로 스캔
    scanImageData(img) {
      if (!ensureDetector()) return { ok: false };
      const res = scanImage(detector, img, 4);
      if (res.ok) showResult(toCanvas(res.image));
      return { ok: res.ok, found: res.found, err: res.err };
    },
    get previewOpen() { return pv ? pv.open : null; },
    sheetSize: SHEET, markerIds: MARKER_IDS,
  };
}
