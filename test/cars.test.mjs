import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCar, carId, carsScript } from '../lib/cars.mjs';

test('an admin row is checked and gets an id from its name', () => {
  assert.equal(carId('AVATR', '12 Long Range'), 'avatr-12-long-range');
  const c = cleanCar({ brand: ' AVATR ', model: '12  Long Range', kwh: '89', use: 17.5, dc: 240, plugs: ['CCS2', 'X'], evil: 1 });
  assert.deepEqual(c, { id: 'avatr-12-long-range', brand: 'AVATR', model: '12 Long Range', kwh: 89, use: 17.5, dc: 240, ac: 7, plugs: ['CCS2'], hidden: false, note: null });
  assert.match(cleanCar({ brand: 'X', model: 'Y', kwh: 5, use: 15, dc: 50 }).error, /10–200/);
  assert.match(cleanCar({ brand: '', model: 'Y' }).error, /ยี่ห้อ/);
  assert.match(cleanCar({ id: 'custom', brand: 'X', model: 'Y', kwh: 50, use: 15, dc: 50 }).error, /id/);
  assert.equal(cleanCar({ id: 'byd-m6', brand: 'BYD', model: 'M6', hidden: true }).hidden, true); // hiding needs no figures
  assert.deepEqual(cleanCar({ brand: 'X', model: 'Y', kwh: 50, use: 15, dc: 0, plugs: ['CCS2'] }).plugs, []); // no DC, no DC socket
});

test('the page script adds, replaces and hides models, keeping "custom" last', () => {
  const C = [{ id: 'a', model: 'A' }, { id: 'b', model: 'B' }, { id: 'custom', model: 'own' }];
  const window = { EVCars: C };
  new Function('window', carsScript([
    { id: 'b', brand: 'X', model: 'B2', kwh: 50, use: 15, dc: 100, ac: 7, plugs: ['CCS2'] },
    { id: 'a', hidden: true },
    { id: 'n', brand: 'N', model: 'New', kwh: 60, use: 16, dc: 120, ac: 11, plugs: ['CCS2'] },
  ]))(window);
  assert.deepEqual(C.map((c) => c.id), ['b', 'n', 'custom']);
  assert.equal(C[0].model, 'B2');
  assert.doesNotMatch(carsScript([{ id: 'x', brand: '</script>', model: 'm', kwh: 1, use: 1, dc: 1 }]), /<\/script>/);
});
