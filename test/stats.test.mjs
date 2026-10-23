import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, cleanPlan, cleanCharge, supabase } from '../lib/stats.mjs';

const plan = {
  pid: 'abc123', cu: 'c-7f3k9x2m', car: 'byd-atto3-std', brand: 'BYD', model: 'Atto 3 Standard', kwh: 49.9, use: 17.5, useBase: 16.5, dc: 70, tuned: true,
  soc: 80, min: 20, target: 80, fromLat: 13.75634, fromLng: 100.50177, toLat: 18.7834, toLng: 100.7789,
  dests: 1, round: false, km: 668.4, driveMin: 540, chargeMin: 95, stops: 3, kwhTotal: 75, cost: 520, arrive: 19, ok: true, google: 5,
  stations: [{ id: 'g:xyz', op: 'PTT EV Station PluZ', src: 'google', kw: 50, guess: true, pinned: false, arrive: 22, depart: 71, kwh: 24.5, min: 40, baht: 166 }],
  ip: '1.2.3.4', name: 'Somchai',
};

test('a plan keeps only whitelisted fields and coarse trip ends', () => {
  const [table, row] = record({ t: 'plan', d: plan });
  assert.equal(table, 'plans');
  assert.equal(row.car_id, 'byd-atto3-std');
  assert.equal(row.car_uid, 'c-7f3k9x2m');
  assert.equal(cleanPlan({ ...plan, cu: 'someone@example.com' }).car_uid, null); // only our own format
  assert.equal(row.use_set, 17.5);
  assert.equal(row.use_factory, 16.5);
  assert.equal(row.from_lat, 13.8);
  assert.equal(row.from_lng, 100.5);
  assert.equal(row.stations.length, 1);
  assert.equal(row.stations[0].baht, 166);
  assert.ok(!('ip' in row) && !('name' in row));
  assert.ok(!JSON.stringify(row).includes('Somchai'));
});

test('bad input is dropped or nulled', () => {
  assert.equal(record({ t: 'nope', d: {} }), null);
  assert.equal(record({ t: 'event', d: { kind: 'hack' } }), null);
  assert.equal(cleanPlan({ car: 'x' }), null); // no plan id
  const row = cleanPlan({ ...plan, soc: 900, fromLat: 51.5, brand: { $ne: 1 }, stations: 'x' });
  assert.equal(row.start_soc, null);
  assert.equal(row.from_lat, null);
  assert.equal(row.brand, null);
  assert.deepEqual(row.stations, []);
  assert.equal(cleanPlan({ ...plan, car: 'a b; drop table' }), null);
});

test('a charge report needs a station and whether it worked', () => {
  assert.equal(cleanCharge({ sid: 'cur:1' }), null);
  const ok = cleanCharge({ sid: 'cur:1', lat: 14.981004, lng: 100.357671, ok: true, socFrom: 20, socTo: 80, kwh: '30', baht: 210, odo: 12345.6, problem: 'queue' });
  assert.equal(ok.kwh, 30);
  assert.equal(ok.station_lat, 14.981);
  assert.equal(ok.station_lng, 100.35767);
  assert.equal(ok.problem, null); // only kept when charging failed
  assert.equal(ok.odometer, 12346);
  const bad = cleanCharge({ sid: 'cur:1', ok: false, problem: 'whatever', note: 'x'.repeat(500) });
  assert.equal(bad.problem, 'other');
  assert.equal(bad.note.length, 200);
  assert.deepEqual(record({ t: 'event', d: { kind: 'app', pid: 'abc', sid: 'cur:1', op: 'PEA VOLTA' } }),
    ['events', { plan_id: 'abc', kind: 'app', station_id: 'cur:1', op: 'PEA VOLTA', car_id: null, car_uid: null, ctx: null }]);
});

test('supabase insert sends the secret key and the row', async () => {
  const calls = [];
  const fetchFn = async (url, o) => { calls.push({ url, o }); return { ok: true }; };
  await supabase({ url: 'https://p.supabase.co/', key: 'sb_secret_S', fetchFn }).insert('plans', { a: 1 });
  assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/plans');
  assert.equal(calls[0].o.headers.apikey, 'sb_secret_S');
  assert.equal(calls[0].o.headers.Authorization, undefined); // new keys aren't JWTs
  assert.equal(calls[0].o.body, '{"a":1}');
  await supabase({ url: 'https://p.supabase.co', key: 'eyJlegacy', fetchFn }).insert('plans', {});
  assert.equal(calls[1].o.headers.Authorization, 'Bearer eyJlegacy');
  const fail = supabase({ url: 'https://p.supabase.co', key: 'S', fetchFn: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) });
  await assert.rejects(fail.insert('plans', {}), /401 bad key/);
});

test('charge reports keep the socket only when charging worked', async () => {
  const { cleanCharge: cc } = await import('../lib/stats.mjs');
  assert.equal(cc({ sid: 's', ok: true, plug: 'CHAdeMO' }).plug, 'CHAdeMO');
  assert.equal(cc({ sid: 's', ok: true, plug: 'HDMI' }).plug, null);
  assert.equal(cc({ sid: 's', ok: false, plug: 'CCS2', problem: 'broken' }).plug, null);
});

test('reports are summed per station, with a recent failure flagged', async () => {
  const { summarize } = await import('../lib/stats.mjs');
  const now = Date.parse('2026-10-22T12:00:00Z');
  const day = (n) => new Date(now - n * 864e5).toISOString();
  const s = summarize([ // newest first, as the server asks Supabase for them
    { station_id: 'a', ok: false, problem: 'broken', created_at: day(2) },
    { station_id: 'a', ok: true, plug: 'CCS2', max_kw: 88, created_at: day(5) },
    { station_id: 'a', ok: true, plug: 'CCS2', max_kw: 120, created_at: day(9) },
    { station_id: 'b', ok: false, problem: 'queue', created_at: day(30) },
    { station_id: 'b', ok: true, plug: 'CHAdeMO', max_kw: null, created_at: day(31) },
  ], now);
  assert.deepEqual(s.a.plugs, { CCS2: 120 });
  assert.equal(s.a.ok, 2);
  assert.equal(s.a.fail, 1);
  assert.equal(s.a.last, Date.parse(day(5)));
  assert.deepEqual(s.a.prob, { problem: 'broken', at: Date.parse(day(2)) });
  assert.equal(s.b.prob, null); // the failure is too old to warn about
  assert.deepEqual(s.b.plugs, { CHAdeMO: 0 });
});

test('a reverse geocode gives the district for the search word', async () => {
  const { areaFromPhoton } = await import('../lib/stations.mjs');
  assert.deepEqual(areaFromPhoton({ features: [{ properties: { city: 'อินทร์บุรี', county: 'อำเภออินทร์บุรี', state: 'จังหวัดสิงห์บุรี' } }] }),
    { amphoe: 'อินทร์บุรี', sub: 'อินทร์บุรี', province: 'สิงห์บุรี' });
  assert.deepEqual(areaFromPhoton({ features: [{ properties: { county: 'เขตจตุจักร' } }] }), { amphoe: 'จตุจักร', sub: null, province: null });
  assert.deepEqual(areaFromPhoton({}), { amphoe: null, sub: null, province: null });
});
