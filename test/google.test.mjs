import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGoogle, dailyCounter, googlePlaces } from '../lib/google.mjs';

const place = (id, extra) => ({
  id, displayName: { text: 'EA Anywhere Charging Station' }, location: { latitude: 14.1, longitude: 100.6 },
  googleMapsUri: 'https://maps.google.com/?cid=1', businessStatus: 'OPERATIONAL',
  evChargeOptions: { connectorCount: 4, connectorAggregation: [
    { type: 'EV_CONNECTOR_TYPE_CCS_COMBO_2', maxChargeRateKw: 120, count: 2, availableCount: 1 },
    { type: 'EV_CONNECTOR_TYPE_TYPE_2', maxChargeRateKw: 22, count: 2 },
  ] }, ...extra,
});

test('Google place becomes a station with plugs', () => {
  const st = fromGoogle(place('abc'));
  assert.equal(st.id, 'g:abc');
  assert.equal(st.op, 'EA Anywhere');
  assert.equal(st.src, 'google');
  assert.deepEqual(st.plugs, [{ type: 'CCS2', kw: 120, n: 2, dc: true }, { type: 'Type2', kw: 22, n: 2, dc: false }]);
  assert.equal(st.guess, false);
  assert.equal(fromGoogle(place('x', { businessStatus: 'CLOSED_PERMANENTLY' })), null);
  const bare = fromGoogle(place('y', { evChargeOptions: undefined }));
  assert.equal(bare.guess, true);
  assert.deepEqual(bare.plugs, []);
});

test('daily counter resets on a new Bangkok day', () => {
  let t = Date.parse('2026-10-13T10:00:00Z');
  const c = dailyCounter(2, () => t);
  assert.ok(c.take() && c.take() && !c.take());
  t = Date.parse('2026-10-13T16:59:00Z'); // 23:59 in Bangkok
  assert.equal(c.remaining, 0);
  t = Date.parse('2026-10-13T17:01:00Z'); // 00:01 next day
  assert.equal(c.remaining, 2);
});

test('search stops at the daily cap and sends the right request', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ places: [place('p' + calls.length), place('shared')] }) };
  };
  const g = googlePlaces({ key: 'K', dailyLimit: 2, fetchFn });
  const r = await g.search([{ lat: 14, lng: 100 }, { lat: 15, lng: 100 }, { lat: 16, lng: 100 }], 25000);
  assert.equal(r.calls, 2);
  assert.equal(r.capped, true);
  assert.equal(r.remaining, 0);
  assert.equal(r.stations.length, 3); // p1, p2, shared once
  assert.equal(calls[0].headers['X-Goog-Api-Key'], 'K');
  assert.match(calls[0].headers['X-Goog-FieldMask'], /evChargeOptions/);
  assert.deepEqual(calls[0].body.includedTypes, ['electric_vehicle_charging_station']);
  assert.equal(calls[0].body.locationRestriction.circle.radius, 25000);
});
