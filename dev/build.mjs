// 단일 HTML 파일로 빌드 (외부 네트워크 없이 동작): dist/index.html(AR 버전 = 사이트 첫 화면), dist/marker.html(마커 버전)
// node build.mjs --publish 이면 저장소 맨 위 폴더(사이트로 배포되는 곳)의 index.html·marker.html도 바꾼다
// (예전 주소 /ar.html은 vercel.json에서 첫 화면(/)으로 보냄)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';

const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const cv = esc(readFileSync('node_modules/js-aruco2/src/cv.js', 'utf8'));
const aruco = esc(readFileSync('node_modules/js-aruco2/src/aruco.js', 'utf8'));
mkdirSync('dist', { recursive: true });

const BUILD_DATE = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
const bundle = async (entry) => {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome100'],
    write: false,
    legalComments: 'none',
    define: { __BUILD_DATE__: JSON.stringify(BUILD_DATE) },
  });
  return esc(res.outputFiles[0].text);
};

// AR 버전의 인식 워커: 실행하지 않는 글(text/plain)로 넣고, 앱이 위의 aruco 스크립트 글과 이어 붙여 Blob 워커로 띄운다
const workerJs = await bundle('src/detect-worker.js');
// 관람객·관리자 공통 디자인 (Autonomous Mobility Tour 토큰)
const theme = readFileSync('src/theme.css', 'utf8');
// 글꼴·사진: dist/assets (사이트에서는 저장소 맨 위 assets/)
mkdirSync('dist/assets', { recursive: true });
const ASSETS = [['node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2', 'PretendardVariable.woff2'],
  ...readdirSync('assets').map((f) => [`assets/${f}`, f])];
for (const [src, name] of ASSETS) copyFileSync(src, `dist/assets/${name}`);

for (const [entry, page, out, worker] of [['src/app.js', 'src/index.html', 'dist/marker.html', false], ['src/ar-app.js', 'src/ar.html', 'dist/index.html', true]]) {
  const appJs = await bundle(entry);
  let html = readFileSync(page, 'utf8');
  html = html.replace('/*THEME*/', () => theme);
  html = html.replace('<!--ARUCO-->', () => `<script id="aruco-cv">\n${cv}\n</script>\n<script id="aruco-lib">\n${aruco}\n</script>` +
    (worker ? `\n<script type="text/plain" id="detect-worker">\n${workerJs}\n</script>` : ''));
  html = html.replace('<!--APP-->', () => `<script>\n${appJs}\n</script>`);
  writeFileSync(out, html);
  console.log(out, (html.length / 1024).toFixed(0) + ' KB');
}

if (process.argv.includes('--publish')) {
  for (const f of ['index.html', 'marker.html']) copyFileSync(`dist/${f}`, `../${f}`);
  mkdirSync('../assets', { recursive: true });
  for (const [, name] of ASSETS) copyFileSync(`dist/assets/${name}`, `../assets/${name}`);
  console.log('../index.html(AR), ../marker.html(마커), ../assets/ 갱신');
}
