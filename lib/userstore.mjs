// Stations added by users. Render's free disk is wiped on every deploy and restart, so when
// GITHUB_TOKEN and GITHUB_REPO are set the list lives in a JSON file on its own branch of the
// repo (default `user-data`): free, persistent, with a history of every change, and pushing
// there doesn't redeploy the site. Without them it falls back to a local file.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const TYPES = ['CCS2', 'CHAdeMO', 'GB/T', 'Type2', 'Tesla'];
const TH_BOX = { s: 5.5, n: 20.6, w: 97.3, e: 105.7 };

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Returns { station } or { error } (Thai message for the form).
export function validate(body) {
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < TH_BOX.s || lat > TH_BOX.n || lng < TH_BOX.w || lng > TH_BOX.e) {
    return { error: 'ตำแหน่งต้องอยู่ในประเทศไทย' };
  }
  const name = clean(body.name, 80);
  if (name.length < 3) return { error: 'ใส่ชื่อสถานีอย่างน้อย 3 ตัวอักษร' };
  const operator = clean(body.operator, 40);
  if (!operator) return { error: 'เลือกผู้ให้บริการ' };
  const raw = Array.isArray(body.connectors) ? body.connectors.slice(0, 6) : [];
  const connectors = [];
  for (const c of raw) {
    if (!TYPES.includes(c?.type)) return { error: 'ชนิดหัวชาร์จไม่ถูกต้อง' };
    const kw = c.kw === '' || c.kw == null ? null : Number(c.kw);
    if (kw != null && (!Number.isFinite(kw) || kw <= 0 || kw > 500)) return { error: 'กำลังไฟ (kW) ต้องอยู่ระหว่าง 1–500' };
    const count = c.count === '' || c.count == null ? null : Math.round(Number(c.count));
    if (count != null && (!Number.isFinite(count) || count < 1 || count > 30)) return { error: 'จำนวนหัวต้องอยู่ระหว่าง 1–30' };
    connectors.push({ type: c.type, kw, count, dc: c.type !== 'Type2' });
  }
  if (!connectors.length) return { error: 'ใส่หัวชาร์จอย่างน้อย 1 แบบ' };
  return {
    station: {
      name, operator, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, connectors,
      hours: clean(body.hours, 60), note: clean(body.note, 200),
    },
  };
}

export function newId() {
  return 'usr:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- storage ----------

export function localStore(file) {
  return {
    kind: 'file',
    async read() {
      try { return JSON.parse(await readFile(file, 'utf8')).stations || []; } catch { return []; }
    },
    async write(stations) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ stations }, null, 1));
    },
  };
}

// GitHub contents API on a dedicated branch. `fetchFn` is injectable for tests.
export function githubStore({ token, repo, branch = 'user-data', path = 'user-stations.json', fetchFn = fetch }) {
  const api = 'https://api.github.com/repos/' + repo;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'evroute', 'X-GitHub-Api-Version': '2022-11-28' };
  let sha = null, branchOk = false;

  async function gh(url, opts = {}) {
    const r = await fetchFn(url, { ...opts, headers: { ...headers, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20000) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  }

  async function ensureBranch() {
    const ref = await gh(`${api}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 200) return;
    if (ref.status !== 404) throw new Error('github ref ' + ref.status);
    const info = await gh(api);
    const base = await gh(`${api}/git/ref/heads/${encodeURIComponent(info.body.default_branch || 'main')}`);
    if (base.status !== 200) throw new Error('github base ref ' + base.status);
    const made = await gh(`${api}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: base.body.object.sha }) });
    if (made.status !== 201 && made.status !== 422) throw new Error('github create branch ' + made.status);
  }

  async function read() {
    const r = await gh(`${api}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (r.status === 404) { sha = null; return []; } // no file (or branch) yet
    if (r.status !== 200) throw new Error('github read ' + r.status);
    sha = r.body.sha;
    branchOk = true;
    return JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8')).stations || [];
  }

  return {
    kind: 'github',
    read,
    async write(stations, message) {
      const body = {
        message: message || 'Update user stations', branch,
        content: Buffer.from(JSON.stringify({ stations }, null, 1)).toString('base64'),
      };
      if (sha) body.sha = sha;
      if (!branchOk) { await ensureBranch(); branchOk = true; }
      const r = await gh(`${api}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) throw Object.assign(new Error('github conflict ' + r.status), { conflict: true });
      if (r.status !== 200 && r.status !== 201) throw new Error('github write ' + r.status);
      sha = r.body.content?.sha || null;
    },
  };
}

// In-memory list plus serialized appends. On a write conflict (someone edited the file on
// GitHub, e.g. to hide a station) it re-reads and tries once more.
export function userStations(store) {
  let list = [];
  let queue = Promise.resolve();
  return {
    get list() { return list; },
    kind: store.kind,
    async load() { list = await store.read(); return list; },
    add(station) {
      const job = queue.then(async () => {
        const rec = { id: newId(), ...station, createdAt: new Date().toISOString() };
        const msg = `Add station: ${rec.name} (${rec.operator})`;
        try {
          await store.write(list.concat(rec), msg);
        } catch (err) {
          if (!err.conflict) throw err;
          list = await store.read();
          await store.write(list.concat(rec), msg);
        }
        list = list.concat(rec);
        return rec;
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}

// Fixed-window limit per client key.
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}
