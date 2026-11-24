// node render.cjs            → ../card-front-bleed.png · ../card-back-bleed.png · ../card-preview.png · ../card-a4-front.pdf · ../card-a4-back.pdf
// node render.cjs --guides DIR → bleed PNGs with trim (red) + 4 mm safe (cyan) lines into DIR, for checking only
// cloud: Playwright from /opt/node-tools · deviceScaleFactor 1 · waits for fonts (card.js sets window.__ready)
// PNGs get 300 dpi in the file (ImageMagick) so the print shop opens them at 96×61 mm
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
let pw; try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright'); }
const OUT = path.join(__dirname, '..');
const gi = process.argv.indexOf('--guides'), GUIDES = gi > -1 ? path.resolve(process.argv[gi + 1]) : null;
const JOBS = [
  ['card-front-bleed', 1134, 720, 'png'],
  ['card-back-bleed', 1134, 720, 'png'],
  ['card-preview', 1820, 636, 'png'],
  ['card-a4-front', 794, 1123, 'pdf'],
  ['card-a4-back', 794, 1123, 'pdf'],
];

// every glyph line and every QR must sit inside its card's .safe box; text lines of different blocks must not touch
function check() {
  const bad = [];
  const blockOf = n => { let e = n.parentElement; while (e && getComputedStyle(e).display === 'inline') e = e.parentElement; return e; };
  document.querySelectorAll('.ec').forEach((card, ci) => {
    const s = card.querySelector('.safe').getBoundingClientRect();
    const items = [];
    const w = document.createTreeWalker(card.querySelector('.safe'), NodeFilter.SHOW_TEXT);
    for (let t; (t = w.nextNode());) {
      if (!t.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(t);
      for (const q of r.getClientRects()) items.push({ q, b: blockOf(t), txt: t.textContent.trim().slice(0, 24) });
    }
    card.querySelectorAll('svg.qr').forEach(e => items.push({ q: e.getBoundingClientRect(), b: e, txt: 'QR' }));
    const tol = 0.5;
    for (const it of items) {
      const q = it.q;
      if (q.left < s.left - tol || q.right > s.right + tol || q.top < s.top - tol || q.bottom > s.bottom + tol) bad.push(`card${ci} outside safe: ${it.txt}`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j]; if (a.b === b.b || a.b.contains(b.b) || b.b.contains(a.b)) continue;
      // line boxes include leading; shrink a little so neighbouring lines that only share leading are fine
      const ix = Math.min(a.q.right, b.q.right) - Math.max(a.q.left, b.q.left);
      const iy = Math.min(a.q.bottom, b.q.bottom) - Math.max(a.q.top, b.q.top);
      if (ix > 1 && iy > 6) bad.push(`card${ci} overlap: "${a.txt}" × "${b.txt}"`);
    }
    card.querySelectorAll('.safe *').forEach(e => { if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth) bad.push(`card${ci} clipped: ${e.className || e.tagName}`); });
  });
  const thai = [...document.fonts].some(f => f.family.includes('Noto Sans Thai') && f.status === 'loaded');
  const inter = [...document.fonts].some(f => f.family.includes('Inter') && f.status === 'loaded');
  return { cards: document.querySelectorAll('.ec').length, thai, inter, bad: [...new Set(bad)].slice(0, 12) };
}

(async () => {
  const browser = await pw.chromium.launch();
  for (const [name, w, h, kind] of JOBS) {
    if (GUIDES && !name.endsWith('-bleed')) continue;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(__dirname, name + '.html'), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    if (GUIDES) await page.evaluate(() => document.body.classList.add('guides'));
    const res = await page.evaluate(check);
    let out;
    if (kind === 'png') {
      out = path.join(GUIDES || OUT, name + '.png');
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
      if (!GUIDES && name.endsWith('-bleed')) execFileSync('convert', [out, '-units', 'PixelsPerInch', '-density', '300', 'PNG24:' + out]);
    } else {
      out = path.join(OUT, name + '.pdf');
      await page.pdf({ path: out, width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: '1' });
      // Chromium rounds the page to 595.92 × 841.92 pt (210.23 × 297.01 mm). Set the MediaBox to exact A4
      // (595.27559 × 841.88977 pt) with a same-length string so the xref offsets stay valid; content is not moved
      // (top-left origin), so the 15 mm / 11 mm margins become exact on both sheets
      const buf = fs.readFileSync(out), s = buf.toString('latin1');
      const m = s.match(/\/MediaBox \[0 0 (\d+\.\d+) (\d+\.\d+)\]/g) || [];
      let fixed = s;
      for (const box of m) {
        const [, w0, h0] = box.match(/\[0 0 (\S+) (\S+)\]/);
        if (Math.abs(w0 - 595.276) > 1.5 || Math.abs(h0 - 841.89) > 1.5) throw new Error('unexpected page size ' + box);
        const exact = '/MediaBox [0 0 ' + (595.27559).toFixed(w0.split('.')[1].length) + ' ' + (841.88977).toFixed(h0.split('.')[1].length) + ']';
        if (exact.length !== box.length) throw new Error('MediaBox length changed: ' + box + ' → ' + exact);
        fixed = fixed.split(box).join(exact);
      }
      fs.writeFileSync(out, Buffer.from(fixed, 'latin1'));
    }
    console.log(name, JSON.stringify(res), '→', path.relative(path.join(__dirname, '..', '..', '..', '..'), out));
    await page.close();
  }
  await browser.close();
})();
