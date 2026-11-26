// AR 세션의 카메라 영상(camera-access)을 작은 크기로 줄여 CPU로 읽어 온다 (마커 인식·차선 영상용).
// getCameraImage()가 주는 텍스처는 그 프레임 안에서만 쓸 수 있어서, 프레임 콜백 안에서 바로 작은 텍스처에 그린다.
// 읽어 오기는 기다리지 않는다: 픽셀을 GPU 버퍼(PBO)로 복사만 걸어 두고(capture), 다음 프레임들에서
// GPU가 끝냈는지 보고 가져온다(poll). 그 자리에서 readPixels로 읽으면 GPU가 밀린 일을 다 끝낼 때까지 화면이 멈춘다.
// three.js와 같은 WebGL 문맥을 쓰므로 capture 뒤에는 renderer.resetState()를 불러 줘야 한다.

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D cam;
uniform float flipY;
in vec2 uv;
out vec4 color;
void main() {
  vec2 t = vec2(uv.x, flipY > 0.5 ? 1.0 - uv.y : uv.y);
  color = texture(cam, t);
}`;

export class XRCameraReader {
  // maxPixels: 줄인 영상의 픽셀 수 한도 (가로·세로 어느 방향으로 들어도 인식 시간이 비슷하도록)
  constructor(gl, maxPixels = 300000) {
    this.gl = gl;
    this.maxPixels = maxPixels;
    this.w = 0; this.h = 0;
    this.flip = false; // 영상 위아래 방향: 마커가 잡히는 쪽으로 자동 결정
    this.flipLocked = false;
    // WebGL2면 기다리지 않고 읽기 (PBO + fence)
    this.async = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.pending = null; // {sync, w, h} 또는 {data, w, h}(바로 읽은 경우)
    this.free = []; // 다 쓴 픽셀 배열 (다시 씀)
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uFlip = gl.getUniformLocation(prog, 'flipY');
    this.uCam = gl.getUniformLocation(prog, 'cam');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.fbo = gl.createFramebuffer();
    this.tex = gl.createTexture();
    this.pbo = this.async ? gl.createBuffer() : null;
  }

  ensureSize(camW, camH) {
    const k = Math.min(1, Math.sqrt(this.maxPixels / (camW * camH)));
    const w = Math.round(camW * k), h = Math.round(camH * k);
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w; this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (this.pbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    this.free = [];
  }

  // 픽셀 배열 하나 꺼내기 / 다 쓴 배열 돌려주기 (인식 워커로 넘겼다 돌아온 배열도 다시 씀)
  take() { return this.free.pop() || new Uint8ClampedArray(this.w * this.h * 4); }
  recycle(arr) { if (arr && arr.length === this.w * this.h * 4 && this.free.length < 3) this.free.push(arr); }

  // 이번 프레임의 카메라 영상을 줄여 그리고 읽기를 건다. binding: XRWebGLBinding, view: XRView (view.camera 필요)
  // 반환: 읽기를 걸었으면 true. 결과는 poll()로 받는다 (한 번에 하나만)
  capture(binding, view) {
    const cam = view.camera;
    if (!cam || this.pending) return false;
    const camTex = binding.getCameraImage(cam);
    if (!camTex) return false;
    const gl = this.gl;
    this.ensureSize(cam.width, cam.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, camTex);
    gl.uniform1i(this.uCam, 0);
    // readPixels는 아래쪽 행부터 주므로, 영상 위쪽이 프레임버퍼 아래(0행)에 오도록 그린다
    gl.uniform1f(this.uFlip, this.flip ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (this.async) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.pending = { sync, w: this.w, h: this.h };
    } else {
      const data = this.take();
      gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.pending = { data, w: this.w, h: this.h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  // 걸어 둔 읽기가 끝났으면 {width, height, data}(위쪽이 0행), 아직이면 null
  poll() {
    const p = this.pending;
    if (!p) return null;
    if (p.data) { this.pending = null; return { width: p.w, height: p.h, data: p.data }; }
    const gl = this.gl;
    const st = gl.clientWaitSync(p.sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(p.sync);
    this.pending = null;
    if (st === gl.WAIT_FAILED || p.w !== this.w || p.h !== this.h) return null;
    const data = this.take();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { width: p.w, height: p.h, data };
  }

  // 걸어 둔 읽기 버리기 (AR이 끝날 때)
  cancel() {
    if (this.pending && this.pending.sync) this.gl.deleteSync(this.pending.sync);
    this.pending = null;
  }

  // 예전 방식(그 자리에서 읽기). 시험·비교용
  read(binding, view) {
    if (!this.capture(binding, view)) return null;
    if (this.pending.sync) {
      const gl = this.gl, data = this.take();
      gl.deleteSync(this.pending.sync); this.pending = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      return { width: this.w, height: this.h, data };
    }
    return this.poll();
  }

  // 마커 인식 결과로 위아래 방향 정하기: 한쪽에서 계속 안 잡히면 뒤집어 보고, 잡히면 고정
  feedback(found) {
    if (this.flipLocked) return;
    if (found) { this.miss = 0; this.hits = (this.hits || 0) + 1; if (this.hits >= 3) this.flipLocked = true; return; }
    this.hits = 0;
    this.miss = (this.miss || 0) + 1;
    if (this.miss >= 4) { this.flip = !this.flip; this.miss = 0; }
  }
}
