// AR 버전: 마커 인식, 노랑·검정 줄무늬 찾기, 경로 기록 중 도로 영상 모으기를 별도 스레드(Web Worker)에서 돌린다.
// 화면 그리기(XR 프레임)와 같은 스레드에서 돌리면 그동안(휴대폰에서 수십 ms) 차가 툭툭 끊긴다.
// 이 파일은 build.mjs가 cv.js·aruco.js(전역 AR)와 이어 붙여 ar.html 안에 글로 넣고, detect-client.js가 Blob 워커로 띄운다.
// detect-client.js의 runHere()가 워커를 못 쓸 때 같은 일을 메인 스레드에서 한다 (processFrame을 함께 씀).
import { findYellowClusters } from './barricade-color.js';
import { RoadMosaic } from './lane.js';
import { findCenterLoop, snapToStripe } from './loop.js';

// 한 프레임 처리. state: {detector, mosaic, covT}. opts: {yellow, acc: {K, pose, area}|null}
export function processFrame(state, img, opts, AR) {
  const t0 = performance.now();
  if (!state.detector) state.detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
  const markers = state.detector.detect(img).map((m) => ({ id: m.id, corners: m.corners.map((p) => ({ x: p.x, y: p.y })) }));
  const yellow = opts.yellow ? findYellowClusters(img, { all: true }) : null;
  let coverage = null;
  if (opts.acc && state.mosaic) {
    state.mosaic.accumulate(img, opts.acc.K, opts.acc.pose);
    // 비춘 범위(%)는 1초에 한 번만 셈
    if (opts.acc.area && t0 - (state.covT || -1e9) > 1000) { state.covT = t0; coverage = state.mosaic.scannedPercent(opts.acc.area); }
  }
  return { markers, yellow, coverage, ms: performance.now() - t0 };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const state = { detector: null, mosaic: null, covT: -1e9 };
  self.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'mosaic') { state.mosaic = new RoadMosaic(d.bounds, d.cell, { grow: !!d.grow }); state.covT = -1e9; return; }
    if (d.type === 'snapPoint') {
      let res;
      try { res = state.mosaic ? snapToStripe(state.mosaic, d.p, d.opts) : { ok: false, reason: 'empty' }; } catch (err) { res = { ok: false, reason: 'error' }; }
      self.postMessage({ id: d.id, res });
      return;
    }
    if (d.type === 'findLoop') {
      let res;
      try { res = state.mosaic ? findCenterLoop(state.mosaic, d.opts) : { ok: false, reason: 'empty' }; } catch (err) { res = { ok: false, reason: 'error', error: String(err && err.message) }; }
      self.postMessage({ id: d.id, res });
      return;
    }
    if (d.type === 'snapshot') {
      const snap = state.mosaic ? state.mosaic.snapshot() : null;
      self.postMessage({ id: d.id, snap }, snap ? [snap.sum.buffer, snap.wsum.buffer] : []);
      return;
    }
    // type: 'detect'
    const img = { width: d.width, height: d.height, data: new Uint8ClampedArray(d.buf) };
    let out;
    try { out = processFrame(state, img, d.opts, self.AR); } catch (err) { out = { markers: [], yellow: null, coverage: null, ms: 0, error: String((err && err.message) || err) }; }
    // 픽셀 배열은 다시 쓰도록 메인 스레드로 돌려보낸다
    self.postMessage({ id: d.id, ...out, buf: d.buf }, [d.buf]);
  };
}
