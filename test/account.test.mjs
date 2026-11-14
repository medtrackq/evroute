import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmail, cleanCode, cleanTrips, cleanPrefs, supabaseAuth, realUse } from '../lib/account.mjs';

test('email and code input is checked', () => {
  assert.equal(cleanEmail('  Somchai@Example.COM '), 'somchai@example.com');
  assert.equal(cleanEmail('nope'), null);
  assert.equal(cleanEmail('a@b'), null);
  assert.equal(cleanEmail({ $ne: 1 }), null);
  assert.equal(cleanCode(' 123 456 '), '123456');
  assert.equal(cleanCode('12345'), null);
  assert.equal(cleanCode('abcdef'), null);
});

test('saved trips keep only their own fields, deduplicated and capped', () => {
  const t = { q: '?from=13.7,100.5&to=17.8,102.7', title: 'หนองคาย', from: 'BKK', car: 'BYD Atto 3', km: 632, stops: 4, at: '2026-10-23T01:00:00Z', dep: '2026-12-14T10:00', evil: '<script>' };
  const out = cleanTrips([t, { ...t }, { q: 'javascript:alert(1)' }, null, ...Array.from({ length: 60 }, (_, i) => ({ ...t, q: '?n=' + i }))]);
  assert.equal(out.length, 50);
  assert.deepEqual(out[0], { q: t.q, title: 'หนองคาย', from: 'BKK', car: 'BYD Atto 3', km: 632, stops: 4, at: t.at, dep: t.dep, cost: null, mins: 0 });
  assert.equal(cleanTrips('x'), null);
  // The route and the stops, for the check before leaving: kept when well formed.
  const withRoute = cleanTrips([{ ...t, line: '_p~iF~ps|U_ulLnnqC', sids: ['osm:1', 'cur:17.4,102.8'], snames: ['A', 'B'] }])[0];
  assert.equal(withRoute.line, '_p~iF~ps|U_ulLnnqC');
  assert.deepEqual(withRoute.sids, ['osm:1', 'cur:17.4,102.8']);
  assert.deepEqual(withRoute.snames, ['A', 'B']);
  const bad = cleanTrips([{ ...t, line: '<script>', sids: ['ok', '<x>'] }])[0];
  assert.ok(!('line' in bad) && !('sids' in bad));
});

test('auth calls Supabase with the right shape and caches users', async () => {
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, o });
    if (url.endsWith('/verify')) return { ok: true, json: async () => ({ access_token: 'a'.repeat(30), refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'x@y.co', phone: '' } }) };
    if (url.endsWith('/user')) return o.headers.Authorization === 'Bearer ' + 'a'.repeat(30) ? { ok: true, json: async () => ({ id: 'u1', email: 'x@y.co' }) } : { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  };
  const a = supabaseAuth({ url: 'https://p.supabase.co/', key: 'sb_secret_S', fetchFn, now: () => 1e12 });
  await a.sendCode('x@y.co');
  assert.equal(calls[0].url, 'https://p.supabase.co/auth/v1/otp');
  assert.deepEqual(JSON.parse(calls[0].o.body), { email: 'x@y.co', create_user: true });
  assert.equal(calls[0].o.headers.apikey, 'sb_secret_S');
  assert.equal(calls[0].o.headers.Authorization, undefined); // a new secret key isn't a JWT
  // Where the email's link lands, as supabase-js sends it.
  await a.sendCode('x@y.co', 'https://evroute.info/');
  assert.equal(calls.pop().url, 'https://p.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fevroute.info%2F');
  const s = await a.verify('x@y.co', '123456');
  assert.deepEqual(JSON.parse(calls[1].o.body), { type: 'email', email: 'x@y.co', token: '123456' });
  assert.deepEqual(s.user, { id: 'u1', email: 'x@y.co' });
  assert.equal(s.expires_at, 1e9 + 3600);
  assert.deepEqual(await a.user(s.access_token), { id: 'u1', email: 'x@y.co', prefs: null });
  await a.user(s.access_token);
  assert.equal(calls.filter((c) => c.url.endsWith('/user')).length, 1); // cached
  assert.equal(await a.user('b'.repeat(30)), null);
  assert.equal(await a.user('short'), null);
  await a.deleteUser('u1');
  assert.equal(calls.at(-1).url, 'https://p.supabase.co/auth/v1/admin/users/u1');
  assert.equal(calls.at(-1).o.method, 'DELETE');
});

