import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overpassQuery, fromOSMPlace, placeIndex, amenitiesOf } from '../lib/amenities.mjs';

test('places within a short walk make the summary; names come first by kind', () => {
  const places = [
    fromOSMPlace({ type: 'node', lat: 13.75631, lon: 100.50181, tags: { amenity: 'cafe', brand: 'Starbucks' } }),
    fromOSMPlace({ type: 'way', center: { lat: 13.7564, lon: 100.5019 }, tags: { shop: 'mall', name: 'Central Rama 9' } }),
    fromOSMPlace({ type: 'node', lat: 13.757, lon: 100.5018, tags: { amenity: 'restaurant', name: 'ร้านข้าวมันไก่' } }),
    fromOSMPlace({ type: 'node', lat: 13.80, lon: 100.5, tags: { amenity: 'restaurant', name: 'far away' } }),
    fromOSMPlace({ type: 'node', lat: 13.7563, lon: 100.5018, tags: { amenity: 'bench' } }),
  ].filter(Boolean);
  assert.equal(places.length, 4);
  const am = amenitiesOf({ lat: 13.7563, lng: 100.5018, name: 'EA Anywhere', op: 'EA Anywhere' }, placeIndex(places));
  assert.deepEqual(am, { food: 1, cafe: 1, wc: 1, shop: 1, mall: 'Central Rama 9', names: ['Starbucks', 'ร้านข้าวมันไก่'], guess: false });
});

test('with nothing mapped, the name or network is a guess', () => {
  const idx = placeIndex([]);
  const ptt = amenitiesOf({ lat: 14, lng: 101, name: 'PTT EV Station PluZ วังน้อย', op: 'PTT EV Station PluZ' }, idx);
  assert.equal(ptt.guess, true);
  assert.equal(ptt.cafe, 1);
  assert.deepEqual(ptt.names, ['Café Amazon', '7-Eleven']);
  assert.equal(amenitiesOf({ lat: 14, lng: 101, name: 'PEA VOLTA นครชัยศรี', op: 'PEA VOLTA' }, idx), null);
  assert.equal(amenitiesOf({ lat: 14, lng: 101, name: 'EA Anywhere Robinson Lifestyle', op: 'EA Anywhere' }, idx).food, 1);
});

test('one Overpass request covers stations close together once', () => {
  const q = overpassQuery([{ lat: 13.75001, lng: 100.5 }, { lat: 13.75002, lng: 100.50001 }, { lat: 14, lng: 101 }]);
  assert.equal((q.match(/around:250/g) || []).length, 2);
  assert.match(q, /out center tags;$/);
});
