// Anonymous usage statistics, stored in Supabase (Postgres) through its REST API.
// Three tables (see db/schema.sql): plans (one row per trip planned), events (button taps such as
// opening an operator's app) and charges (what a driver reports after actually charging).
// Each record is rebuilt here from a whitelist, so the page can never store anything else: no IP,
// no name, and trip ends rounded to about 10 km. Records from one car share a random car_uid.

const PLUGS = ['CCS2', 'CHAdeMO', 'GBT', 'Type2', 'Tesla'];
const PROBLEMS = ['broken', 'no_plug', 'queue', 'slow', 'closed', 'blocked', 'app', 'other'];
const EVENTS = ['app', 'nav', 'nav_leg', 'nav_stop', 'skip', 'swap', 'fav', 'save', 'share', 'pin', 'nudge', 'nudge_go', 'signin', 'premium', 'install', 'install_no'];
const CTX = ['save', 'depart', 'charge', 'device', 'menu', 'saved'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
const num = (v, lo, hi) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null; };
const int = (v, lo, hi) => { const n = num(v, lo, hi); return n == null ? null : Math.round(n); };
const bool = (v) => (typeof v === 'boolean' ? v : null);
const id = (v) => (typeof v === 'string' && /^[\w:.,\-]{1,80}$/.test(v) ? v : null);
// A random id the browser makes per car model ("c-" + 8 characters), so one car's trips and
// charges can be linked. It says nothing about who owns the car.
const uid = (v) => (typeof v === 'string' && /^c-[a-z0-9]{8}$/.test(v) ? v : null);
// About 11 km: enough to see which routes people drive, not where they live.
const coarse = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null; };
const lat = (v) => coarse(v, 5, 21);
const lng = (v) => coarse(v, 97, 106);
// Charging stations are public places, so their position stays exact.
const exact = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 1e5) / 1e5 : null; };

function stop(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: id(s.id), op: str(s.op, 40), src: str(s.src, 10), kw: num(s.kw, 0, 500), guess: bool(s.guess),
    pinned: bool(s.pinned), arrive: num(s.arrive, -50, 100), depart: num(s.depart, 0, 100),
    kwh: num(s.kwh, 0, 200), min: num(s.min, 0, 600), baht: num(s.baht, 0, 10000),
  };
}

export function cleanPlan(d) {
  if (!d || typeof d !== 'object' || !id(d.pid) || !id(d.car)) return null;
  return {
    plan_id: id(d.pid), car_uid: uid(d.cu), car_id: id(d.car), brand: str(d.brand, 40), model: str(d.model, 60),
    battery_kwh: num(d.kwh, 5, 250), use_factory: num(d.useBase, 5, 60), use_set: num(d.use, 5, 60),
    dc_kw: num(d.dc, 0, 500), tuned: bool(d.tuned),
    start_soc: num(d.soc, 0, 100), min_soc: num(d.min, 0, 100), target_soc: num(d.target, 0, 100),
    from_lat: lat(d.fromLat), from_lng: lng(d.fromLng), to_lat: lat(d.toLat), to_lng: lng(d.toLng),
    dests: int(d.dests, 1, 20), round_trip: bool(d.round),
    km: num(d.km, 0, 5000), drive_min: num(d.driveMin, 0, 10000), charge_min: num(d.chargeMin, 0, 10000),
    stops: int(d.stops, 0, 50), kwh: num(d.kwhTotal, 0, 2000), cost: num(d.cost, 0, 100000),
    arrive_soc: num(d.arrive, -50, 100), ok: bool(d.ok), google_added: int(d.google, 0, 500),
    stations: Array.isArray(d.stations) ? d.stations.slice(0, 30).map(stop).filter(Boolean) : [],
  };
}

export function cleanEvent(d) {
  if (!d || typeof d !== 'object' || !EVENTS.includes(d.kind)) return null;
  return { plan_id: id(d.pid), kind: d.kind, station_id: id(d.sid), op: str(d.op, 40), car_id: id(d.car), car_uid: uid(d.cu), ctx: CTX.includes(d.ctx) ? d.ctx : null };
}