test('settings that follow the user keep only what the page uses, within range', () => {
  const p = cleanPrefs({
    at: '2026-11-14T10:00:00Z', car: { id: 'byd-atto3-std', kwh: 49.9, use: 16.5, dc: 70, margin: 10, extra: 'x' },
    mycar: { id: 'custom', brand: 'Chery', model: 'V23 4WD Peak', plug: 'CCS2', kwh: 76.9, use: 999 },
    nick: '  Tu  ', favs: { 'cur:14.8,101.6': true, 'osm:n1': true, '<x>': true, 'no': false },
    floodAvoid: false, tpPrefs: { cats: { temple: true, casino: true }, time: 240 }, want: { food: true, beer: true },
    premium: 1, lang: 'en', theme: 'dark', token: 'secret', photo: 'data:image/png;base64,AAAA',
  });
  assert.deepEqual(p, {
    at: '2026-11-14T10:00:00.000Z', car: { id: 'byd-atto3-std', kwh: 49.9, use: 16.5, dc: 70, margin: 10 },
    mycar: { id: 'custom', kwh: 76.9, brand: 'Chery', model: 'V23 4WD Peak', plug: 'CCS2' }, // use 999 is out of range
    nick: 'Tu', favs: { 'cur:14.8,101.6': true, 'osm:n1': true },
    floodAvoid: false, tpPrefs: { cats: { temple: true }, time: 240 }, want: { food: true }, premium: 1, lang: 'en', theme: 'dark',
  });
  assert.equal(cleanPrefs('x'), null);
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['osm:n' + i, true]));
  assert.equal(Object.keys(cleanPrefs({ favs: many }).favs).length, 50); // kept small: it rides in the access token
  assert.deepEqual(Object.keys(cleanPrefs({ car: { id: '../../etc' }, lang: 'fr' })), ['at']);
  // "สนใจ ฿49" keeps when it was pressed; 1 from before that is still kept.
  assert.equal(cleanPrefs({ premium: '2026-11-14T09:30:00+07:00' }).premium, '2026-11-14T02:30:00.000Z');
  assert.equal(cleanPrefs({ premium: 'yes' }).premium, undefined);
});

test('the account list has emails only of those who asked to hear about ฿49', async () => {
  const fetchFn = async (url) => {
    assert.match(url, /\/auth\/v1\/admin\/users\?page=1&per_page=1000$/);
    return { ok: true, json: async () => ({ users: [
      { id: 'u1', email: 'a@x.co', created_at: '2026-11-01', last_sign_in_at: '2026-11-14', user_metadata: { evroute: { premium: '2026-11-14T02:30:00Z', nick: 'A' } } },
      { id: 'u2', email: 'b@x.co', created_at: '2026-11-02', user_metadata: { evroute: { premium: 1 } } },
      { id: 'u3', email: 'c@x.co', created_at: '2026-11-03', user_metadata: { evroute: { nick: 'C' } } },
      { id: 'u4', email: 'd@x.co', created_at: '2026-11-04' },
    ] }) };
  };
  const users = await supabaseAuth({ url: 'https://p.supabase.co', key: 'k', fetchFn }).listUsers();
  assert.deepEqual(users, [
    { id: 'u1', created_at: '2026-11-01', last_sign_in_at: '2026-11-14', email: 'a@x.co', premium: '2026-11-14T02:30:00.000Z' },
    { id: 'u2', created_at: '2026-11-02', last_sign_in_at: undefined, email: 'b@x.co', premium: 1 },
    { id: 'u3', created_at: '2026-11-03', last_sign_in_at: undefined },
    { id: 'u4', created_at: '2026-11-04', last_sign_in_at: undefined },
  ]);
});

