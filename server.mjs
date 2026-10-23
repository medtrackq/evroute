// Static file server plus cached proxies for the EV trip planner.
// Stations: the curated list (data/stations.json), OpenStreetMap via Overpass (refreshed daily,
// falling back to the bundled data/osm-th.json snapshot) and Open Charge Map when OCM_KEY is set.
// Routes: public FOSSGIS Valhalla. Place search: Komoot Photon.
// No dependencies: `node server.mjs` (PORT defaults to 8080).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromOSM, fromOCM, fromCurated, fromUser, merge, areaFromPhoton } from './lib/stations.mjs';
import { validate, localStore, githubStore, userStations, rateLimiter } from './lib/userstore.mjs';
import { googlePlaces } from './lib/google.mjs';
import { record, supabase, summarize } from './lib/stats.mjs';
import { cleanEmail, cleanCode, cleanTrips, supabaseAuth, realUse, handoffs } from './lib/account.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const OCM_KEY = process.env.OCM_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // owner/name
// Google: Places (server-side key, never sent to browsers) and the Maps JavaScript API (a
// browser key restricted to this site's domain). Places results must be shown on a Google map,
// so the page switches to Google Maps whenever Places is on.
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const GOOGLE_MAP_ID = process.env.GOOGLE_MAP_ID || 'DEMO_MAP_ID';
const GOOGLE_DAILY_LIMIT = Number(process.env.GOOGLE_DAILY_LIMIT) || 30;
const places = GOOGLE_PLACES_KEY && GOOGLE_MAPS_KEY ? googlePlaces({ key: GOOGLE_PLACES_KEY, dailyLimit: GOOGLE_DAILY_LIMIT }) : null;
const allowGoogle = rateLimiter(20, 60 * 60 * 1000);
// Anonymous usage statistics (lib/stats.mjs): off unless both are set. The key is the project's
// secret (service role) key and stays on the server.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const stats = SUPABASE_URL && SUPABASE_KEY ? supabase({ url: SUPABASE_URL, key: SUPABASE_KEY }) : null;
const allowLog = rateLimiter(300, 60 * 60 * 1000);
// Optional accounts ride on the same Supabase project (lib/account.mjs).
const accounts = stats ? supabaseAuth({ url: SUPABASE_URL, key: SUPABASE_KEY }) : null;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || ''; // shown on the privacy page
const HOUR = 60 * 60 * 1000;
const pending = handoffs(), allowPoll = rateLimiter(1500, HOUR);
const allowCode = rateLimiter(6, HOUR), allowCodeTo = rateLimiter(3, HOUR), allowVerify = rateLimiter(30, HOUR), allowMe = rateLimiter(600, HOUR);
const UA = 'evroute (EV trip planner for Thailand)';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const PHOTON = 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q=';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse?limit=1&';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_Q = '[out:json][timeout:180];area["ISO3166-1"="TH"][admin_level=2]->.th;nwr["amenity"="charging_station"](area.th);out center tags;';
const OCM_URL = 'https://api.openchargemap.io/v3/poi/?output=json&countrycode=TH&maxresults=5000&compact=true&verbose=false';

const GEO_TTL = 10 * 60 * 1000;
const AREA_TTL = 30 * 24 * 60 * 60 * 1000; // districts don't move
const STATION_TTL = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000; // after a failed refresh, keep serving what we have and try again later
const MAX_BODY = 64 * 1024;
const MAX_POINTS = 20; // public Valhalla accepts up to 20 locations

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, code, obj, headers = {}) =>
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));

// ---------- geocode cache ----------
const cache = new Map(); // url -> { at, body, pending }

