const { Resvg } = require('@resvg/resvg-js');
const AR = require('js-aruco2').AR;
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const inner = dict.generateSVG(7).replace(/<\/?svg[^>]*>/g,'');
// marker 10 units -> 200px, placed at (100,100) on 400x400 white, plus a red dot near marker top-left cell
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="white"/><g transform="translate(100,100) scale(20)">${inner}</g></svg>`;
const png = new Resvg(svg).render();
const det = new AR.Detector({dictionaryName:'ARUCO_MIP_36h12'});
const m = det.detect({width:png.width,height:png.height,data:png.pixels});
console.log(JSON.stringify(m.map(x=>({id:x.id,c:x.corners}))));
