import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../assets/js/plan.js';
import '../assets/js/cars.js';
import { fromOSM, merge } from '../lib/stations.mjs';

const P = globalThis.EVPlan;
const car = (id, extra) => ({ ...globalThis.EVCars.find((c) => c.id === id), margin: 10, ...extra });
const trip = JSON.parse(readFileSync(new URL('./fixtures/bkk-cnx.json', import.meta.url))).trip;
const prof = P.profile(trip.legs);

// Fake DC stations every 60 km along the route, 1 km off the road.
function stationsEvery(stepKm, kw = 120) {
  const out = [];
  for (let d = stepKm; d < prof.km; d += stepKm) {
    let i = prof.cum.findIndex((c) => c >= d);
    const [lat, lng] = prof.pts[i];
    out.push({ id: 's' + d, name: 'S' + d, op: 'Test', lat: lat + 0.009, lng, plugs: [{ type: 'CCS2', kw, n: 2, dc: true }] });
  }
  return out;
}

test('profile matches Valhalla distance and time', () => {
  assert.ok(Math.abs(prof.km - trip.summary.length) / trip.summary.length < 0.01, prof.km);
  assert.ok(Math.abs(prof.min - trip.summary.time / 60) / (trip.summary.time / 60) < 0.05, prof.min);
});

test('speed factor grows with speed', () => {
  assert.ok(P.speedFactor(120) > P.speedFactor(90));
  assert.ok(P.speedFactor(90) > P.speedFactor(50));
});

test('charge time tapers above 80%', () => {
  const low = P.chargeMinutes(20, 50, 100, 60), high = P.chargeMinutes(70, 100, 100, 60);
  assert.ok(high > low * 1.5, `${low} ${high}`);
  assert.equal(P.chargeMinutes(50, 40, 100, 60), 0);
});

test('a 700 km trip needs a stop even in a long-range car', () => {
  const c = car('tesla-m3-lr');
  const r = P.plan(prof, P.candidates(prof, stationsEvery(60), c), c, { startSoc: 100, minSoc: 10, targetSoc: 80 });
  // 700 km at ~16 kWh/100km is ~110+ kWh, more than 75 kWh: needs at least one stop.
  assert.ok(r.ok);
  assert.ok(r.stops.length >= 1);
});

test('Bangkok to Chiang Mai: every leg stays above the minimum', () => {
  const c = car('byd-atto3-std');
  const cands = P.candidates(prof, stationsEvery(60), c);
  const r = P.plan(prof, cands, c, { startSoc: 90, minSoc: 20, targetSoc: 80 });
  assert.ok(r.ok, JSON.stringify(r.fail));
  assert.ok(r.stops.length >= 2 && r.stops.length <= 6, r.stops.length);
  r.stops.forEach((s) => {
    assert.ok(s.arrive >= 20 - 0.01, s.arrive);
    assert.ok(s.depart <= 80 + 0.01 && s.depart > s.arrive);
    assert.ok(s.chargeMin > 0);
  });
  assert.ok(r.arrive >= 20 - 0.01, r.arrive);
  // Stops move forward along the route.
  for (let i = 1; i < r.stops.length; i++) assert.ok(r.stops[i].along > r.stops[i - 1].along);
});

test('reports where it gets stuck when stations are too far apart', () => {
  const c = car('byd-dolphin-std');
  const r = P.plan(prof, P.candidates(prof, stationsEvery(300), c), c, { startSoc: 80, minSoc: 20, targetSoc: 80 });
  assert.equal(r.ok, false);
  assert.ok(r.fail.reach > 100 && r.fail.reach < 300, r.fail.reach);
});

test('a pinned station is used when reachable', () => {
  const c = car('byd-atto3-std');
  const cands = P.candidates(prof, stationsEvery(60), c);
  const first = P.plan(prof, cands, c, { startSoc: 90, minSoc: 20, targetSoc: 80 });
  const k = first.stops.findIndex((s) => s.alts.length);
  assert.ok(k >= 0);
  const alt = first.stops[k].alts[0].c.st.id;
  const r = P.plan(prof, cands, c, { startSoc: 90, minSoc: 20, targetSoc: 80, pinned: [alt] });
  assert.ok(r.ok);
  const s = r.stops.find((x) => x.st.id === alt);
  assert.ok(s && s.pinned);
});