export function cleanCharge(d) {
  if (!d || typeof d !== 'object' || !id(d.sid) || typeof d.ok !== 'boolean') return null;
  return {
    plan_id: id(d.pid), station_id: id(d.sid), station_name: str(d.name, 80), op: str(d.op, 40), src: str(d.src, 10),
    station_lat: exact(d.lat, 5, 21), station_lng: exact(d.lng, 97, 106), planned_kw: num(d.plannedKw, 0, 500), guess: bool(d.guess),
    car_id: id(d.car), car_uid: uid(d.cu), battery_kwh: num(d.batt, 5, 250),
    ok: d.ok, problem: d.ok ? null : (PROBLEMS.includes(d.problem) ? d.problem : 'other'),
    plug: d.ok && PLUGS.includes(d.plug) ? d.plug : null,
    soc_from: num(d.socFrom, 0, 100), soc_to: num(d.socTo, 0, 100), kwh: num(d.kwh, 0, 250),
    baht: num(d.baht, 0, 10000), minutes: num(d.minutes, 0, 1440), max_kw: num(d.maxKw, 0, 500),
    odometer: int(d.odo, 0, 2000000), note: str(d.note, 200),
  };
}

// What drivers reported per station, from charges rows newest first: how many charges worked, when
// the last one did, the sockets they used (with the highest kW seen) and, when the newest report
// in the last 14 days says charging failed, what went wrong.
const PROBLEM_DAYS = 14;
export function summarize(rows, now = Date.now()) {
  const out = {};
  for (const r of rows) {
    if (!r.station_id) continue;
    const s = out[r.station_id] || (out[r.station_id] = { ok: 0, fail: 0, last: null, plugs: {}, newest: r });
    if (r.ok) {
      s.ok++;
      if (!s.last) s.last = Date.parse(r.created_at);
      if (r.plug) s.plugs[r.plug] = Math.max(s.plugs[r.plug] || 0, Number(r.max_kw) || 0);
    } else s.fail++;
  }
  for (const s of Object.values(out)) {
    const at = Date.parse(s.newest.created_at);
    s.prob = !s.newest.ok && now - at < PROBLEM_DAYS * 864e5 ? { problem: s.newest.problem || 'other', at } : null;
    delete s.newest;
  }
  return out;
}

const CLEAN = { plan: ['plans', cleanPlan], event: ['events', cleanEvent], charge: ['charges', cleanCharge] };

// Turns a page's { t, d } into [table, row], or null when it isn't a record we keep.
export function record(body) {
  const c = CLEAN[body?.t];
  if (!c) return null;
  const row = c[1](body.d);
  return row ? [c[0], row] : null;
}

// Supabase REST insert. `key` is the project's secret (service role) key, which only the server holds;
// the tables have row level security on and no policies, so the public key can't read or write them.
export function supabase({ url, key, fetchFn = fetch }) {
  const base = url.replace(/\/+$/, '') + '/rest/v1/';
  // A legacy service_role key is a JWT and goes in both headers; a new sb_secret_ key is not a JWT
  // and is rejected as a Bearer token, so it goes in apikey only.
  const auth = key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {};
  return {
    async insert(table, row) {
      const r = await fetchFn(base + table, {
        method: 'POST',
        headers: { apikey: key, ...auth, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error('supabase ' + table + ' ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
    },
    async insertMany(table, rows) {
      if (rows.length) await this.insert(table, rows);
    },
    async remove(table, query) {
      const r = await fetchFn(base + table + '?' + query, { method: 'DELETE', headers: { apikey: key, ...auth, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('supabase ' + table + ' ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
    },
    async select(table, query) {
      const r = await fetchFn(base + table + '?' + query, { headers: { apikey: key, ...auth }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('supabase ' + table + ' ' + r.status);
      return r.json();
    },
  };
}
