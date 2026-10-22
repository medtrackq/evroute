// Turns OpenStreetMap, Open Charge Map and the curated list into one station shape:
// { id, name, op, lat, lng, plugs: [{ type, kw, n, dc }], guess, src, addr, hours }
// type is one of CCS2, CHAdeMO, GBT, Type2, Type1, Tesla.

// Networks whose public sites are almost all DC fast chargers. Used only when a source
// gives no plug details, and the station is then marked as a guess.
const DC_NETWORKS = [
  [/pluz|ptt|ปตท/i, 'PTT EV Station PluZ'],
  [/elexa?\b|egat|กฟผ/i, 'EleXA'],
  [/volta|\bpea\b|กฟภ/i, 'PEA VOLTA'],
  [/\bea\b|ea anywhere|energy absolute/i, 'EA Anywhere'],
  [/tesla|supercharger/i, 'Tesla Supercharger'],
  [/altervim|bangchak|บางจาก/i, 'Altervim'],
  [/\bmea\b|กฟน/i, 'MEA EV'],
  [/evolt/i, 'Evolt'],
  [/sharge/i, 'Sharge'],
  [/shell/i, 'Shell Recharge'],
  [/\bbyd\b/i, 'BYD'],
  [/\bmg\b/i, 'MG'],
  [/spark/i, 'Spark EV'],
  [/onion/i, 'Onion EV'],
];

export function networkOf(text) {
  const hit = DC_NETWORKS.find(([re]) => re.test(text || ''));
  return hit ? hit[1] : null;
}

const OSM_SOCKETS = {
  type2_combo: { type: 'CCS2', dc: true },
  chademo: { type: 'CHAdeMO', dc: true },
  gb_dc: { type: 'GBT', dc: true },
  tesla_supercharger: { type: 'Tesla', dc: true },
  tesla_supercharger_ccs: { type: 'CCS2', dc: true },
  type2: { type: 'Type2', dc: false },
  type2_cable: { type: 'Type2', dc: false },
  type1: { type: 'Type1', dc: false },
};

function kw(v) {
  // "120 kW", "22 kw", "7.4", "50 kW;22 kW" -> largest number in kW
  const nums = String(v || '').match(/\d+(?:\.\d+)?/g);
  if (!nums) return 0;
  let best = Math.max(...nums.map(Number));
  if (/\bw\b/i.test(v) && !/kw/i.test(v) && best > 1000) best /= 1000;
  return best;
}

function count(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 1;
}

export function fromOSM(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (t.access === 'private' || t.access === 'no' || t.motorcar === 'no') return null;
  const plugs = [];
  for (const [key, def] of Object.entries(OSM_SOCKETS)) {
    if (!t['socket:' + key] || t['socket:' + key] === 'no') continue;
    plugs.push({ type: def.type, kw: kw(t['socket:' + key + ':output']), n: count(t['socket:' + key]), dc: def.dc });
  }
  const op = networkOf([t.operator, t.brand, t.network, t.name].join(' ')) || t.operator || t.brand || t.network || '';
  const st = {
    id: 'osm:' + el.type[0] + el.id,
    name: t['name:th'] || t.name || (op ? 'สถานีชาร์จ ' + op : 'สถานีชาร์จ EV'),
    op, lat, lng, plugs, guess: false, src: 'osm',
    addr: [t['addr:street'], t['addr:subdistrict'], t['addr:district'], t['addr:province']].filter(Boolean).join(' '),
    hours: t.opening_hours || '',
  };
  return guessPlugs(st, t.capacity);
}

const OCM_TYPES = { 33: 'CCS2', 2: 'CHAdeMO', 1036: 'Type2', 25: 'Type2', 1: 'Type1', 30: 'Tesla', 27: 'Tesla', 1039: 'GBT', 1040: 'GBT' };

