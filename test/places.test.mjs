import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../assets/js/plan.js';
import { parseLatLng, followShort, cleanPlace, mergePlaces, placeId } from '../lib/places.mjs';

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

test('coordinates from a pasted Google Maps link or "lat, lng"', () => {
  // The place pin (!3d!4d) wins over the map centre (@).
  assert.deepEqual(parseLatLng('https://www.google.com/maps/place/Farm+Chokchai/@14.6301,101.3402,15z/data=!4m6!3m5!1s0x0:0x0!8m2!3d14.6339188!4d101.3461978'), { lat: 14.633919, lng: 101.346198 });
  assert.deepEqual(parseLatLng('https://www.google.com/maps/@17.8783,102.7413,14z'), { lat: 17.8783, lng: 102.7413 });
  assert.deepEqual(parseLatLng('https://maps.google.com/?q=16.4322,102.8236'), { lat: 16.4322, lng: 102.8236 });
  assert.deepEqual(parseLatLng(' 14.6339, 101.3462 '), { lat: 14.6339, lng: 101.3462 });
  assert.equal(parseLatLng('https://www.google.com/maps/@48.85,2.35,12z'), null); // not in Thailand
  assert.equal(parseLatLng('ฟาร์มโชคชัย'), null);
});

test('short links are followed on Google hosts only', async () => {
  const hops = { 'https://maps.app.goo.gl/abc': 'https://www.google.com/maps/place/X/@14.63,101.34,15z/data=!3d14.6339!4d101.3462' };
  const fetchFn = async (u) => ({ headers: { get: () => hops[u] || null } });
  assert.deepEqual(parseLatLng(await followShort('https://maps.app.goo.gl/abc', fetchFn)), { lat: 14.6339, lng: 101.3462 });
  let asked = 0;
  await followShort('https://evil.example/abc', async () => { asked++; return { headers: { get: () => null } }; });
  assert.equal(asked, 0);
});

test('a place from the admin form is checked before it is saved', () => {
  const ok = cleanPlace({ name: ' ฟาร์ม  โชคชัย ', name_en: 'Farm Chokchai', cat: ['kids', 'nope'], lat: '14.6339', lng: '101.3462', visit: '90', months: [12, '1', 1, 13], partner: true, link: 'https://example.com/x' });
  assert.equal(ok.id, 'farm-chokchai');
  assert.equal(ok.name, 'ฟาร์ม โชคชัย');
  assert.deepEqual(ok.cat, ['kids']);
  assert.deepEqual(ok.months, [1, 12]);
  assert.equal(ok.partner, true);
  assert.equal(ok.checked, true);
  assert.match(cleanPlace({ ...ok, cat: [] }).error, /ประเภท/);
  assert.match(cleanPlace({ ...ok, lat: 48.8, lng: 2.3 }).error, /ตำแหน่ง/);
  assert.match(cleanPlace({ ...ok, visit: 2 }).error, /เวลาเที่ยว/);
  assert.match(cleanPlace({ ...ok, link: 'javascript:alert(1)' }).error, /https/);
  assert.match(cleanPlace({ ...ok, id: 'Bad Id!' }).error, /id/);
  assert.equal(cleanPlace({ id: 'farm-chokchai', hidden: true }).hidden, true);
  assert.match(placeId('', 0), /^place-/);
});

test('admin rows replace, add to and hide the bundled places', () => {
  const bundled = [{ id: 'a', name: 'A', cat: ['view'], lat: 14, lng: 101, visit: 30 }, { id: 'b', name: 'B', cat: ['food'], lat: 15, lng: 101, visit: 30 }];
  const rows = [
    { id: 'a', name: 'A ใหม่', cat: ['view'], lat: '14.1', lng: '101.1', visit: 45, partner: true, checked: true, hidden: false, promo: null },
    { id: 'b', name: 'B', hidden: true },
    { id: 'c', name: 'C', cat: ['cafe'], lat: 16, lng: 102, visit: 20, partner: false, checked: true, hidden: false },
  ];
  const list = mergePlaces(bundled, rows);
  assert.deepEqual(list.map((p) => p.id), ['a', 'c']);
  assert.equal(list[0].name, 'A ใหม่');
  assert.equal(list[0].lat, 14.1);
  assert.ok(!('promo' in list[0]));
});

