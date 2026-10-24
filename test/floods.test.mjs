import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodList, severity } from '../lib/floods.mjs';

const now = Date.parse('2026-10-24T15:00:00+07:00');
const ev = (o) => ({ eid: '1', icon: 'flood', type: '6', latitude: '14.02', longitude: '101.42', contributor: 'DOH Admin', start: '2026-10-01 08:00:00', stop: '2026-10-25 09:00:00', ...o });

test('highway reports are graded for an EV, with the last confirmation from stop - 24 h', () => {
  const list = floodList([
    ev({ eid: '1', title: 'น้ำท่วมทางหลวง 3079 (ผ่านไม่ได้)', description: 'กม.ที่ 8+000 - 9+200 อ.เมืองปราจีนบุรี จ.ปราจีนบุรี' }),
    ev({ eid: '2', title: 'น้ำท่วมทางหลวง 34 (ผ่านได้)', description: 'อ.บางพลี จ.สมุทรปราการ', latitude: '13.63' }),
    ev({ eid: '3', title: 'น้ำท่วม (ผ่านไม่ได้)', description: 'รถเล็กผ่านไม่ได้ จ.อยุธยา', latitude: '14.3' }),
    ev({ eid: '4', title: 'ถนนน้ำท่วม', description: 'ระดับน้ำ 25 ซม.', contributor: 'someone', start: '2026-10-24 10:00:00', latitude: '13.9' }),
    ev({ eid: '5', icon: 'accident', type: '1', title: 'อุบัติเหตุ' }),
  ], null, now);
  assert.deepEqual(list.map((f) => [f.id, f.sev, f.block]), [['e1', 'closed', true], ['e4', 'deep', true], ['e3', 'small', true], ['e2', 'open', false]]);
  const f = list[0];
  assert.equal(f.title, 'น้ำท่วมทางหลวง 3079');
  assert.equal(f.place, 'กม. 8+000-9+200 · อ.เมืองปราจีนบุรี · จ.ปราจีนบุรี');
  assert.equal(f.confirmed, new Date(Date.parse('2026-10-24T09:00:00+07:00')).toISOString());
  assert.equal(list.find((x) => x.id === 'e4').src, 'ผู้ใช้ Longdo Traffic');
});

test('old reports are left out: a day for reports, two hours for Bangkok sensors', () => {
  const list = floodList([
    ev({ eid: '1', title: 'ท่วม (ผ่านไม่ได้)', stop: '2026-10-23 12:00:00' }), // last confirmed 22 Oct
    ev({ eid: '2', title: 'ท่วม', contributor: 'x', start: '2026-10-22 10:00:00', latitude: '13.9' }),
  ], { roads: [
    { code: 'A', name: 'ถ.เอกชัย', level: 'flood', depth: 22, lat: 13.68, lng: 100.43, measured_at: '2026-10-24 14:30:00' },
    { code: 'B', name: 'ถ.พระราม 2', level: 'flood', depth: 30, lat: 13.6, lng: 100.4, measured_at: '2026-10-24 11:00:00' },
    { code: 'C', name: 'ถ.แห้ง', level: 'dry', depth: 0, lat: 13.6, lng: 100.4, measured_at: '2026-10-24 14:30:00' },
  ] }, now);
  assert.deepEqual(list.map((f) => [f.id, f.sev, f.block]), [['sA', 'deep', true]]);
});

test('the same spot sent many times is one point, the worst', () => {
  const list = floodList([
    ev({ eid: '1', title: 'ท่วม 3079 (ผ่านไม่ได้)' }), ev({ eid: '2', title: 'ท่วม 3079 (ผ่านไม่ได้)' }),
    ev({ eid: '3', title: 'ท่วม 344 (ผ่านได้)', latitude: '13.137', longitude: '101.346' }),
    ev({ eid: '4', title: 'ท่วม 344 (ผ่านไม่ได้)', description: 'รถเล็กผ่านไม่ได้', latitude: '13.137', longitude: '101.346' }),
  ], null, now);
  assert.deepEqual(list.map((f) => f.sev), ['closed', 'small']);
});

test('shallow water is only a warning', () => {
  assert.equal(severity({ status: 'sensor', depth: 12 }).block, false);
  assert.equal(severity({ status: 'sensor', depth: 5 }).sev, 'low');
  assert.equal(severity({ status: 'report', depth: null }).sev, 'report');
});