export function fromOCM(p) {
  const a = p.AddressInfo || {};
  if (!Number.isFinite(a.Latitude) || !Number.isFinite(a.Longitude)) return null;
  if (p.StatusTypeID === 100 || p.StatusType?.IsOperational === false) return null; // removed / not operational
  const plugs = (p.Connections || []).map((c) => {
    const type = OCM_TYPES[c.ConnectionTypeID];
    if (!type) return null;
    const dc = c.CurrentTypeID === 30 || ['CCS2', 'CHAdeMO', 'GBT', 'Tesla'].includes(type);
    return { type, kw: Number(c.PowerKW) || 0, n: count(c.Quantity), dc };
  }).filter(Boolean);
  const opName = p.OperatorInfo?.Title || '';
  const st = {
    id: 'ocm:' + p.ID,
    name: a.Title || 'สถานีชาร์จ EV',
    op: networkOf(opName + ' ' + a.Title) || opName,
    lat: a.Latitude, lng: a.Longitude, plugs, guess: false, src: 'ocm',
    addr: [a.AddressLine1, a.Town, a.StateOrProvince].filter(Boolean).join(' '),
    hours: a.AccessComments || '',
  };
  return guessPlugs(st);
}

// Curated rows may say only "DC" (PEA VOLTA's list gives power but not the plug): Thai public
// DC chargers are CCS2, so assume that and mark the station as a guess. A missing kW is a guess too.
export function fromCurated(s, i) {
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return null;
  let guess = false;
  const plugs = (s.connectors || []).map((c) => {
    let type = c.type === 'GB/T' ? 'GBT' : c.type;
    if (type === 'DC') { type = 'CCS2'; guess = true; }
    const dc = c.dc ?? ['CCS2', 'CHAdeMO', 'GBT', 'Tesla'].includes(type);
    if (dc && !c.kw) guess = true;
    return { type, kw: Number(c.kw) || 0, n: count(c.count), dc };
  });
  return {
    // Keyed by position so the id survives edits to the list (favourites and shared links use it).
    id: 'cur:' + (s.id || s.lat.toFixed(5) + ',' + s.lng.toFixed(5)), name: s.name, op: networkOf(s.operator + ' ' + s.name) || s.operator || '',
    lat: s.lat, lng: s.lng, plugs, guess: guess || !plugs.length, src: 'curated',
    addr: s.address && s.province && s.address.includes(s.province) ? s.address : [s.address, s.province].filter(Boolean).join(' '),
    hours: s.hours || '', ref: s.source || '',
  };
}

// A known fast-charging network with no plug details: assume one CCS2 head at a modest 50 kW.
export function guessPlugs(st, capacity) {
  if (st.plugs.length) return st;
  if (DC_NETWORKS.some(([, name]) => name === st.op) && st.op !== 'BYD' && st.op !== 'MG') {
    st.plugs = st.op === 'Tesla Supercharger'
      ? [{ type: 'Tesla', kw: 150, n: count(capacity), dc: true }]
      : [{ type: 'CCS2', kw: 50, n: count(capacity), dc: true }];
    st.guess = true;
  }
  return st;
}

function near(a, b) {
  const x = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111320, y = (b.lat - a.lat) * 110570;
  return Math.sqrt(x * x + y * y);
}

// Earlier lists win: a station within 120 m of one already kept is the same site,
// though its plug list fills in a missing or guessed one.
export function merge(...lists) {
  const out = [];
  for (const list of lists) {
    for (const st of list) {
      if (!st) continue;
      const same = out.find((o) => Math.abs(o.lat - st.lat) < 0.002 && near(o, st) < 120);
      if (!same) { out.push(st); continue; }
      if ((same.guess || !same.plugs.length) && st.plugs.length && !st.guess) { same.plugs = st.plugs; same.guess = false; }
      if (!same.hours && st.hours) same.hours = st.hours;
      if (!same.addr && st.addr) same.addr = st.addr;
    }
  }
  return out;
}

// Photon's reverse geocode -> the district ("อำเภอ…", or "เขต…" in Bangkok) and the town or
// subdistrict, used as a search word in operator apps for stations whose address doesn't say.
export function areaFromPhoton(d) {
  const p = d?.features?.[0]?.properties || {};
  const strip = (v) => String(v || '').replace(/^(อำเภอ|เขต|ตำบล|แขวง|เทศบาล(นคร|เมือง|ตำบล)?)\s*/, '').trim() || null;
  return { amphoe: strip(p.county), sub: strip(p.city || p.district || p.locality), province: String(p.state || '').replace(/^จังหวัด/, '').trim() || null };
}

// A station a user added through the site. Admins hide one by setting "hidden": true in the file.
export function fromUser(s) {
  if (!s || s.hidden) return null;
  const st = fromCurated(s, 0);
  if (!st) return null;
  return { ...st, id: s.id, src: 'user', note: s.note || '', added: s.createdAt || '' };
}