test('connector compatibility', () => {
  const leaf = car('nissan-leaf'), atto = car('byd-atto3-std'), air = car('wuling-air');
  const ccs = { plugs: [{ type: 'CCS2', kw: 120, n: 1, dc: true }, { type: 'Type2', kw: 22, n: 1, dc: false }] };
  const tesla = { plugs: [{ type: 'Tesla', kw: 250, n: 8, dc: true }] };
  assert.equal(P.usable(tesla, car('tesla-my-lr')).kw, 250);
  assert.equal(P.usable(ccs, leaf), null);
  assert.equal(P.usable(ccs, atto).kw, 120);
  assert.equal(P.usable(ccs, air), null);
  assert.equal(P.usable(tesla, atto), null);
});

test('replay follows legs', () => {
  const c = car('byd-atto3-std');
  const out = P.replay(prof, c, 90, []);
  assert.equal(out.length, 1);
  assert.ok(out[0].arrive < 0); // 700 km on one charge is not possible
});

test('OSM tags become plugs, guesses for known networks', () => {
  const a = fromOSM({ type: 'node', id: 1, lat: 13, lon: 100, tags: { amenity: 'charging_station', operator: 'PTT', 'socket:type2_combo': '2', 'socket:type2_combo:output': '120 kW' } });
  assert.deepEqual(a.plugs, [{ type: 'CCS2', kw: 120, n: 2, dc: true }]);
  assert.equal(a.op, 'PTT EV Station PluZ');
  const b = fromOSM({ type: 'node', id: 2, lat: 13, lon: 100, tags: { amenity: 'charging_station', brand: 'EleXA' } });
  assert.equal(b.guess, true);
  assert.equal(b.plugs[0].type, 'CCS2');
  const c = fromOSM({ type: 'node', id: 3, lat: 13, lon: 100, tags: { amenity: 'charging_station', access: 'private' } });
  assert.equal(c, null);
  const m = merge([{ ...b, id: 'x' }], [{ ...a, lat: 13.0005 }]);
  assert.equal(m.length, 1);
  assert.equal(m[0].guess, false);
});

test('bundled OSM snapshot parses', () => {
  const d = JSON.parse(readFileSync(new URL('../data/osm-th.json', import.meta.url)));
  const list = d.elements.map(fromOSM).filter(Boolean);
  assert.ok(list.length > 150, list.length);
});

test('round trip: stations count on both legs, destinations need no charge', async () => {
  const round = JSON.parse(readFileSync(new URL('./fixtures/round-kan.json', import.meta.url))).trip;
  const rp = P.profile(round.legs);
  assert.equal(rp.legEnds.length, 2);
  assert.ok(Math.abs(rp.km - round.summary.length) < 3, rp.km);
  // One station right beside the road half way out (and so half way back too).
  const half = rp.cum.findIndex((c) => c >= rp.cum[rp.legEnds[0]] / 2);
  const [lat, lng] = rp.pts[half];
  const st = [{ id: 'mid', name: 'Mid', op: 'T', lat: lat + 0.002, lng, plugs: [{ type: 'CCS2', kw: 100, n: 2, dc: true }] }];
  const c = car('neta-v'); // ~38 kWh: 328 km needs a charge
  const cands = P.candidates(rp, st, c);
  assert.equal(cands.length, 2);
  assert.ok(cands[1].along > rp.cum[rp.legEnds[0]]);
  const r = P.plan(rp, cands, c, { startSoc: 95, minSoc: 15, targetSoc: 90 });
  assert.ok(r.ok, JSON.stringify(r.fail));
  assert.ok(r.stops.length >= 1);
  // Replay with no charging at the turnaround point.
  const legs = P.replay(rp, c, 95, [null]);
  assert.equal(legs.length, 2);
  assert.ok(legs[1].arrive < legs[0].arrive);
});

