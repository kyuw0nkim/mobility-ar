// 지난 AR 기록: AR이 몇 초 만에 멈춰 버려 화면을 못 읽는 기기를 위해, 1초마다 이 기기에 기록을 남긴다.
// 다음에 시작 화면(관리자)에서 '지난 AR'로 어디까지 갔는지(카메라·첫 인식·위치 맞춤·깊이)와 마지막 몇 초의 프레임 상태를 본다.
const KEY = 'raim-ar-lastrun';

export class RunLog {
  constructor() { this.d = null; }
  // AR 시작. info: 저장해 둘 설정 (가벼운 모드 등)
  start(info) {
    this.t0 = performance.now();
    this.d = { at: Date.now(), ...info, ev: [], secs: [], ended: false, dur: 0 };
    this.cur = { frames: 0, gapMax: 0, js: 0, t0: this.t0, prev: null };
    this.save();
  }
  // 처음 한 번만 남기는 사건 (이름, 덧붙일 글)
  ev(name, note) {
    if (!this.d || this.d.ev.some((e) => e[0] === name)) return;
    this.d.ev.push([name, +((performance.now() - this.t0) / 1000).toFixed(1), note === undefined ? null : note]);
    this.save();
  }
  // 프레임마다: XR 시각 t(ms), 이번 프레임 우리 코드 시간 ms, 덧붙일 상태(1초마다 저장)
  frame(t, ms, extra) {
    const c = this.cur;
    if (!c) return;
    if (c.prev !== null) c.gapMax = Math.max(c.gapMax, t - c.prev);
    c.prev = t; c.frames++; c.js += ms;
    const now = performance.now();
    if (now - c.t0 < 1000) return;
    const d = this.d;
    d.secs.push({ s: Math.round((now - this.t0) / 1000), fps: Math.round(c.frames / ((now - c.t0) / 1000)), gap: Math.round(c.gapMax), js: +(c.js / c.frames).toFixed(1), ...extra() });
    if (d.secs.length > 8) d.secs.shift();
    d.dur = +((now - this.t0) / 1000).toFixed(1);
    c.frames = 0; c.gapMax = 0; c.js = 0; c.t0 = now;
    this.save();
  }
  // 오류 등 여러 번 생길 수 있는 일 (최근 5개)
  note(msg) {
    if (!this.d) return;
    (this.d.notes = this.d.notes || []).push(`${((performance.now() - this.t0) / 1000).toFixed(1)}초 ${msg}`);
    if (this.d.notes.length > 5) this.d.notes.shift();
    this.save();
  }
  end() {
    if (!this.d) return;
    this.d.ended = true;
    this.d.dur = +((performance.now() - this.t0) / 1000).toFixed(1);
    this.save();
    this.d = null; this.cur = null;
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch (e) { /* 무시 */ } }

  // 시작 화면에 보일 글 (없으면 '')
  static describe() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
    if (!d) return '';
    const when = new Date(d.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const names = { camera: '카메라 영상', detect: '첫 인식', aligned: '위치 맞춤', depth: '깊이 인식', car: '차 보임', error: '첫 오류' };
    const ev = d.ev.map(([n, s, note]) => `${names[n] || n} ${s}초${note ? `(${note})` : ''}`).join(' · ') || '아무 단계도 못 감';
    const last = d.secs.slice(-4).map((q) => `${q.s}초: ${q.fps}fps·최대 간격 ${q.gap}ms·JS ${q.js}ms${q.det ? `·인식 ${q.det}ms` : ''}`).join(' / ');
    return `<b>지난 AR</b> (${when}${d.lite ? ', 가벼운 모드' : ''}): ${d.dur}초 동안 · ` +
      (d.ended ? '정상 종료' : '<span style="color:var(--warn)"><b>끝내기 전에 멈춤(또는 강제 종료)</b></span>') +
      `<br>${ev}${last ? `<br><span class="muted">${last}</span>` : ''}` +
      (d.notes && d.notes.length ? `<br><span style="color:var(--warn)">오류: ${d.notes.map((n) => n.replace(/[<>&]/g, '')).join(' / ')}</span>` : '') +
      `<br><span class="muted">기능: ${d.features || '-'}${d.usage ? ` · 깊이 ${d.usage}` : ''}${d.layers ? ' · WebXR 층 있음' : ''}</span>`;
  }
}
