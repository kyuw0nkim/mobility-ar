// 가짜 WebXR(ARCore 흉내): frames.bin의 영상을 카메라 영상(camera-access)으로, meta.json의 뷰 행렬을 ARCore 자세로 준다.
// window.__mockFlip = true면 카메라 텍스처를 위아래 뒤집어 올림(영상 방향 자동 판단 시험)
// window.__mockScene = 'bar'면 바리케이드 장면, window.__mockHold = n이면 한 장면을 n프레임 동안 보여 줌
// window.__mockDepth = true면 깊이 인식(depth-sensing, cpu-optimized)도 줌: depth-<장면>.bin이 있으면 그 깊이,
//   window.__mockDepthFn(nx, ny) → m 를 정하면 그 함수로 (nx, ny: 화면 정규화 좌표, 왼쪽 위 0,0)
// window.__coverageTB: 프레임마다 AR 층의 [화면 위쪽 절반, 아래쪽 절반] 픽셀 수, window.__mockSnapshot(): 카메라 영상 + AR 층 합성 그림(dataURL)
(() => {
  let data = null;
  async function load() {
    if (data) return data;
    const sfx = window.__mockScene ? '-' + window.__mockScene : '';
    const meta = await (await fetch(`xr-mock/meta${sfx}.json`)).json();
    const buf = new Uint8Array(await (await fetch(`xr-mock/frames${sfx}.bin`)).arrayBuffer());
    data = { meta, buf, depth: null };
    if (window.__mockDepth) {
      try {
        const dm = await fetch(`xr-mock/depth${sfx}.json`);
        if (dm.ok) { const { DW, DH } = await dm.json(); data.depth = { DW, DH, buf: new Uint16Array(await (await fetch(`xr-mock/depth${sfx}.bin`)).arrayBuffer()) }; }
      } catch (e) { /* 깊이 없음 */ }
    }
    return data;
  }
  let frameIndex = 0;
  class FakeView {
    constructor(meta, i) {
      const m = new Float32Array(meta.views[i]);
      this.eye = 'none';
      this.transform = { matrix: m, position: { x: m[12], y: m[13], z: m[14], w: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
      this.projectionMatrix = new Float32Array(meta.P);
      this.camera = { width: meta.W, height: meta.H, _i: i };
    }
  }
  class FakeFrame {
    constructor(session, i) { this.session = session; this.i = i; }
    getViewerPose() { const v = new FakeView(data.meta, this.i); window.__lastViewMatrix = Array.from(v.transform.matrix); return { views: [v], emulatedPosition: false }; }
    getHitTestResults() { return window.__mockHits ? window.__mockHits(this.i) : []; }
    getPose(space) { return space && space.matrix ? { transform: { matrix: space.matrix } } : null; }
    // 깊이 인식 (cpu-optimized, luminance-alpha = Uint16 mm). 깊이 지도는 화면과 같은 방향(0행 = 위)이라 변환은 단위 행렬
    getDepthInformation() {
      if (this.session.depthUsage !== 'cpu-optimized') throw new Error('depth-sensing not enabled');
      let W, H, arr;
      if (window.__mockDepthFn) {
        W = 160; H = 100; arr = new Uint16Array(W * H);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) arr[j * W + i] = Math.round(window.__mockDepthFn((i + 0.5) / W, (j + 0.5) / H) * 1000);
      } else if (data.depth) {
        W = data.depth.DW; H = data.depth.DH;
        arr = data.depth.buf.slice(this.i * W * H, (this.i + 1) * W * H);
      } else return null;
      return { width: W, height: H, data: arr.buffer, rawValueToMeters: 0.001, normDepthBufferFromNormView: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } };
    }
  }
  class FakeSession extends EventTarget {
    constructor(opts = {}) {
      super();
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 };
      if (window.__mockLayers) this.renderState.layers = []; // WebXR 층(layers)을 지원하는 Chrome 흉내: three.js가 XRProjectionLayer + binding을 씀
      this.enabledFeatures = ['local', 'viewer', 'camera-access', 'hit-test', 'dom-overlay'];
      this.environmentBlendMode = 'alpha-blend';
      this.inputSources = [];
      this.visibilityState = 'visible';
      this.ended = false;
      if (window.__mockDepth && (opts.optionalFeatures || []).includes('depth-sensing')) {
        this.enabledFeatures.push('depth-sensing');
        this.depthUsage = 'cpu-optimized'; this.depthDataFormat = 'luminance-alpha';
      }
      window.__mockSession = this;
    }
    updateRenderState(s) { Object.assign(this.renderState, s); }
    async requestReferenceSpace(type) { return { type }; }
    async requestHitTestSource() { return { cancel() {} }; }
    requestAnimationFrame(cb) {
      return setTimeout(() => {
        if (this.ended) return;
        let i = Math.floor(frameIndex++ / (window.__mockHold || 1)) % data.meta.N;
        if (window.__mockForceFrame !== undefined) i = window.__mockForceFrame; // 시험: 한 장면에 고정
        window.__mockFrame = i;
        if (this._layer) this._layer.clearForFrame(); // 실제 기기도 매 프레임 빈 AR 층에서 시작
        cb(performance.now(), new FakeFrame(this, i));
        if (this._layer) {
          (window.__coverage = window.__coverage || []).push(this._layer.coverage());
          (window.__coverageTB = window.__coverageTB || []).push(this._layer.lastTB);
        }
      }, 33);
    }
    cancelAnimationFrame(id) { clearTimeout(id); }
    async end() { this.ended = true; this.dispatchEvent(new Event('end')); }
  }
  // 실제 기기처럼 AR 층을 별도 프레임버퍼로 둔다 (화면 캔버스에 그리면 AR 화면에 안 보임)
  class FakeLayer {
    constructor(session, gl) {
      const w = this.framebufferWidth = gl.drawingBufferWidth, h = this.framebufferHeight = gl.drawingBufferHeight;
      this.gl = gl;
      this.framebuffer = gl.createFramebuffer();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.px = new Uint8Array(w * h * 4);
      session._layer = this;
    }
    getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
    clearForFrame() {
      const gl = this.gl, prev = gl.getParameter(gl.FRAMEBUFFER_BINDING), cc = gl.getParameter(gl.COLOR_CLEAR_VALUE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    }
    // 프레임이 끝난 뒤 AR 층에 그려진 픽셀 수 (차·경로·마커 테두리)
    coverage() {
      const gl = this.gl, prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.readPixels(0, 0, this.framebufferWidth, this.framebufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
      let n = 0, top = 0;
      const half = (this.framebufferHeight >> 1) * this.framebufferWidth * 4; // readPixels는 아래 행부터: 뒤쪽 절반이 화면 위
      for (let i = 3; i < this.px.length; i += 16) if (this.px[i] > 0) { n++; if (i >= half) top++; }
      this.lastTB = [top, n - top];
      return n;
    }
    // 카메라 영상 위에 AR 층을 얹은 그림
    snapshot() {
      const gl = this.gl, prev = gl.getParameter(gl.FRAMEBUFFER_BINDING), w = this.framebufferWidth, h = this.framebufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
      const { W, H } = data.meta, fi = window.__mockFrame, cam = data.buf;
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d'), out = g.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = ((h - 1 - y) * w + x) * 4, a = px[o + 3] / 255; // AR 층 (아래 행부터)
        const cx = Math.min(W - 1, Math.floor((x / w) * W)), cy = Math.min(H - 1, Math.floor((y / h) * H));
        const c = (fi * W * H + cy * W + cx) * 4, d = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) out.data[d + k] = px[o + k] + (1 - a) * cam[c + k]; // 미리 곱한 알파
        out.data[d + 3] = 255;
      }
      g.putImageData(out, 0, 0);
      return cv.toDataURL('image/png');
    }
  }
  class FakeBinding {
    constructor(session, gl) { this.gl = gl; this.session = session; this.tex = gl.createTexture(); }
    // WebXR 층 흉내 (window.__mockLayers): 색·깊이 텍스처 한 벌
    createProjectionLayer(init = {}) {
      const gl = this.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, color); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      let depth = null;
      if (init.depthFormat) { depth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, depth); gl.texStorage2D(gl.TEXTURE_2D, 1, init.depthFormat, w, h); }
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { textureWidth: w, textureHeight: h, ignoreDepthValues: false, color, depth, fixedFoveation: 0 };
    }
    getViewSubImage(layer) { return { colorTexture: layer.color, depthStencilTexture: layer.depth, viewport: { x: 0, y: 0, width: layer.textureWidth, height: layer.textureHeight } }; }
    // 실제 Chrome처럼: CPU 방식 깊이 세션에서 GPU 방식 깊이를 읽으면 오류
    getDepthInformation() {
      if (this.session && this.session.depthUsage !== 'gpu-optimized') throw new DOMException('Depth sensing usage is not gpu-optimized', 'InvalidStateError');
      return null;
    }
    getCameraImage(cam) {
      const gl = this.gl, { W, H } = data.meta;
      const px = data.buf.subarray(cam._i * W * H * 4, (cam._i + 1) * W * H * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!window.__mockFlip);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return this.tex;
    }
  }
  window.XRWebGLLayer = FakeLayer;
  window.__mockSnapshot = () => (window.__mockSession && window.__mockSession._layer ? window.__mockSession._layer.snapshot() : null);
  window.XRWebGLBinding = FakeBinding;
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => {}; // 헤드리스에는 XR 장치가 없어 진짜는 실패함
  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === 'immersive-ar',
      requestSession: async (mode, opts) => { await load(); return new FakeSession(opts); },
    },
  });
})();
