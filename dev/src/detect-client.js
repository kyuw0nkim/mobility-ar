// 마커 인식·색 찾기·도로 영상 모으기를 워커(detect-worker.js)에 맡긴다. 워커를 못 띄우면 예전처럼 이 스레드에서 돌린다.
import { processFrame } from './detect-worker.js';
import { RoadMosaic } from './lane.js';

// ar.html 안에 글로 들어 있는 워커 소스 (build.mjs가 넣음)
const SOURCE_IDS = ['aruco-cv', 'aruco-lib', 'detect-worker'];

export class DetectClient {
  constructor() {
    this.worker = null;
    this.waiting = new Map(); // id → resolve
    this.seq = 0;
    this.local = { detector: null, mosaic: null, covT: -1e9 }; // 워커 없이 돌 때의 상태
    this.mosaicSpec = null;
    this.error = null;
    try {
      const parts = SOURCE_IDS.map((id) => { const el = document.getElementById(id); return el ? el.textContent : null; });
      if (typeof Worker !== 'undefined' && parts.every(Boolean)) {
        const url = URL.createObjectURL(new Blob([parts.join('\n;\n')], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        this.worker.onmessage = (e) => this.done(e.data);
        this.worker.onerror = (e) => { e.preventDefault(); this.fail(e.message || 'worker error'); };
      }
    } catch (e) {
      this.worker = null;
    }
  }
  get mode() { return this.worker ? 'worker' : 'main'; }

  // 도로 영상(차선 맞추기·자동 경로용)을 새로 시작. spec: RoadMosaic.specForMarkers() 결과
  resetMosaic(spec) {
    this.mosaicSpec = spec;
    if (this.worker) this.worker.postMessage({ type: 'mosaic', bounds: spec.bounds, cell: spec.cell });
    else this.local.mosaic = new RoadMosaic(spec.bounds, spec.cell);
  }
  // 지금까지 모은 도로 영상 (RoadMosaic). 워커에서는 복사본을 받아 옴
  async mosaic() {
    if (!this.worker) return this.local.mosaic;
    const r = await this.call({ type: 'snapshot' });
    return r && r.snap ? RoadMosaic.fromSnapshot(r.snap) : null;
  }

  // img: {width, height, data: Uint8ClampedArray}. 워커로 넘기면 data는 이 스레드에서 비워진다(옮김) — 결과의 data를 다시 쓴다.
  // opts: {yellow: bool, acc: {K, pose, area}|null(도로 영상 모으기)}
  // 반환: Promise<{markers:[{id, corners:[{x,y}]}], yellow|null, coverage|null, ms, data, error}> (워커가 죽으면 null)
  async run(img, opts) {
    if (!this.worker) return this.runHere(img, opts);
    const r = await this.call({ type: 'detect', width: img.width, height: img.height, buf: img.data.buffer, opts }, [img.data.buffer]);
    if (!r) return null;
    return { ...r, data: new Uint8ClampedArray(r.buf) };
  }
  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
  done(d) {
    const resolve = this.waiting.get(d.id);
    if (!resolve) return;
    this.waiting.delete(d.id);
    resolve(d);
  }
  // 워커가 죽으면 이후는 이 스레드에서 (보낸 영상은 돌아오지 않으니 그 프레임은 버림, 모은 도로 영상도 새로 시작)
  fail(msg) {
    this.error = msg;
    try { this.worker.terminate(); } catch (e) { /* 무시 */ }
    this.worker = null;
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    if (this.mosaicSpec) this.resetMosaic(this.mosaicSpec);
  }
  runHere(img, opts) {
    try {
      return { ...processFrame(this.local, img, opts, window.AR), data: img.data, error: null };
    } catch (e) {
      return { markers: [], yellow: null, coverage: null, ms: 0, data: img.data, error: String((e && e.message) || e) };
    }
  }
}
