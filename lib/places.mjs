// Places to see on the way added or changed on the admin page (the trip_places table in Supabase),
// on top of data/trip-places.json. The page loads the two together from /api/trip-places, so a place
// added in the admin shows up without a deploy. A row with the id of a bundled place replaces it;
// "hidden" takes it off the list.

export const CATS = ['temple', 'cafe', 'food', 'view', 'shop', 'kids'];
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const inThailand = (lat, lng) => lat > 5.5 && lat < 20.6 && lng > 97.3 && lng < 105.7;

// An id from the English name if there is one ("Farm Chokchai" -> "farm-chokchai"), else a new one.
export function placeId(nameEn, now = Date.now()) {
  const id = text(nameEn, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return id.length >= 3 ? id : 'place-' + now.toString(36);
}

// Coordinates from what an admin pastes: a Google Maps link (the place pin !3d..!4d.. before the
// map centre @..), a ?q= / ?ll= / ?destination= link, or plain "lat, lng". null when none is there.
export function parseLatLng(s) {
  const t = decodeURIComponent(String(s || '')).trim();
  const m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t)
    || /[?&](?:q|ll|query|destination|center)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(t)
    || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(t)
    || /^(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{2,3}\.\d+)$/.exec(t);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return inThailand(lat, lng) ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } : null;
}

// Short Google Maps links (maps.app.goo.gl/...) only say where they lead when followed. Follows
// at most five redirects, on Google's own hosts only, and returns the last address.
const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co)\//;
const GOOGLE = /^https:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl|g\.co)\//;
export async function followShort(url, fetchFn = fetch) {
  let u = String(url || '').trim();
  if (!SHORT.test(u)) return u;
  for (let i = 0; i < 5 && GOOGLE.test(u); i++) {
    const r = await fetchFn(u, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const next = r.headers.get('location');
    if (!next) break;
    u = new URL(next, u).toString();
    const cont = /consent\.google\.[a-z.]+\/.*[?&]continue=([^&]+)/.exec(u); // a consent page carries the address
    if (cont) u = decodeURIComponent(cont[1]);
    if (parseLatLng(u)) break;
  }
  return u;
}

// A row from the admin form, or { error } saying what is wrong.
export function cleanPlace(d, now = Date.now()) {
  if (!d || typeof d !== 'object') return { error: 'ข้อมูลไม่ครบ' };
  const name = text(d.name, 80), nameEn = text(d.name_en, 80);
  const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim().toLowerCase() : placeId(nameEn, now);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) return { error: 'รหัส (id) ใช้ได้เฉพาะ a-z 0-9 และ - ยาว 2–40 ตัว' };
  const hidden = d.hidden === true;
  if (hidden) return { id, name: name || id, hidden: true, cat: [], checked: false, partner: false };
  if (name.length < 2) return { error: 'ใส่ชื่อสถานที่' };
  const cat = Array.isArray(d.cat) ? CATS.filter((c) => d.cat.includes(c)) : [];
  if (!cat.length) return { error: 'เลือกประเภทอย่างน้อย 1 อย่าง' };
  const lat = Number(d.lat), lng = Number(d.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inThailand(lat, lng)) return { error: 'ใส่ตำแหน่งในประเทศไทย (วางลิงก์ Google Maps แล้วกด "หาพิกัด")' };
  const visit = Math.round(Number(d.visit));
  if (!(visit >= 5 && visit <= 600)) return { error: 'เวลาเที่ยวต้องอยู่ระหว่าง 5–600 นาที' };
  const link = text(d.link, 300);
  if (link && !/^https:\/\/[^\s<>"']+$/.test(link)) return { error: 'ลิงก์ร้านต้องขึ้นต้นด้วย https://' };
  const months = Array.isArray(d.months) ? [...new Set(d.months.map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b) : [];
  return {
    id, name, name_en: nameEn || null, cat, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    prov: text(d.prov, 40) || null, area: text(d.area, 40) || null, visit,
    note: text(d.note, 120) || null, promo: text(d.promo, 120) || null, link: link || null,
    months: months.length && months.length < 12 ? months : null,
    partner: d.partner === true, checked: d.checked !== false, hidden: false,
  };
}

// The list the page gets: bundled places, then the admin's rows (same id replaces, hidden removes,
// new ids are added). Empty fields are left out.
export function mergePlaces(bundled, rows) {
  const byId = new Map((bundled || []).map((p) => [p.id, p]));
  for (const r of rows || []) {
    if (r.hidden) { byId.delete(r.id); continue; }
    const p = {};
    for (const k of ['id', 'name', 'name_en', 'cat', 'lat', 'lng', 'prov', 'area', 'visit', 'note', 'promo', 'link', 'months', 'partner', 'checked']) {
      if (r[k] != null && r[k] !== '') p[k] = k === 'lat' || k === 'lng' || k === 'visit' ? Number(r[k]) : r[k];
    }
    byId.set(r.id, p);
  }
  return [...byId.values()];
}
