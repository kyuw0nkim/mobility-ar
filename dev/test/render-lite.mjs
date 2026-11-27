// lookAt만 따로 (render.mjs는 시트 SVG가 있어야 불러와짐)
export function lookAt(pos, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const L = Math.hypot(...a); return a.map((v) => v / L); };
  const z = norm(sub(target, pos));
  const x = norm(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  const t = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { R, t };
}
