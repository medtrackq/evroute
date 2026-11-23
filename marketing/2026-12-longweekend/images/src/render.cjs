// node render.cjs [name ...]  → screenshots ../<name>-<w>x<h>.png
// cloud: Playwright from /opt/node-tools · deviceScaleFactor 1 · waits for fonts (base.js sets window.__ready)
const path = require('path');
let pw; try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright'); }
const JOBS = [
  ['G1-nan', 1080, 1350],
  ['G1-alt-ubon-lunch', 1080, 1350],
  ['G2-cold-pair', 1080, 1350],
  ['G2-cold-pair-square', 1080, 1080],
  ['G3-1-ubon-go', 1080, 1350],
  ['G3-2-ubon-back', 1080, 1350],
  ['G3-story-back', 1080, 1920],
  ['G4-chiangrai-2days', 1080, 1350],
];
(async () => {
  const only = process.argv.slice(2);
  const browser = await pw.chromium.launch();
  for (const [name, w, h] of JOBS) {
    if (only.length && !only.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(__dirname, name + '.html'), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    const check = await page.evaluate(() => {
      const thai = [...document.fonts].some(f => f.family.includes('Noto Sans Thai') && f.status === 'loaded');
      const c = document.querySelector('.canvas').getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('.canvas *')) {
        const r = el.getBoundingClientRect(); if (!r.width) continue;
        if (r.right > c.right + 0.5 || r.bottom > c.bottom + 0.5) bad.push(el.className || el.tagName);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') bad.push('clip:' + (el.className || el.tagName));
      }
      const foot = document.querySelector('.foot').getBoundingClientRect();
      return { thai, footBottom: Math.round(foot.bottom), h: Math.round(c.bottom), bad: [...new Set(bad)].slice(0, 8) };
    });
    const out = path.join(__dirname, '..', `${name}-${w}x${h}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(name, JSON.stringify(check), '→', path.basename(out));
    await page.close();
  }
  await browser.close();
})();
