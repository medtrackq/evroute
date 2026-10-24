import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareMeta } from '../lib/share.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const meta = (h, p) => h.match(new RegExp('<meta (?:property|name)="' + p + '" content="([^"]*)"'))[1];

test('the home page previews with full URLs', () => {
  const h = shareMeta(html, 'https://evroute.onrender.com', new URL('https://x/?ref=tiktok&fbclid=abc'));
  assert.equal(meta(h, 'og:image'), 'https://evroute.onrender.com/assets/og.png');
  assert.equal(meta(h, 'og:url'), 'https://evroute.onrender.com/'); // where the visitor came from is not part of the link
  assert.match(meta(h, 'og:title'), /วางแผนชาร์จ EV/);
});

test('a shared trip previews with its own name, in the link language, escaped', () => {
  const u = new URL('https://x/?from=13.7,100.5&fn=' + encodeURIComponent('กรุงเทพฯ') + '&to=18.7,98.9&tn=' + encodeURIComponent('เชียงใหม่ "<b>"') + '&lang=en');
  const h = shareMeta(html, 'https://evroute.onrender.com', u);
  assert.equal(meta(h, 'og:title'), 'กรุงเทพฯ → เชียงใหม่ &quot;&lt;b&gt;&quot; · EV charging plan | EVROUTE');
  assert.equal(meta(h, 'og:image'), 'https://evroute.onrender.com/assets/og-en.png');
  assert.match(meta(h, 'og:url'), /^https:\/\/evroute\.onrender\.com\/\?from=13\.7/);
  assert.equal(meta(h, 'og:locale'), 'en_GB');
});
