// 단일 HTML 파일로 빌드 (외부 네트워크 없이 동작): dist/index.html(마커 버전), dist/ar.html(AR 버전)
// node build.mjs --publish 이면 저장소 맨 위 폴더(사이트로 배포되는 곳)의 index.html·ar.html도 바꾼다
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const cv = esc(readFileSync('node_modules/js-aruco2/src/cv.js', 'utf8'));
const aruco = esc(readFileSync('node_modules/js-aruco2/src/aruco.js', 'utf8'));
mkdirSync('dist', { recursive: true });

const bundle = async (entry) => {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome100'],
    write: false,
    legalComments: 'none',
  });
  return esc(res.outputFiles[0].text);
};

// AR 버전의 인식 워커: 실행하지 않는 글(text/plain)로 넣고, 앱이 위의 aruco 스크립트 글과 이어 붙여 Blob 워커로 띄운다
const workerJs = await bundle('src/detect-worker.js');

for (const [entry, page, out, worker] of [['src/app.js', 'src/index.html', 'dist/index.html', false], ['src/ar-app.js', 'src/ar.html', 'dist/ar.html', true]]) {
  const appJs = await bundle(entry);
  let html = readFileSync(page, 'utf8');
  html = html.replace('<!--ARUCO-->', () => `<script id="aruco-cv">\n${cv}\n</script>\n<script id="aruco-lib">\n${aruco}\n</script>` +
    (worker ? `\n<script type="text/plain" id="detect-worker">\n${workerJs}\n</script>` : ''));
  html = html.replace('<!--APP-->', () => `<script>\n${appJs}\n</script>`);
  writeFileSync(out, html);
  console.log(out, (html.length / 1024).toFixed(0) + ' KB');
}

if (process.argv.includes('--publish')) {
  for (const f of ['index.html', 'ar.html']) copyFileSync(`dist/${f}`, `../${f}`);
  console.log('../index.html, ../ar.html 갱신');
}
