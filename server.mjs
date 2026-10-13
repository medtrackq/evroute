// Static file server plus cached proxies for the EV trip planner.
// Stations: the curated list (data/stations.json), OpenStreetMap via Overpass (refreshed daily,
// falling back to the bundled data/osm-th.json snapshot) and Open Charge Map when OCM_KEY is set.
// Routes: public FOSSGIS Valhalla. Place search: Komoot Photon.
// No dependencies: `node server.mjs` (PORT defaults to 8080).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromOSM, fromOCM, fromCurated, fromUser, merge } from './lib/stations.mjs';
import { validate, localStore, githubStore, userStations, rateLimiter } from './lib/userstore.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const OCM_KEY = process.env.OCM_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // owner/name
const UA = 'evroute (EV trip planner for Thailand)';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const PHOTON = 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q=';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_Q = '[out:json][timeout:180];area["ISO3166-1"="TH"][admin_level=2]->.th;nwr["amenity"="charging_station"](area.th);out center tags;';
const OCM_URL = 'https://api.openchargemap.io/v3/poi/?output=json&countrycode=TH&maxresults=5000&compact=true&verbose=false';

const GEO_TTL = 10 * 60 * 1000;
const STATION_TTL = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000; // after a failed refresh, keep serving what we have and try again later
const MAX_BODY = 64 * 1024;
const MAX_STOPS = 12;

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
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowAdd(ip)) { json(res, 429, { error: 'เพิ่มสถานีบ่อยเกินไป ลองใหม่ในอีกสักครู่' }); return; }
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
  if (locs.length < 2 || locs.length > MAX_STOPS + 2 || !locs.every((l) => Number.isFinite(l?.lat) && Number.isFinite(l?.lon))) {
    json(res, 400, { error: 'need 2 to ' + (MAX_STOPS + 2) + ' locations' });
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
Promise.all([loadOSMSnapshot(), loadCurated(), reloadUsers()]).then(() => { rebuild(); return refreshRemote(); }).catch((err) => console.error('stations', err));
