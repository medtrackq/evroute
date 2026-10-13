import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, githubStore, userStations, rateLimiter, localStore } from '../lib/userstore.mjs';
import { fromUser, fromOSM, merge } from '../lib/stations.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const good = { lat: 14.35, lng: 100.58, name: 'PTT พหลโยธิน กม.60', operator: 'PTT EV Station PluZ', connectors: [{ type: 'CCS2', kw: 120, count: 2 }] };

test('validate accepts a normal station and cleans text', () => {
  const v = validate({ ...good, name: '  PTT <b>พหลโยธิน</b>  ', hours: '24 ชม.' });
  assert.equal(v.error, undefined);
  assert.equal(v.station.name, 'PTT b พหลโยธิน /b');
  assert.deepEqual(v.station.connectors, [{ type: 'CCS2', kw: 120, count: 2, dc: true }]);
});

test('validate rejects bad input', () => {
  assert.ok(validate({ ...good, lat: 35.6, lng: 139.7 }).error); // Tokyo
  assert.ok(validate({ ...good, name: 'a' }).error);
  assert.ok(validate({ ...good, operator: '' }).error);
  assert.ok(validate({ ...good, connectors: [] }).error);
  assert.ok(validate({ ...good, connectors: [{ type: 'Plug', kw: 50 }] }).error);
  assert.ok(validate({ ...good, connectors: [{ type: 'CCS2', kw: 9000 }] }).error);
  assert.ok(validate(null).error);
});

test('unknown kW is allowed and marks the station as a guess', () => {
  const v = validate({ ...good, connectors: [{ type: 'CCS2', kw: '', count: '' }] });
  const st = fromUser({ id: 'usr:x', ...v.station });
  assert.equal(st.guess, true);
  assert.equal(st.src, 'user');
  assert.equal(st.op, 'PTT EV Station PluZ');
});

test('a user station fills in plugs for a guessed OSM station nearby', () => {
  const osm = fromOSM({ type: 'node', id: 9, lat: 14.35, lon: 100.58, tags: { amenity: 'charging_station', brand: 'PTT' } });
  const user = fromUser({ id: 'usr:y', ...validate({ ...good, lat: 14.3502 }).station });
  const m = merge([user], [osm]);
  assert.equal(m.length, 1);
  assert.equal(m[0].guess, false);
  assert.equal(m[0].plugs[0].kw, 120);
  assert.equal(fromUser({ id: 'usr:z', ...good, hidden: true }), null);
});

test('rate limiter', () => {
  const allow = rateLimiter(2, 1000);
  assert.ok(allow('a', 0) && allow('a', 1) && !allow('a', 2));
  assert.ok(allow('b', 2));
  assert.ok(allow('a', 2000));
});

function fakeGitHub() {
  const files = {}, branches = { main: 'abc' };
  let shaN = 0, calls = [];
  const reply = (status, body) => ({ status, json: async () => body });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url), p = u.pathname.replace('/repos/o/r', ''), m = opts.method || 'GET';
    calls.push(m + ' ' + p);
    if (p === '' && m === 'GET') return reply(200, { default_branch: 'main' });
    let r = /^\/git\/ref\/heads\/(.+)$/.exec(p);
    if (r) return branches[r[1]] ? reply(200, { object: { sha: branches[r[1]] } }) : reply(404, {});
    if (p === '/git/refs' && m === 'POST') { const b = JSON.parse(opts.body); branches[b.ref.replace('refs/heads/', '')] = b.sha; return reply(201, {}); }
    r = /^\/contents\/(.+)$/.exec(p);
    if (r && m === 'GET') {
      const f = files[u.searchParams.get('ref') + ':' + r[1]];
      return f ? reply(200, { sha: f.sha, content: f.content }) : reply(404, {});
    }
    if (r && m === 'PUT') {
      const b = JSON.parse(opts.body), key = b.branch + ':' + r[1];
      if (!branches[b.branch]) return reply(404, {});
      if (files[key] && files[key].sha !== b.sha) return reply(409, {});
      files[key] = { sha: 's' + (++shaN), content: b.content };
      return reply(files[key].sha === 's1' ? 201 : 200, { content: { sha: files[key].sha } });
    }
    return reply(500, {});
  };
  return { fetchFn, files, branches, calls };
}

test('GitHub store: creates the data branch, appends, survives an outside edit', async () => {
  const gh = fakeGitHub();
  const store = githubStore({ token: 't', repo: 'o/r', fetchFn: gh.fetchFn });
  const users = userStations(store);
  assert.deepEqual(await users.load(), []);
  const a = await users.add(validate(good).station);
  assert.ok(a.id.startsWith('usr:'));
  assert.ok(gh.branches['user-data']);
  await users.add(validate({ ...good, name: 'EleXA ลำปาง' }).station);
  // Someone hides the first station on GitHub; our next add must not overwrite that.
  const key = 'user-data:user-stations.json';
  const doc = JSON.parse(Buffer.from(gh.files[key].content, 'base64').toString());
  doc.stations[0].hidden = true;
  gh.files[key] = { sha: 'outside', content: Buffer.from(JSON.stringify(doc)).toString('base64') };
  await users.add(validate({ ...good, name: 'EA บางนา' }).station);
  const final = JSON.parse(Buffer.from(gh.files[key].content, 'base64').toString()).stations;
  assert.equal(final.length, 3);
  assert.equal(final[0].hidden, true);
  assert.deepEqual(final.map((s) => s.name), ['PTT พหลโยธิน กม.60', 'EleXA ลำปาง', 'EA บางนา']);
  // A fresh process reads the same list back.
  const again = userStations(githubStore({ token: 't', repo: 'o/r', fetchFn: gh.fetchFn }));
  assert.equal((await again.load()).length, 3);
});

test('local file store round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evroute-'));
  const users = userStations(localStore(join(dir, 'sub', 'u.json')));
  await users.load();
  await Promise.all([users.add(validate(good).station), users.add(validate({ ...good, name: 'สอง' }).station)]);
  const again = userStations(localStore(join(dir, 'sub', 'u.json')));
  assert.equal((await again.load()).length, 2);
});
