// 가짜 WebXR(ARCore 흉내): frames.bin의 영상을 카메라 영상(camera-access)으로, meta.json의 뷰 행렬을 ARCore 자세로 준다.
// window.__mockFlip = true면 카메라 텍스처를 위아래 뒤집어 올림(영상 방향 자동 판단 시험)
// window.__mockScene = 'bar'면 바리케이드 장면, window.__mockHold = n이면 한 장면을 n프레임 동안 보여 줌
(() => {
  let data = null;
  async function load() {
    if (data) return data;
    const sfx = window.__mockScene ? '-' + window.__mockScene : '';
    const meta = await (await fetch(`xr-mock/meta${sfx}.json`)).json();
    const buf = new Uint8Array(await (await fetch(`xr-mock/frames${sfx}.bin`)).arrayBuffer());
    data = { meta, buf };
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
  }
  class FakeSession extends EventTarget {
    constructor() {
      super();
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 };
      this.enabledFeatures = ['local', 'viewer', 'camera-access', 'hit-test', 'dom-overlay'];
      this.environmentBlendMode = 'alpha-blend';
      this.inputSources = [];
      this.visibilityState = 'visible';
      this.ended = false;
      window.__mockSession = this;
    }
    updateRenderState(s) { Object.assign(this.renderState, s); }
    async requestReferenceSpace(type) { return { type }; }
    async requestHitTestSource() { return { cancel() {} }; }
    requestAnimationFrame(cb) {
      return setTimeout(() => {
        if (this.ended) return;
        const i = Math.floor(frameIndex++ / (window.__mockHold || 1)) % data.meta.N;
        window.__mockFrame = i;
        if (this._layer) this._layer.clearForFrame(); // 실제 기기도 매 프레임 빈 AR 층에서 시작
        cb(performance.now(), new FakeFrame(this, i));
        if (this._layer) (window.__coverage = window.__coverage || []).push(this._layer.coverage());
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
      let n = 0;
      for (let i = 3; i < this.px.length; i += 16) if (this.px[i] > 0) n++;
      return n;
    }
  }
  class FakeBinding {
    constructor(session, gl) { this.gl = gl; this.tex = gl.createTexture(); }
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
  window.XRWebGLBinding = FakeBinding;
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => {}; // 헤드리스에는 XR 장치가 없어 진짜는 실패함
  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === 'immersive-ar',
      requestSession: async () => { await load(); return new FakeSession(); },
    },
  });
})();
