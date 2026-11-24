// node verify-qr.cjs WORKDIR  → decodes the QR from the delivered files and compares with the link, character by character
// needs npm "jsqr" + "pngjs" (NODE_PATH=/path/to/node_modules), poppler pdftoppm, ImageMagick convert
// checks: both bleed PNGs · both halves of card-preview.png · all 10 cards on each A4 PDF (rasterised 300 dpi and 150 dpi)
//         · bleed PNGs shrunk to 35 % and blurred (rough stand-in for a phone camera further away)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const jsQR = require('jsqr'), { PNG } = require('pngjs');
const WANT = 'https://evroute.info/?ref=card-station';
const IMG = path.join(__dirname, '..'), WORK = path.resolve(process.argv[2] || '.');
fs.mkdirSync(WORK, { recursive: true });

const load = f => PNG.sync.read(fs.readFileSync(f));
function crop(png, x, y, w, h) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(png.data.subarray(((y + r) * png.width + x) * 4, ((y + r) * png.width + x + w) * 4), r * w * 4);
  return { data: out, width: w, height: h };
}
let fails = 0;
function test(label, img) {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  const ok = !!r && r.data === WANT;
  if (!ok) fails++;
  let diff = '';
  if (r && !ok) for (let i = 0; i < Math.max(r.data.length, WANT.length); i++) if (r.data[i] !== WANT[i]) { diff = ` first difference at char ${i}`; break; }
  const px = r ? Math.round(Math.hypot(r.location.topRightCorner.x - r.location.topLeftCorner.x, r.location.topRightCorner.y - r.location.topLeftCorner.y)) : 0;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(44)} ${r ? JSON.stringify(r.data) : 'no QR found'}${r ? ` · v${r.version} · finder-to-finder ${px}px` : ''}${diff}`);
}

// 1 · bleed PNGs as delivered
for (const f of ['card-front-bleed.png', 'card-back-bleed.png']) { const p = load(path.join(IMG, f)); test(f, { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }); }
// 2 · preview halves
{ const p = load(path.join(IMG, 'card-preview.png')); test('card-preview.png (front half)', crop(p, 0, 0, p.width / 2, p.height)); test('card-preview.png (back half)', crop(p, p.width / 2, 0, p.width / 2, p.height)); }
// 3 · A4 PDFs → raster → each card slot (grid at 15 mm / 11 mm, 90×55 mm)
for (const side of ['front', 'back']) for (const dpi of [300, 150]) {
  const base = path.join(WORK, `a4-${side}-${dpi}`);
  execFileSync('pdftoppm', ['-r', String(dpi), '-png', '-singlefile', path.join(IMG, `card-a4-${side}.pdf`), base], { stdio: ['ignore', 'ignore', 'ignore'] });
  const p = load(base + '.png'), k = dpi / 25.4;
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const c = i % 2, r = Math.floor(i / 2);
    const img = crop(p, (15 + c * 90) * k, (11 + r * 55) * k, 90 * k, 55 * k);
    const d = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (d && d.data === WANT) ok++; else { fails++; console.log(`FAIL card-a4-${side}.pdf @${dpi}dpi card ${i + 1}: ${d ? JSON.stringify(d.data) : 'no QR'}`); }
  }
  console.log(`${ok === 10 ? 'OK  ' : 'FAIL'} ${`card-a4-${side}.pdf @${dpi} dpi`.padEnd(44)} ${ok}/10 cards decode to ${JSON.stringify(WANT)}`);
}
// 4 · harder copies of the bleed PNGs
for (const f of ['card-front-bleed', 'card-back-bleed']) {
  const out = path.join(WORK, f + '-small-blur.png');
  execFileSync('convert', [path.join(IMG, f + '.png'), '-resize', '35%', '-blur', '0x0.8', out]);
  const p = load(out); test(f + ' shrunk 35% + blur', { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height });
}
console.log(fails ? `\n${fails} FAILED` : `\nall decodes match ${WANT} exactly (${WANT.length} characters)`);
process.exit(fails ? 1 : 0);
