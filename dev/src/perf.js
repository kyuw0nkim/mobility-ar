// AR 화면 끊김 측정: 프레임 간격(끊김 = 100ms 넘게 다음 프레임이 안 옴), 프레임마다 우리 코드가 쓴 시간,
// 화면 스레드가 50ms 넘게 막힌 일(long task). 5초씩 묶어 요약한다 (관리자 디버그 줄 · 시험용 state.perf).
export class PerfMonitor {
  constructor({ windowMs = 5000, hitchMs = 100 } = {}) {
    this.windowMs = windowMs; this.hitchMs = hitchMs;
    this.long = 0; this.longMax = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { this.long++; this.longMax = Math.max(this.longMax, e.duration); } }).observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 지원 안 하는 브라우저 */ }
    this.reset();
  }
  reset() {
    this.prev = null;
    this.hitchTotal = 0;
    this.last = null; // 지난 5초 요약
    this.startWindow(performance.now());
  }
  startWindow(now) {
    this.w = { t0: now, frames: 0, gapMax: 0, hitches: 0, js: 0, jsMax: 0, long0: this.long };
    this.longMax = 0;
  }
  // 프레임 시작 (XR 프레임 시각 t, ms)
  frame(t) {
    const w = this.w;
    if (this.prev !== null) {
      const gap = t - this.prev;
      if (gap > w.gapMax) w.gapMax = gap;
      if (gap > this.hitchMs) { w.hitches++; this.hitchTotal++; }
    }
    this.prev = t;
    w.frames++;
  }
  // 이번 프레임에 우리 코드가 쓴 시간 (ms)
  work(ms) {
    const w = this.w;
    w.js += ms;
    if (ms > w.jsMax) w.jsMax = ms;
    const now = performance.now();
    if (now - w.t0 >= this.windowMs) {
      const secs = (now - w.t0) / 1000;
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      this.last = {
        fps: +(w.frames / secs).toFixed(1), gapMax: Math.round(w.gapMax), hitches: w.hitches, hitchTotal: this.hitchTotal,
        js: +(w.js / Math.max(1, w.frames)).toFixed(1), jsMax: +w.jsMax.toFixed(1), long: this.long - w.long0, longMax: Math.round(this.longMax), heapMB: mem,
      };
      this.startWindow(now);
    }
  }
  // 디버그 줄에 붙일 짧은 글
  text() {
    const s = this.last;
    if (!s) return '';
    return ` · 끊김 ${s.hitches}회/5초(최대 ${s.gapMax}ms) · JS ${s.js}ms(최대 ${s.jsMax})${s.long ? ` · 막힘 ${s.long}회` : ''}${s.heapMB !== null ? ` · ${s.heapMB}MB` : ''}`;
  }
}