test('settings are saved with the account by the user\'s own token, and the cached user sees them', async () => {
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, o });
    if (url.endsWith('/user') && o.method === 'GET') return { ok: true, json: async () => ({ id: 'u1', email: 'x@y.co', user_metadata: { evroute: { at: '2026-11-01T00:00:00Z', nick: 'Old' } } }) };
    return { ok: true, json: async () => ({}) };
  };
  const a = supabaseAuth({ url: 'https://p.supabase.co', key: 'sb_secret_S', fetchFn });
  const tok = 't'.repeat(30);
  assert.equal((await a.user(tok)).prefs.nick, 'Old');
  const prefs = cleanPrefs({ at: '2026-11-14T00:00:00Z', nick: 'New' });
  await a.savePrefs(tok, prefs);
  const put = calls.at(-1);
  assert.equal(put.url, 'https://p.supabase.co/auth/v1/user');
  assert.equal(put.o.method, 'PUT');
  assert.equal(put.o.headers.Authorization, 'Bearer ' + tok);
  assert.deepEqual(JSON.parse(put.o.body), { data: { evroute: prefs } });
  assert.equal((await a.user(tok)).prefs.nick, 'New'); // from the cache, no second lookup
  assert.equal(calls.filter((c) => c.o.method === 'GET').length, 1);
});

test('a wrong code comes back as a 4xx error', async () => {
  const a = supabaseAuth({ url: 'https://p.supabase.co', key: 'k', fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ error_code: 'otp_expired' }) }) });
  await assert.rejects(a.verify('x@y.co', '000000'), (err) => err.status === 403 && /otp_expired/.test(err.message));
});

test('real consumption comes from odometer and battery between reports', () => {
  const c = (day, odo, from, to, extra) => ({ created_at: '2026-10-' + day, ok: true, car_id: 'byd-atto3-std', battery_kwh: 49.9, odometer: odo, soc_from: from, soc_to: to, ...extra });
  const use = realUse([ // newest first, as the server returns them
    c(20, 10330, 20, 75),
    c(15, 10170, 25, 80),
    c(10, 10000, 30, 80),
    c('09', 9990, 50, 60, { ok: false }),
  ]);
  // (80-25)% and (80-20)% of 49.9 kWh over 170 + 160 km
  assert.deepEqual(use['byd-atto3-std'], { kwh100: 17.4, km: 330, segments: 2 });
  assert.deepEqual(realUse([c(1, 100, 20, 80)]), {});
});

test('a sign-in request waits for approval from the same email only', async () => {
  const { handoffs } = await import('../lib/account.mjs');
  let t = 0;
  const h = handoffs({ ttl: 1000, now: () => t });
  const a = h.open('me@x.co');
  assert.match(a.pair, /^\d\d$/);
  assert.equal(h.get(a.id).ok, false);
  assert.deepEqual(h.waiting('me@x.co').map((w) => w.id), [a.id]);
  assert.deepEqual(h.waiting('other@x.co'), []);
  assert.equal(h.approve(a.id, 'other@x.co'), false); // someone else's account can't let it in
  assert.equal(h.approve(a.id, 'me@x.co'), true);
  assert.equal(h.get(a.id).ok, true);
  assert.deepEqual(h.waiting('me@x.co'), []);
  const b = h.open('me@x.co');
  h.deny(b.id, 'me@x.co');
  assert.equal(h.get(b.id), null);
  const c = h.open('me@x.co');
  t = 2000;
  assert.equal(h.get(c.id), null); // expired
});

test('a session for an already verified email comes from an admin link token', async () => {
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, body: JSON.parse(o.body) });
    if (url.endsWith('/admin/generate_link')) return { ok: true, json: async () => ({ hashed_token: 'h1', verification_type: 'magiclink' }) };
    return { ok: true, json: async () => ({ access_token: 'a'.repeat(30), refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'x@y.co' } }) };
  };
  const s = await supabaseAuth({ url: 'https://p.supabase.co', key: 'k', fetchFn }).sessionFor('x@y.co');
  assert.deepEqual(calls[0].body, { type: 'magiclink', email: 'x@y.co' });
  assert.deepEqual(calls[1].body, { type: 'magiclink', token_hash: 'h1' });
  assert.equal(s.user.id, 'u1');
});
