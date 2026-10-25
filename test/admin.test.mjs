import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminEmails, summarize } from '../lib/admin.mjs';
import { record, cleanFeedback, cleanError } from '../lib/stats.mjs';

test('admin emails come from one setting', () => {
  assert.deepEqual(adminEmails(' Me@x.co, you@y.co;bad '), ['me@x.co', 'you@y.co']);
  assert.deepEqual(adminEmails(''), []);
});

test('people are counted per Bangkok day, once each', () => {
  const now = Date.parse('2026-10-24T05:00:00Z'); // 12:00 in Bangkok
  const rows = {
    opens: [
      { created_at: '2026-10-24T01:00:00Z', dev: 'd-a', lang: 'th' },
      { created_at: '2026-10-24T02:00:00Z', dev: 'd-a', lang: 'th' }, // the same browser again today
      { created_at: '2026-10-23T18:00:00Z', dev: 'd-b', lang: 'en' }, // 01:00 on the 24th in Bangkok
      { created_at: '2026-10-20T03:00:00Z', dev: 'd-a', lang: 'zh' },
      { created_at: '2026-08-01T03:00:00Z', dev: 'd-old', lang: 'th' }, // outside 30 days
    ],
    plans: [{ created_at: '2026-10-24T03:00:00Z', brand: 'BYD', model: 'Atto 3', ok: true }, { created_at: '2026-10-22T03:00:00Z', brand: 'BYD', model: 'Atto 3', ok: false }],
    events: [{ kind: 'app', op: 'PEA VOLTA' }, { kind: 'app', op: 'PEA VOLTA' }, { kind: 'app', op: 'EleXA' }, { kind: 'save' },
      { kind: 'arrive', ref: 'tiktok', dev: 'd-a', created_at: '2026-10-24T01:00:00Z' }, { kind: 'arrive', ref: 'tiktok', dev: 'd-a', created_at: '2026-10-23T01:00:00Z' },
      { kind: 'arrive', ref: 'tiktok', dev: 'd-b', created_at: '2026-10-24T01:00:00Z' }, { kind: 'arrive', ref: 'line', dev: 'd-c', created_at: '2026-10-24T01:00:00Z' }],
    users: [{ created_at: '2026-10-24T00:00:00Z' }, { created_at: '2025-01-01T00:00:00Z' }],
    errors: [
      { created_at: '2026-10-24T04:00:00Z', src: 'web', msg: 'x is undefined', at: 'app.js:1:2', dev: 'd-a', ua: 'Chrome 126 · Android' },
      { created_at: '2026-10-24T03:00:00Z', src: 'web', msg: 'x is undefined', at: 'app.js:1:2', dev: 'd-b' },
      { created_at: '2026-10-20T03:00:00Z', src: 'server', msg: 'overpass status 504', at: 'overpass' },
    ],
    feedback: [{ id: 1, status: 'new' }, { id: 2, status: 'done' }],
    charges: [{ ok: true }, { ok: false }],
  };
  const s = summarize(rows, now);
  assert.deepEqual(s.people, { today: 2, week: 2, month: 2, returning: 1 });
  assert.equal(s.daily.length, 30);
  assert.deepEqual(s.daily.at(-1), { day: '2026-10-24', people: 2, opens: 3, plans: 1, signups: 1 });
  assert.deepEqual(s.plans, { today: 1, month: 2, failed: 1 });
  assert.deepEqual(s.accounts, { total: 2, month: 1 });
  assert.deepEqual(s.langs, { th: 1, en: 1 }); // each browser's latest language
  assert.deepEqual(s.sources, [{ key: 'tiktok', count: 2, visits: 3 }, { key: 'line', count: 1, visits: 1 }]);
  assert.ok(!s.actions.some((x) => x.key === 'arrive'));
  assert.deepEqual(s.apps, [{ key: 'PEA VOLTA', count: 2 }, { key: 'EleXA', count: 1 }]);
  assert.equal(s.errors.length, 2);
  assert.equal(s.errors[0].count, 2);
  assert.equal(s.errors[0].people, 2);
  assert.equal(s.errors[0].ua, 'Chrome 126 · Android');
  assert.equal(s.errorsToday, 2);
  assert.equal(s.feedbackNew, 1);
  assert.deepEqual(s.charges, { month: 2, failed: 1 });
});

test('feedback and errors keep only their own fields', () => {
  const f = cleanFeedback({ kind: 'hack', message: '  แอปค้างตอนกดวางแผน  ', email: 'nope', evil: 1, dev: 'd-12345678', lang: 'xx' });
  assert.deepEqual(f, { kind: 'other', message: 'แอปค้างตอนกดวางแผน', email: null, page: null, lang: null, car_id: null, plan_id: null, ua: null, dev: 'd-12345678' });
  assert.equal(cleanFeedback({ message: 'a' }), null);
  assert.equal(cleanError({ msg: '' }), null);
  assert.deepEqual(record({ t: 'error', d: { msg: 'boom', at: 'app.js:3:4', lang: 'th' } })[0], 'errors');
  assert.equal(record({ t: 'feedback', d: { message: 'hello' } }), null); // its own endpoint, not /api/log
});

test('places on the way are counted per place, for the partners\' report', () => {
  const now = Date.parse('2026-10-24T12:00:00+07:00');
  const events = [
    { created_at: '2026-10-24T03:00:00Z', kind: 'tp_add', station_id: 'tp:farm-chokchai', dev: 'd-a' },
    { created_at: '2026-10-24T04:00:00Z', kind: 'tp_add', station_id: 'tp:farm-chokchai', dev: 'd-b' },
    { created_at: '2026-10-24T05:00:00Z', kind: 'tp_walk', station_id: 'tp:ud-town', dev: 'd-a' },
    { created_at: '2026-10-24T05:00:00Z', kind: 'skip', station_id: 'osm:1', dev: 'd-a' },
  ];
  const s = summarize({ events }, now);
  assert.deepEqual(s.tripPlaces, [
    { key: 'farm-chokchai', add: 2, walk: 0, people: 2, count: 2 },
    { key: 'ud-town', add: 0, walk: 1, people: 1, count: 1 },
  ]);
});

