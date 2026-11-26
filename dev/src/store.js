// 설정 저장 (마커 버전·AR 버전이 같은 브라우저 저장소를 함께 씀)
import { DEFAULT_CONFIG } from './config.js';

export const STORE_KEY = 'raim-ar-marker-config-v1';
export function clone(o) { return JSON.parse(JSON.stringify(o)); }
export function mergeDeep(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? mergeDeep(base[k], over[k]) : over[k];
  return out;
}
export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return mergeDeep(clone(DEFAULT_CONFIG), JSON.parse(raw));
  } catch (e) { /* 저장소 사용 불가 */ }
  return clone(DEFAULT_CONFIG);
}
export function storeConfig(cfg) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* 무시 */ }
}

// ---------- 전시 설정 (여러 태블릿이 함께 쓰는 값) ----------
// 한 기기에서 [전시 설정 내보내기]로 diorama.json을 받아 사이트(저장소 맨 위 폴더)에 올리면,
// 모든 기기가 앱을 열 때 자동으로 불러온다. 파일의 savedAt이 바뀌었을 때만 다시 덮어쓴다
// (그 전까지 기기에서 바꾼 값은 유지). 기기마다 다른 카메라 보정값(tracking)은 공유하지 않는다.
export const SHARED_KEYS = ['roadMarkers', 'path', 'pathStale', 'roadHeight', 'car', 'drive', 'barricade', 'lane', 'barricadeTracking'];
export const SHARED_URL = 'diorama.json';
const APPLIED_KEY = 'raim-ar-shared-applied';

export function makeShared(cfg) {
  const out = { kind: 'raim-diorama', savedAt: new Date().toISOString() };
  for (const k of SHARED_KEYS) if (k in cfg) out[k] = clone(cfg[k]);
  return out;
}
export function applyShared(cfg, shared) {
  const out = clone(cfg);
  for (const k of SHARED_KEYS) {
    if (!(k in shared)) continue;
    const base = DEFAULT_CONFIG[k];
    out[k] = base && typeof base === 'object' && !Array.isArray(base) ? mergeDeep(clone(base), shared[k]) : clone(shared[k]);
  }
  return out;
}
function validShared(s) {
  return s && s.kind === 'raim-diorama' && typeof s.savedAt === 'string' && Array.isArray(s.roadMarkers) && s.roadMarkers.length > 0 &&
    s.roadMarkers.every((m) => Number.isFinite(m.id) && Number.isFinite(m.x) && Number.isFinite(m.y) && m.size > 0) &&
    Array.isArray(s.path);
}
// 반환: {status: 'none'|'bad'|'same'|'applied', cfg?, shared?}
export async function loadShared(cfg, { force = false } = {}) {
  let res;
  try { res = await fetch(SHARED_URL, { cache: 'no-cache' }); } catch (e) { return { status: 'none' }; }
  if (!res.ok) return { status: 'none' };
  let shared;
  try { shared = await res.json(); } catch (e) { return { status: 'bad' }; }
  if (!validShared(shared)) return { status: 'bad' };
  let applied = null;
  try { applied = localStorage.getItem(APPLIED_KEY); } catch (e) { /* 무시 */ }
  if (!force && applied === shared.savedAt) return { status: 'same', shared };
  const next = applyShared(cfg, shared);
  storeConfig(next);
  try { localStorage.setItem(APPLIED_KEY, shared.savedAt); } catch (e) { /* 무시 */ }
  return { status: 'applied', cfg: next, shared };
}
export function downloadShared(cfg) {
  const blob = new Blob([JSON.stringify(makeShared(cfg), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'diorama.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function sharedLabel(shared) {
  const d = new Date(shared.savedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? shared.savedAt : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
