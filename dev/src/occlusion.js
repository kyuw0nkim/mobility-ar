// 가림 처리 (3단계): ARCore 깊이 인식(WebXR Depth Sensing, cpu-optimized)으로, 실제 물체(건물·돔·게이트·바리케이드·손)보다
// 뒤에 있는 AR 차·경로를 그리지 않는다.
//  1) 매 프레임 frame.getDepthInformation(view)로 깊이 지도(보통 160×90, mm)를 받는다
//  2) 화면 격자(GW×GH)마다 그 자리의 깊이(m)를 읽어 작은 텍스처로 만든다 (normDepthBufferFromNormView로 화면 → 깊이 지도 좌표)
//  3) 차를 그리기 전에 화면 전체 사각형 하나로 그 깊이를 깊이 버퍼에만 쓴다(색은 안 씀). 그러면 실제 물체보다 뒤에 있는 차 조각은 깊이 시험에서 떨어진다
// 깊이 지도는 거칠고 잡음이 있어서, 실제 물체가 margin만큼 확실히 앞에 있을 때만 가린다 (도로 위의 차가 도로 자체에 묻히지 않게).
// 화면 좌표: WebXR '정규화된 화면 좌표'는 왼쪽 위가 (0,0), 오른쪽 아래가 (1,1).
import * as THREE from 'three';

const VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D depthMap; // 화면 격자의 깊이(m), 0 = 모름. 0행 = 화면 위
uniform float p10, p14;      // 투영 행렬 [10], [14]: 깊이(m) → NDC 깊이
uniform float marginAbs, marginRel;
uniform float showDepth;     // 1이면 깊이를 색으로 보여 줌 (현장 확인용)
void main() {
  float d = texture2D(depthMap, vec2(vUv.x, 1.0 - vUv.y)).r;
  if (d <= 0.0) { gl_FragDepth = 1.0; gl_FragColor = vec4(0.0); return; }
  float dd = d + max(marginAbs, d * marginRel);   // 확실히 앞에 있는 것만 가리도록 조금 뒤로
  float ndc = (-p10 * dd + p14) / dd;            // 뷰 공간 z = -dd
  gl_FragDepth = clamp(ndc * 0.5 + 0.5, 0.0, 1.0);
  // 깊이 보기: 가까울수록 빨강, 멀수록 파랑 (반투명)
  float t = clamp((d - 0.2) / 1.8, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0, 0.25, 0.1), vec3(0.1, 0.4, 1.0), t), 0.45 * showDepth);
}`;

export class DepthOcclusion {
  // scene: three.js 장면. gw×gh: 화면 격자 (깊이 지도보다 조금 촘촘하면 충분)
  constructor(scene, { gw = 128, gh = 80 } = {}) {
    this.gw = gw; this.gh = gh;
    this.grid = new Float32Array(gw * gh);
    this.tex = new THREE.DataTexture(this.grid, gw, gh, THREE.RedFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: { depthMap: { value: this.tex }, p10: { value: -1 }, p14: { value: -0.02 }, marginAbs: { value: 0.03 }, marginRel: { value: 0.03 }, showDepth: { value: 0 } },
      depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, colorWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000; // 차보다 먼저
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.status = 'off'; // 'off' | 'unsupported' | 'waiting' | 'on'
    this.size = null; // 깊이 지도 크기 [w, h]
  }

  // 화면에 깊이를 색으로 보이기 (관리자 확인용)
  setShowDepth(on) { this.mat.uniforms.showDepth.value = on ? 1 : 0; this.mat.colorWrite = on; this.mat.needsUpdate = true; }
  setMargin(abs, rel) { this.mat.uniforms.marginAbs.value = abs; this.mat.uniforms.marginRel.value = rel; }

  // 매 프레임 (XR 프레임 콜백 안). enabled가 아니거나 깊이를 못 받으면 가리지 않음
  update(frame, view, { enabled = true, supported = true, format = 'luminance-alpha' } = {}) {
    this.mesh.visible = false;
    if (!enabled) { this.status = 'off'; return; }
    if (!supported || typeof frame.getDepthInformation !== 'function') { this.status = 'unsupported'; return; }
    let di = null;
    try { di = frame.getDepthInformation(view); } catch (e) { di = null; }
    if (!di || !di.data || !di.width) { this.status = 'waiting'; return; }
    const W = di.width, H = di.height, k = di.rawValueToMeters;
    const raw = format === 'float32' ? new Float32Array(di.data) : new Uint16Array(di.data);
    const M = di.normDepthBufferFromNormView.matrix; // 열 우선 4×4: 화면(정규화) → 깊이 지도(정규화)
    const { gw, gh, grid } = this;
    for (let j = 0; j < gh; j++) {
      const ny = (j + 0.5) / gh;
      for (let i = 0; i < gw; i++) {
        const nx = (i + 0.5) / gw;
        const u = M[0] * nx + M[4] * ny + M[12], v = M[1] * nx + M[5] * ny + M[13];
        const ix = Math.floor(u * W), iy = Math.floor(v * H);
        grid[j * gw + i] = ix < 0 || iy < 0 || ix >= W || iy >= H ? 0 : raw[iy * W + ix] * k;
      }
    }
    this.tex.needsUpdate = true;
    const P = view.projectionMatrix;
    this.mat.uniforms.p10.value = P[10];
    this.mat.uniforms.p14.value = P[14];
    this.mesh.visible = true;
    this.status = 'on';
    this.size = [W, H];
  }
}

// AR 세션 요청에 넣을 깊이 인식 옵션 (지원하지 않는 기기에서는 그냥 무시됨)
export const DEPTH_REQUEST = {
  optional: 'depth-sensing',
  depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
};

// three.js(r170)는 'depth-sensing'이 켜져 있으면 매 프레임 GPU 깊이(XRWebGLBinding)를 읽으려 하는데,
// 안드로이드(레이어 없음)에서는 그 binding이 없어 오류가 난다 → three.js에는 깊이 인식이 꺼진 것처럼 보이게 한다
export function hideDepthFromThree(session) {
  const f = session.enabledFeatures;
  if (!f || !f.includes('depth-sensing')) return f || [];
  try { Object.defineProperty(session, 'enabledFeatures', { value: f.filter((x) => x !== 'depth-sensing'), configurable: true }); } catch (e) { /* 무시 */ }
  return f;
}
