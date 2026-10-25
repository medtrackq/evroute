import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../assets/js/plan.js';

const P = globalThis.EVPlan;

// A straight road due north from (14.0, 101.0), 100 km long, one point per km.
const pts = [], cum = [];
for (let i = 0; i <= 100; i++) { pts.push([14 + i / 110.57, 101]); cum.push(i); }
const prof = { pts, cum };
const east = (km) => 101 + km / (111.32 * Math.cos(14.4 * Math.PI / 180));
const place = (id, along, offKm, cat, visit, extra) => ({ id, lat: 14 + along / 110.57, lng: east(offKm), cat, visit, ...extra });
const stop = { st: { lat: 14 + 50 / 110.57, lng: 101 }, chargeMin: 30 };

test('a place a short walk from a charging stop costs time only if the visit outlasts the charge', () => {
  const near = place('cafe', 50, 0.4, ['cafe'], 20);
  const long = place('farm', 50, 0.6, ['kids'], 90);
  const list = P.placesOnWay(prof, [stop], [near, long], { maxExtra: 0 });
  assert.deepEqual(list.map((x) => x.p.id), ['cafe', 'farm']);
  assert.equal(list[0].stop.i, 0);
  assert.equal(list[0].extra, 0);
  assert.ok(list[1].extra > 50 && list[1].extra < 80, list[1].extra); // 90 min visit + walking, less the charge
});

test('other places are detours, kept when the detour and the visit fit the time allowed', () => {
  const temple = place('temple', 20, 10, ['temple'], 30); // ~39 min there and back + 30
  const onRoad = place('shop', 80, 0.1, ['shop'], 40);
  assert.deepEqual(P.placesOnWay(prof, [], [temple, onRoad], { maxExtra: 60 }).map((x) => x.p.id), ['shop']);
  const all = P.placesOnWay(prof, [], [temple, onRoad], { maxExtra: 240 });
  assert.deepEqual(all.map((x) => x.p.id), ['temple', 'shop']);
  assert.equal(all[1].detourMin, 0);
  assert.equal(Math.round(all[0].detourMin), 39);
  // Already a stop of the trip: kept whatever the time.
  assert.equal(P.placesOnWay(prof, [], [temple], { maxExtra: 0, keep: (p) => p.id === 'temple' }).length, 1);
});

test('kinds, season and distance from the route', () => {
  const lotus = place('lotus', 30, 5, ['view'], 60, { months: [12, 1, 2] });
  const far = place('far', 30, 60, ['view'], 10);
  const opts = { maxExtra: 240, month: () => 11 };
  assert.equal(P.placesOnWay(prof, [], [lotus, far], opts).length, 0);
  assert.equal(P.placesOnWay(prof, [], [lotus], { ...opts, month: () => 1 }).length, 1);
  assert.equal(P.placesOnWay(prof, [], [lotus], { maxExtra: 240, cats: ['temple'] }).length, 0);
});

test('the bundled places are well formed', () => {
  const d = JSON.parse(readFileSync(new URL('../data/trip-places.json', import.meta.url)));
  const ids = new Set();
  for (const p of d.places) {
    assert.ok(/^[a-z0-9-]+$/.test(p.id) && !ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.name && p.lat > 5 && p.lat < 21 && p.lng > 97 && p.lng < 106, p.id);
    assert.ok(p.cat.length && p.cat.every((c) => ['temple', 'cafe', 'food', 'view', 'shop', 'kids'].includes(c)), p.id);
    assert.ok(p.visit > 0, p.id);
  }
});
