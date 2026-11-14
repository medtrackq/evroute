import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveCounter } from '../lib/live.mjs';

test('counts browsers that pinged in the last 5 minutes, and the day\'s peak', () => {
  let t = Date.parse('2026-11-14T03:00:00Z'); // 10:00 in Bangkok
  const live = liveCounter({ now: () => t });
  assert.deepEqual(live.count(), { n: 0, peak: 0, peakAt: null });
  assert.equal(live.ping('d-aaaaaaaa'), true);
  assert.equal(live.ping('d-bbbbbbbb'), true);
  assert.equal(live.ping('d-aaaaaaaa'), true); // the same browser again is still one
  assert.equal(live.ping('not-an-id'), false);
  assert.equal(live.ping({ $gt: '' }), false);
  assert.deepEqual(live.count(), { n: 2, peak: 2, peakAt: '2026-11-14T03:00:00.000Z' });
  t += 4 * 60e3;
  live.ping('d-bbbbbbbb');
  t += 2 * 60e3; // a gone quiet 6 minutes ago, b 2 minutes ago
  assert.deepEqual(live.count(), { n: 1, peak: 2, peakAt: '2026-11-14T03:00:00.000Z' });
  t = Date.parse('2026-11-14T17:30:00Z'); // 00:30 the next day in Bangkok: a new peak
  live.ping('d-cccccccc');
  assert.deepEqual(live.count(), { n: 1, peak: 1, peakAt: '2026-11-14T17:30:00.000Z' });
});

test('keeps at most max browsers in memory', () => {
  const live = liveCounter({ max: 3, now: () => 0 });
  ['d-00000001', 'd-00000002', 'd-00000003', 'd-00000004'].forEach((d) => live.ping(d));
  assert.equal(live.count().n, 3);
});
