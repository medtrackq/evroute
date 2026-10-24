import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cells, quarter, inThailand, sweep } from '../lib/sweep.mjs';
import { networkOf } from '../lib/stations.mjs';

test('Thailand is cut into squares that cover its cities and not its neighbours', () => {
  const list = cells();
  assert.ok(list.length > 300 && list.length < 500, list.length);
  const covered = (lat, lng) => list.some((c) => lat >= c.s && lat < c.n && lng >= c.w && lng < c.e);
  for (const [lat, lng] of [[13.75, 100.5], [18.79, 98.98], [7.88, 98.39], [17.88, 102.74], [6.43, 101.82], [9.5, 100.0]]) assert.ok(covered(lat, lng), lat + ',' + lng);
  assert.ok(!inThailand(11.56, 104.92) && !inThailand(16.84, 96.17)); // Phnom Penh, Yangon
  assert.equal(quarter({ s: 0, w: 0, n: 1, e: 1 }).length, 4);
});

function memoryStore() {
  const s = { runs: [], places: new Map() };
  return {
    s,
    async current() { return s.runs.find((r) => r.status === 'running') || null; },
    async start(n, from = 0) { const r = { id: s.runs.length + 1, cells: n, cursor: from, calls: 0, found: 0, status: 'running' }; s.runs.push(r); return r; },
    async progress(id, p) { Object.assign(s.runs.find((r) => r.id === id), p); },
    async finish(id, p) { const r = s.runs.find((x) => x.id === id); Object.assign(r, p); return r; },
    async save(rows) { rows.forEach((r) => s.places.set(r.place_id, r)); },
  };
}

test('a full answer is asked again in quarters; only id, position and network are kept', async () => {
  const bkk = (c) => c.s <= 13.75 && 13.75 < c.n && c.w <= 100.5 && 100.5 < c.e;
  let n = 0;
  const ask = async (c) => {
    if (!bkk(c)) return [];
    const k = c.n - c.s > 0.3 ? 20 : 3; // the 0.4° square is full, its quarters aren't
    return Array.from({ length: k }, (_, i) => ({ id: 'p' + (n++), name: i % 2 ? 'PTT EV Station PluZ บางนา' : 'EA Anywhere', lat: c.s + 0.01, lng: c.w + 0.01 }));
  };
  const store = memoryStore();
  const r = await sweep({ ask, store, cap: 5000, networkOf, wait: 0 });
  assert.equal(r.status, 'done');
  assert.equal(r.calls, 2 * (cells().length + 4)); // both passes, each cutting the full square
  assert.equal(store.s.places.size, 2 * (20 + 3)); // only the quarter with the point has places
  const one = [...store.s.places.values()][1];
  assert.deepEqual(Object.keys(one).sort(), ['lat', 'lng', 'op', 'place_id']);
  assert.ok([...store.s.places.values()].some((p) => p.op === 'PTT EV Station PluZ'));
});

test('the cap stops a sweep, and a stopped one carries on where it was', async () => {
  const store = memoryStore();
  const capped = await sweep({ ask: async () => [], store, cap: 25, networkOf, wait: 0 });
  assert.equal(capped.status, 'capped');
  assert.equal(capped.calls, 25);
  // A restart in the middle: the record still says "running" at square 30.
  const store2 = memoryStore();
  store2.s.runs.push({ id: 1, cells: cells().length, cursor: 30, calls: 30, found: 0, status: 'running' });
  let asked = 0;
  const r = await sweep({ ask: async () => { asked++; return []; }, store: store2, cap: 5000, networkOf, wait: 0 });
  assert.equal(asked, 2 * cells().length - 30);
  assert.equal(r.calls, 2 * cells().length);
});

test('the second pass keeps only places whose name says they charge, and a sweep can start at it', async () => {
  const { charges } = await import('../lib/sweep.mjs');
  assert.equal(charges('PTT EV Station PluZ บางนา'), true);
  assert.equal(charges('สถานีชาร์จ EV ปตท. สระบุรี'), true);
  assert.equal(charges('ปตท. สาขาวังน้อย'), false); // a fuel station without chargers
  const store = memoryStore();
  const seen = new Set();
  const r = await sweep({
    ask: async (c) => { seen.add(c.pass); return c.pass === 'name' && c.s < 6 ? [{ id: 'x', name: 'ปตท. ปั๊ม', lat: 5.7, lng: 101 , keep: false }] : []; },
    store, cap: 5000, networkOf, from: cells().length, wait: 0,
  });
  assert.deepEqual([...seen], ['name']);
  assert.equal(r.calls, cells().length);
  assert.equal(store.s.places.size, 0);
});