function cached(url, ttl) {
  const hit = cache.get(url);
  if (hit?.body && Date.now() - hit.at < ttl) return Promise.resolve({ body: hit.body, cache: 'HIT' });
  if (hit?.pending) return hit.pending;
  const pending = (async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      cache.set(url, { at: Date.now(), body });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return { body, cache: 'MISS' };
    } catch (err) {
      if (hit?.body) { cache.set(url, { at: hit.at, body: hit.body }); return { body: hit.body, cache: 'STALE' }; }
      cache.delete(url);
      throw err;
    }
  })();
  cache.set(url, { ...hit, pending });
  return pending;
}

// ---------- stations ----------
const sources = {
  curated: { list: [], at: 0, note: '' },
  osm: { list: [], at: 0, note: '' },
  ocm: { list: [], at: 0, note: OCM_KEY ? '' : 'ไม่ได้ตั้ง OCM_KEY' },
};
let stationsBody = null; // merged JSON, rebuilt when a source changes
let refreshing = null;

async function readJSON(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

// Re-read only when the file changes, so edits show up without a restart.
async function loadCurated() {
  try {
    const { mtimeMs } = await stat(join(ROOT, 'data/stations.json'));
    if (mtimeMs === sources.curated.mtime) return false;
    const d = await readJSON('data/stations.json');
    const list = (Array.isArray(d) ? d : d.stations || []).map(fromCurated).filter(Boolean);
    sources.curated = { list, at: mtimeMs, mtime: mtimeMs, note: '' };
  } catch (err) {
    if (sources.curated.mtime === -1) return false;
    sources.curated = { list: [], at: 0, mtime: -1, note: 'อ่าน data/stations.json ไม่ได้: ' + err.message };
  }
  return true;
}

function osmList(d) {
  return (d.elements || []).map(fromOSM).filter(Boolean);
}

async function loadOSMSnapshot() {
  try {
    const d = await readJSON('data/osm-th.json');
    sources.osm = { list: osmList(d), at: Date.parse(d.osm_base) || 0, note: 'snapshot' };
  } catch (err) {
    console.error('osm snapshot', err.message);
  }
}

async function refreshOSM() {
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(OVERPASS_Q), signal: AbortSignal.timeout(200000),
      });
      if (!r.ok) throw new Error('status ' + r.status);
      const d = await r.json();
      const list = osmList(d);
      if (list.length < 50) throw new Error('only ' + list.length + ' stations'); // a broken answer; keep the old list
      sources.osm = { list, at: Date.parse(d.osm3s?.timestamp_osm_base) || Date.now(), note: 'live', fetched: Date.now() };
      return;
    } catch (err) {
      console.error(new Date().toISOString(), 'overpass', ep, err.message);
    }
  }
  sources.osm.failed = Date.now();
}

async function refreshOCM() {
  if (!OCM_KEY) return;
  try {
    const r = await fetch(OCM_URL, { headers: { 'User-Agent': UA, 'X-API-Key': OCM_KEY }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    sources.ocm = { list: d.map(fromOCM).filter(Boolean), at: Date.now(), note: 'live', fetched: Date.now() };
  } catch (err) {
    console.error(new Date().toISOString(), 'ocm', err.message);
    sources.ocm.failed = Date.now();
  }
}

function due(src) {
  const last = Math.max(src.fetched || 0, src.failed ? src.failed - STATION_TTL + RETRY_MS : 0);
  return Date.now() - last > STATION_TTL;
}

function rebuild() {
  const stations = merge(sources.curated.list, users.list.map(fromUser), sources.ocm.list, sources.osm.list);
  const info = Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, { count: s.list.length, at: s.at ? new Date(s.at).toISOString() : null, note: s.note }]));
  info.user = { count: users.list.filter((s) => !s.hidden).length, at: usersAt ? new Date(usersAt).toISOString() : null, note: users.kind };
  stationsBody = Buffer.from(JSON.stringify({ updated: new Date().toISOString(), sources: info, stations }));
}