test('trip charging time is charge + plug-in only; detours are reported apart', () => {
  const c = car('byd-atto3-std');
  const r = P.plan(prof, P.candidates(prof, stationsEvery(60), c), c, { startSoc: 90, minSoc: 20, targetSoc: 80 });
  const charge = r.stops.reduce((s, x) => s + x.chargeMin + P.PLUG_MIN, 0);
  assert.ok(Math.abs(r.chargeMin - charge) < 1e-9);
  assert.ok(r.detourMin > 0); // fake stations sit ~1 km off the road
});

test('gap points: none when stations are dense, some in long gaps and where a plan fails', () => {
  const c = car('byd-atto3-std');
  const o = { startSoc: 90, minSoc: 20, targetSoc: 80 };
  const dense = P.candidates(prof, stationsEvery(40), c);
  assert.equal(P.gapPoints(prof, dense, c, o, P.plan(prof, dense, c, o)).length, 0);
  const sparse = P.candidates(prof, stationsEvery(300), c);
  const res = P.plan(prof, sparse, c, o);
  const pts = P.gapPoints(prof, sparse, c, o, res);
  assert.ok(pts.length > 0 && pts.length <= 6, pts.length);
  // When stuck, every circle is around where the car runs low.
  pts.forEach((p) => assert.ok(Math.abs(p.along - res.fail.reach) < 200, p.along + ' vs ' + res.fail.reach));
  // A working plan with a long empty stretch asks about that stretch.
  const holey = P.candidates(prof, stationsEvery(40).filter((s) => { const k = +s.id.slice(1); return k < 200 || k > 300; }), c);
  const ok = P.plan(prof, holey, c, { ...o, startSoc: 100, targetSoc: 100, minSoc: 10 });
  const fill = P.gapPoints(prof, holey, c, o, ok);
  assert.ok(fill.length > 0 && fill.every((p) => p.along > 150 && p.along < 340), JSON.stringify(fill.map((p) => Math.round(p.along))));
  pts.forEach((p) => assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng)));
});

test('a favourite station is preferred when it costs little extra time', () => {
  const c = car('byd-atto3-std');
  const o = { startSoc: 90, minSoc: 20, targetSoc: 80 };
  const cands = P.candidates(prof, stationsEvery(30), c);
  const base = P.plan(prof, cands, c, o);
  // Pick a station near (but not at) the first chosen stop and make it a favourite.
  const first = base.stops[0];
  const alt = cands.find((x) => x.st.id !== first.st.id && Math.abs(x.along - first.along) <= 40 && x.along < first.along);
  assert.ok(alt, 'need a nearby alternative');
  const r = P.plan(prof, cands, c, { ...o, favs: { [alt.st.id]: true } });
  assert.ok(r.ok);
  assert.ok(r.stops.some((s) => s.st.id === alt.st.id), r.stops.map((s) => s.st.id).join(','));
});

test('charging cost uses the operator price and off-peak hours', () => {
  const prices = { 'PEA VOLTA': { dc: 6.9, dcOff: 5.9 }, _default: { dc: 7.5 } };
  const weekdayNoon = new Date('2026-10-14T05:00:00Z'); // Wed 12:00 Bangkok
  const weekdayNight = new Date('2026-10-14T16:00:00Z'); // Wed 23:00 Bangkok
  const sunday = new Date('2026-10-18T05:00:00Z');
  assert.equal(P.isOffPeak(weekdayNoon), false);
  assert.equal(P.isOffPeak(weekdayNight), true);
  assert.equal(P.isOffPeak(sunday), true);
  const on = P.chargeCost(27, 'PEA VOLTA', prices, weekdayNoon);
  assert.equal(on.rate, 6.9);
  assert.ok(Math.abs(on.baht - 27 / 0.9 * 6.9) < 1e-9);
  assert.equal(P.chargeCost(27, 'PEA VOLTA', prices, sunday).rate, 5.9);
  const unknown = P.chargeCost(27, 'Someone', prices, weekdayNoon);
  assert.equal(unknown.rate, 7.5);
  assert.equal(unknown.known, false);
  assert.equal(P.chargeCost(0, 'PEA VOLTA', prices, weekdayNoon), null);
});

