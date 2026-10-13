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