// Remote sources: each republishes as soon as it lands, so a slow Overpass doesn't hold up the others.
function refreshRemote() {
  if (refreshing) return refreshing;
  const jobs = [];
  if (due(sources.osm)) jobs.push(refreshOSM());
  if (OCM_KEY && due(sources.ocm)) jobs.push(refreshOCM());
  refreshing = Promise.all(jobs.map((j) => j.then(rebuild))).finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- user-added stations ----------
const users = userStations(GITHUB_TOKEN && GITHUB_REPO
  ? githubStore({ token: GITHUB_TOKEN, repo: GITHUB_REPO, branch: process.env.GITHUB_DATA_BRANCH || 'user-data' })
  : localStore(join(ROOT, 'data', 'user-stations.json')));
const USERS_TTL = 10 * 60 * 1000; // re-read so stations hidden on GitHub drop out
const allowAdd = rateLimiter(10, 60 * 60 * 1000);
let usersAt = 0;

async function reloadUsers() {
  usersAt = Date.now();
  try {
    await users.load();
    if (stationsBody) rebuild();
  } catch (err) {
    console.error(new Date().toISOString(), 'user stations', err.message);
  }
}

async function addStation(req, res) {
  if (!allowAdd(clientIp(req))) { json(res, 429, { error: 'เพิ่มสถานีบ่อยเกินไป ลองใหม่ในอีกสักครู่' }); return; }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); return; }
  const v = validate(body);
  if (v.error) { json(res, 400, { error: v.error }); return; }
  try {
    const rec = await users.add(v.station);
    rebuild();
    console.log(new Date().toISOString(), 'station added', rec.id, rec.name);
    json(res, 201, { station: fromUser(rec) });
  } catch (err) {
    console.error(new Date().toISOString(), 'add station', err.message);
    json(res, 502, { error: 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง' });
  }
}

// ---------- Google gap filling ----------
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

async function googleStations(req, res) {
  if (!places) { json(res, 404, { error: 'google disabled' }); return; }
  if (!allowGoogle(clientIp(req))) { json(res, 429, { error: 'too many requests' }); return; }
  let q;
  try { q = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad request' }); return; }
  const points = (Array.isArray(q.points) ? q.points : []).slice(0, 6)
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && p.lat > 5 && p.lat < 21 && p.lng > 97 && p.lng < 106);
  const radius = Math.min(30000, Math.max(5000, Number(q.radius) || 25000));
  if (!points.length) { json(res, 400, { error: 'no points' }); return; }
  try {
    const r = await places.search(points, radius);
    console.log(new Date().toISOString(), 'google places', r.calls, 'calls,', r.stations.length, 'stations,', r.remaining, 'left today');
    json(res, 200, r, { 'Cache-Control': 'no-store' });
  } catch (err) {
    console.error(new Date().toISOString(), 'google places', err.message);
    json(res, 502, { error: 'google unavailable' });
  }
}

// ---------- usage statistics ----------
// Answers at once and writes in the background: the page sends these with sendBeacon and never waits.
async function logStat(req, res) {
  if (!stats) { res.writeHead(204).end(); return; }
  if (!allowLog(clientIp(req))) { res.writeHead(429).end(); return; }
  let rec;
  try { rec = record(JSON.parse(await readBody(req))); } catch { rec = null; }
  if (!rec) { res.writeHead(400).end(); return; }
  // A signed-in driver's charging report joins their own history.
  if (rec[0] === 'charges' && accounts) {
    const user = await bearerUser(req).catch(() => null);
    if (user) rec[1].user_id = user.id;
  }
  res.writeHead(204).end();
  stats.insert(rec[0], rec[1])
    .then(() => { if (rec[0] === 'charges') reloadReports(); })
    .catch((err) => console.error(new Date().toISOString(), 'stats', err.message));
}

// Drivers' charging reports from the last 90 days, summed up per station for the page.
const REPORTS_TTL = 10 * 60 * 1000;
let reportsBody = '{"reports":{}}', reportsAt = 0;
async function reloadReports() {
  reportsAt = Date.now();
  if (!stats) return;
  try {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const rows = await stats.select('charges', 'select=station_id,ok,plug,max_kw,problem,created_at&created_at=gte.' + since + '&order=created_at.desc&limit=5000');
    reportsBody = JSON.stringify({ reports: summarize(rows) });
  } catch (err) {
    console.error(new Date().toISOString(), 'reports', err.message);
  }
}

// ---------- accounts ----------
async function bodyJSON(req) {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

function bearerUser(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? accounts.user(h.slice(7)) : Promise.resolve(null);
}

const say = (err) => console.error(new Date().toISOString(), 'account', err.message);

async function sendCode(req, res) {
  const email = cleanEmail((await bodyJSON(req))?.email);
  if (!email) { json(res, 400, { error: 'อีเมลไม่ถูกต้อง' }); return; }
  if (!allowCode(clientIp(req)) || !allowCodeTo(email)) { json(res, 429, { error: 'ขอรหัสบ่อยเกินไป รอสักครู่แล้วลองใหม่' }); return; }
  try {
    await accounts.sendCode(email);
    json(res, 200, pending.open(email), { 'Cache-Control': 'no-store' }); // { id, pair } for signing in from the email's link elsewhere

  } catch (err) {
    say(err);
    json(res, err.status === 429 ? 429 : 502, { error: err.status === 429 ? 'ขอรหัสบ่อยเกินไป รอสักครู่แล้วลองใหม่' : 'ส่งอีเมลไม่สำเร็จ ลองใหม่อีกครั้ง' });
  }
}

async function verifyCode(req, res) {
  if (!allowVerify(clientIp(req))) { json(res, 429, { error: 'ลองหลายครั้งเกินไป รอสักครู่' }); return; }
  const b = await bodyJSON(req), email = cleanEmail(b?.email), code = cleanCode(b?.code);
  if (!email || !code) { json(res, 400, { error: 'รหัสไม่ถูกต้อง' }); return; }
  try {
    json(res, 200, await accounts.verify(email, code), { 'Cache-Control': 'no-store' });
  } catch (err) {
    if (err.status >= 400 && err.status < 500) { json(res, 400, { error: 'รหัสไม่ถูกต้องหรือหมดอายุ ขอรหัสใหม่ได้' }); return; }
    say(err);
    json(res, 502, { error: 'ตรวจรหัสไม่สำเร็จ ลองใหม่อีกครั้ง' });
  }
}

async function refreshSession(req, res) {
  const t = (await bodyJSON(req))?.refresh_token;
  if (typeof t !== 'string' || !t || t.length > 2000) { res.writeHead(401).end(); return; }
  try {
    json(res, 200, await accounts.refresh(t), { 'Cache-Control': 'no-store' });
  } catch (err) {
    if (!(err.status >= 400 && err.status < 500)) say(err);
    res.writeHead(err.status >= 400 && err.status < 500 ? 401 : 502).end();
  }
}

// The asking browser waits here; once another device approves, it gets its own session.
async function pollHandoff(req, res, url) {
  if (!allowPoll(clientIp(req))) { res.writeHead(429).end(); return; }
  const id = url.searchParams.get('id'), h = pending.get(id);
  if (!h) { json(res, 404, { state: 'gone' }, { 'Cache-Control': 'no-store' }); return; }
  if (!h.ok) { json(res, 200, { state: 'wait' }, { 'Cache-Control': 'no-store' }); return; }
  pending.done(id);
  try {
    json(res, 200, { state: 'ok', session: await accounts.sessionFor(h.email) }, { 'Cache-Control': 'no-store' });
  } catch (err) {
    say(err);
    json(res, 502, { state: 'error' });
  }
}

// The signed-in device: which requests wait for this email, and approving or refusing one.
async function handoffApproval(req, res, url) {
  if (!allowMe(clientIp(req))) { res.writeHead(429).end(); return; }
  let user;
  try { user = await bearerUser(req); } catch (err) { say(err); res.writeHead(502).end(); return; }
  if (!user?.email) { res.writeHead(401).end(); return; }
  if (req.method === 'GET') { json(res, 200, { waiting: pending.waiting(user.email) }, { 'Cache-Control': 'no-store' }); return; }
  const b = await bodyJSON(req);
  if (b?.approve) json(res, pending.approve(b.id, user.email) ? 200 : 404, {});
  else { pending.deny(b?.id, user.email); json(res, 200, {}); }
}

// GET: the user's trips and charging history. PUT trips: replace the saved list. DELETE: the account.
async function me(req, res, url) {
  if (!allowMe(clientIp(req))) { res.writeHead(429).end(); return; }
  let user;
  try { user = await bearerUser(req); } catch (err) { say(err); res.writeHead(502).end(); return; }
  if (!user) { json(res, 401, { error: 'เข้าสู่ระบบใหม่อีกครั้ง' }); return; }
  const uid = encodeURIComponent(user.id);
  try {
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const [trips, charges] = await Promise.all([
        stats.select('trips', 'select=data&user_id=eq.' + uid + '&order=updated_at.desc&limit=50'),
        stats.select('charges', 'select=created_at,station_id,station_name,op,ok,problem,plug,soc_from,soc_to,kwh,baht,minutes,max_kw,odometer,car_id,battery_kwh&user_id=eq.' + uid + '&order=created_at.desc&limit=200'),
      ]);
      json(res, 200, { user, trips: trips.map((t) => t.data), charges, use: realUse(charges) }, { 'Cache-Control': 'no-store' });
    } else if (req.method === 'PUT' && url.pathname === '/api/me/trips') {
      const trips = cleanTrips((await bodyJSON(req))?.trips);
      if (!trips) { res.writeHead(400).end(); return; }
      // The page sends its whole list (newest first); keep that order through updated_at.
      const t0 = Date.now();
      await stats.remove('trips', 'user_id=eq.' + uid);
      await stats.insertMany('trips', trips.map((t, i) => ({ user_id: user.id, q: t.q, data: t, updated_at: new Date(t0 - i * 1000).toISOString() })));
      json(res, 200, { trips }, { 'Cache-Control': 'no-store' });
    } else if (req.method === 'DELETE' && url.pathname === '/api/me') {
      await accounts.deleteUser(user.id); // trips go with it; charging reports stay, unlinked
      console.log(new Date().toISOString(), 'account deleted');
      res.writeHead(204).end();
    } else {
      res.writeHead(405).end();
    }
  } catch (err) {
    say(err);
    json(res, 502, { error: 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง' });
  }
}

// ---------- route ----------
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

// Forward a route request, keeping only the options the page uses.
async function proxyRoute(req, res) {
  let q;
  try { q = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad request' }); return; }
  const locs = Array.isArray(q.locations) ? q.locations : [];
  if (locs.length < 2 || locs.length > MAX_POINTS || !locs.every((l) => Number.isFinite(l?.lat) && Number.isFinite(l?.lon))) {
    json(res, 400, { error: 'need 2 to ' + MAX_POINTS + ' locations' });
    return;
  }
  const body = {
    locations: locs.map((l) => ({ lat: l.lat, lon: l.lon, type: 'break' })),
    costing: 'auto', units: 'kilometers', directions_type: 'maneuvers',
  };
  try {
    const r = await fetch(VALHALLA, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40000),
    });
    // Pass Valhalla's own answer through, including "no path" errors the page explains to the user.
    json(res, r.status, Buffer.from(await r.arrayBuffer()), { 'Cache-Control': 'no-store' });
  } catch (err) {
    console.error(new Date().toISOString(), '/api/route', err.message);
    json(res, 502, { error: 'route service unavailable' });
  }
}

// ---------- static ----------
async function serveStatic(pathname, res) {
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, decodeURIComponent(pathname)));
  const rel = file.slice(ROOT.length);
  if (!file.startsWith(ROOT + '/') || /(^|\/)\.|^\/(lib|test|scripts|node_modules)\/|server\.mjs$|package\.json$/.test(rel)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(301, { Location: pathname + '/' }).end(); return; }
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname === '/api/route' && req.method === 'POST') {
    await proxyRoute(req, res);
    return;
  }
  if (url.pathname === '/api/stations' && req.method === 'POST') {
    await addStation(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me' || url.pathname === '/api/me/trips') {
    if (!accounts) { json(res, 404, { error: 'accounts disabled' }); return; }
    if (req.method === 'POST' && url.pathname === '/api/auth/code') await sendCode(req, res);
    else if (req.method === 'POST' && url.pathname === '/api/auth/verify') await verifyCode(req, res);
    else if (req.method === 'POST' && url.pathname === '/api/auth/refresh') await refreshSession(req, res);
    else if (req.method === 'GET' && url.pathname === '/api/auth/handoff') await pollHandoff(req, res, url);
    else if (url.pathname === '/api/auth/approve' && (req.method === 'GET' || req.method === 'POST')) await handoffApproval(req, res, url);
    else if (url.pathname.startsWith('/api/me')) await me(req, res, url);
    else res.writeHead(404).end();
    return;
  }
  if (url.pathname === '/api/log' && req.method === 'POST') {
    await logStat(req, res);
    return;
  }
  if (url.pathname === '/api/google/ev' && req.method === 'POST') {
    await googleStations(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (url.pathname === '/api/stations') {
    if (await loadCurated() || !stationsBody) rebuild();
    refreshRemote(); // stale-while-revalidate
    if (Date.now() - usersAt > USERS_TTL) reloadUsers();
    json(res, 200, stationsBody, { 'Cache-Control': 'public, max-age=300' });
    return;
  }
  if (url.pathname === '/api/config') {
    json(res, 200, {
      maps: places ? { key: GOOGLE_MAPS_KEY, mapId: GOOGLE_MAP_ID } : null,
      places: places ? { left: places.counter.remaining } : null,
      stats: !!stats,
      accounts: !!accounts,
      contact: CONTACT_EMAIL || null,
    }, { 'Cache-Control': 'no-store' });
    return;
  }
  if (url.pathname === '/api/reports') {
    if (Date.now() - reportsAt > REPORTS_TTL) reloadReports(); // stale-while-revalidate
    json(res, 200, reportsBody, { 'Cache-Control': 'public, max-age=60' });
    return;
  }
  if (url.pathname === '/api/area') {
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
    if (!(lat > 5 && lat < 21 && lng > 97 && lng < 106)) { res.writeHead(400).end(); return; }
    try {
      const r = await cached(PHOTON_REVERSE + 'lat=' + lat.toFixed(4) + '&lon=' + lng.toFixed(4), AREA_TTL);
      json(res, 200, areaFromPhoton(JSON.parse(r.body)), { 'Cache-Control': 'public, max-age=86400' });
    } catch (err) {
      console.error(new Date().toISOString(), '/api/area', err.message);
      json(res, 502, { error: 'geocoder unavailable' });
    }
    return;
  }
  if (url.pathname === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) { res.writeHead(400).end(); return; }
    try {
      const r = await cached(PHOTON + encodeURIComponent(q), GEO_TTL);
      json(res, 200, r.body, { 'Cache-Control': 'public, max-age=600', 'X-Cache': r.cache });
    } catch (err) {
      console.error(new Date().toISOString(), '/api/geocode', err.message);
      json(res, 502, { error: 'geocoder unavailable' });
    }
    return;
  }
  await serveStatic(url.pathname, res);
}).listen(PORT, () => {
  console.log(`EV trip planner on http://localhost:${PORT}`);
});

// Serve the bundled snapshot at once; the live refresh replaces it when Overpass answers.
reloadReports();
Promise.all([loadOSMSnapshot(), loadCurated(), reloadUsers()]).then(() => { rebuild(); return refreshRemote(); }).catch((err) => console.error('stations', err));