test('a station with a recent problem report is avoided unless pinned', () => {
  const c = car('byd-atto3-std');
  const o = { startSoc: 90, minSoc: 20, targetSoc: 80 };
  const cands = P.candidates(prof, stationsEvery(30), c);
  const base = P.plan(prof, cands, c, o);
  const bad = base.stops[0].st.id;
  const r = P.plan(prof, cands, c, { ...o, avoid: { [bad]: true } });
  assert.ok(r.ok);
  assert.ok(!r.stops.some((s) => s.st.id === bad), 'should route around ' + bad);
  // The user's own choice wins over the report.
  const pinned = P.plan(prof, cands, c, { ...o, avoid: { [bad]: true }, pinned: [bad] });
  assert.ok(pinned.stops.some((s) => s.st.id === bad));
  // With no other station in reach, the reported one is still used rather than failing.
  const ids = base.stops.map((s) => s.st.id);
  const only = cands.filter((x) => ids.includes(x.st.id)); // just the stations of the first plan: each one is needed
  const free = P.plan(prof, only, c, o);
  const forced = P.plan(prof, only, c, { ...o, avoid: { [bad]: true } });
  assert.ok(free.stops.some((s) => s.st.id === bad), 'the lone station should be needed');
  assert.equal(forced.ok, free.ok);
  assert.deepEqual(forced.stops.map((s) => s.st.id), free.stops.map((s) => s.st.id));
});

test('stops with what the driver wants win when they cost little, food only at meal times', () => {
  const c = car('byd-atto3-std');
  const o = { startSoc: 90, minSoc: 20, targetSoc: 80 };
  const sts = stationsEvery(30);
  sts.forEach((s, i) => { if (i % 3 === 1) s.am = { food: 2, cafe: 1, wc: 1, shop: 0 }; });
  const cands = P.candidates(prof, sts, c);
  const base = P.plan(prof, cands, c, o);
  const cafes = (r) => r.stops.filter((s) => s.st.am && s.st.am.cafe).length;
  const want = P.plan(prof, cands, c, { ...o, want: { cafe: true } });
  assert.ok(want.ok);
  assert.ok(cafes(want) > cafes(base), cafes(want) + ' vs ' + cafes(base));
  assert.ok(want.realMin >= base.realMin - 0.01 && want.realMin - base.realMin < 30, 'little extra time: ' + (want.realMin - base.realMin));
  // Leaving at 03:00, no stop of a short plan falls at a meal time: food changes nothing.
  const night = P.plan(prof, cands, c, { ...o, want: { food: true }, departClock: 3 * 60 });
  const firstClock = night.stops[0].clock;
  assert.ok(firstClock > 180 && firstClock < 24 * 60);
  // Leaving at 09:30 the stops around lunch prefer food, and say which meal.
  const lunch = P.plan(prof, cands, c, { ...o, want: { food: true }, departClock: 9 * 60 + 30 });
  assert.ok(lunch.stops.some((s) => s.meal === 'มื้อกลางวัน'), JSON.stringify(lunch.stops.map((s) => [s.clock, s.meal])));
  assert.equal(P.mealAt(12 * 60), 'มื้อกลางวัน');
  assert.equal(P.mealAt(15 * 60), null);
});

test('alternatives list one entry per site when a site has two pins', () => {
  const c = car('byd-atto3-std');
  const sts = stationsEvery(30);
  // A second pin 100 m from each station, same network.
  sts.slice().forEach((s) => sts.push({ ...s, id: s.id + '-twin', lat: s.lat + 0.0009 }));
  const res = P.plan(prof, P.candidates(prof, sts, c), c, { startSoc: 90, minSoc: 20, targetSoc: 80 });
  for (const s of res.stops) {
    const ids = s.alts.map((a) => a.c.st.id.replace('-twin', ''));
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
    assert.ok(!ids.includes(s.st.id.replace('-twin', '')), 'the stop itself is not offered again');
  }
});
