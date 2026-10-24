// What a driver can do while the car charges: food, coffee, toilets and shops within a short walk
// of each station. Places come from OpenStreetMap (Overpass, around our own stations); a station
// with nothing mapped nearby falls back to what its name or network says (a PTT station almost
// always has a Café Amazon, a shop and toilets), marked as a guess.
//
// A station's summary: { food, cafe, wc, shop, mall, names: [...], guess }
//   food/cafe/shop: how many places nearby, wc: 1 when there are toilets, mall: the mall's name.

export const WALK_M = 250;

// OSM tags -> one-letter kind: f food, c coffee, w toilets, s shop, m mall.
const KIND = {
  amenity: { restaurant: 'f', fast_food: 'f', food_court: 'f', cafe: 'c', toilets: 'w', fuel: 'w' }, // Thai fuel stations have toilets
  shop: { convenience: 's', supermarket: 's', mall: 'm', department_store: 'm' },
};
const VALUES = [...new Set(Object.values(KIND).flatMap((o) => Object.keys(o)))].join('|');

// One Overpass request for the places around these points (stations close together share one).
export function overpassQuery(points, r = WALK_M) {
  const seen = new Set(), parts = [];
  for (const p of points) {
    const key = p.lat.toFixed(3) + ',' + p.lng.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`nwr(around:${r},${p.lat.toFixed(5)},${p.lng.toFixed(5)})[~"^(amenity|shop)$"~"^(${VALUES})$"];`);
  }
  return '[out:json][timeout:240];(' + parts.join('') + ');out center tags;';
}

// An Overpass element -> [lat, lng, kind, name], or null.
export function fromOSMPlace(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  const kind = KIND.amenity[t.amenity] || KIND.shop[t.shop];
  if (!kind || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (t.access === 'private' || t.access === 'no') return null;
  const name = String(t.brand || t['name:th'] || t.name || '').slice(0, 60);
  return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, kind, name];
}

// Names and networks that say what is there.
const GUESSES = [
  [/central|เซ็นทรัล|the ?mall|เดอะมอลล์|robinson|โรบินสัน|lotus|โลตัส|big ?c\b|บิ๊กซี|terminal ?21|mega ?bangna|เมกา|future ?park|ฟิวเจอร์|fashion ?island|paragon|พารากอน|emporium|seacon|ซีคอน|plaza|พลาซ่า|ห้าง|\bmall\b|homepro|โฮมโปร|makro|แม็คโคร/i, 'm'],
  [/ptt|ปตท|pluz/i, 'cws', ['Café Amazon', '7-Eleven']],
  [/bangchak|บางจาก|altervim/i, 'cws', ['Inthanin']],
  [/shell|เชลล์/i, 'cws'],
  [/\bpt\b|พีที|max ?mart/i, 'cws', ['Punthai']],
  [/caltex|คาลเท็กซ์|esso|เอสโซ่|susco|ซัสโก้/i, 'ws'],
  [/7-?eleven|เซเว่น|lawson|ลอว์สัน|family ?mart|cj ?more|tops|ท็อปส์/i, 's'],
  [/starbucks|สตาร์บัคส์|amazon|coffee|คาเฟ่|cafe|กาแฟ/i, 'c'],
  [/mcdonald|แมคโดนัลด์|kfc|เคเอฟซี|restaurant|ร้านอาหาร|ภัตตาคาร|ครัว/i, 'f'],
];

export function fromName(st) {
  const text = [st.name, st.op, st.addr].join(' ');
  const out = new Set(), names = [];
  for (const [re, kinds, brands] of GUESSES) {
    if (!re.test(text)) continue;
    for (const k of kinds) out.add(k);
    for (const b of brands || []) if (!names.includes(b)) names.push(b);
  }
  return { kinds: out, names };
}

function metres(a, b) {
  const x = (b[1] - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111320, y = (b[0] - a.lat) * 110570;
  return Math.sqrt(x * x + y * y);
}

// Places bucketed by 0.01° (about 1 km) so each station looks at its own neighbourhood only.
export function placeIndex(places) {
  const grid = new Map();
  for (const p of places || []) {
    const k = Math.floor(p[0] * 100) + ':' + Math.floor(p[1] * 100);
    (grid.get(k) || grid.set(k, []).get(k)).push(p);
  }
  return {
    near(st, r = WALK_M) {
      const out = [], la = Math.floor(st.lat * 100), ln = Math.floor(st.lng * 100);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const p of grid.get((la + i) + ':' + (ln + j)) || []) if (metres(st, p) <= r) out.push(p);
      }
      return out;
    },
  };
}

const ORDER = { m: 0, c: 1, f: 2, s: 3, w: 4 };

// The summary for one station, or null when nothing is known.
export function amenitiesOf(st, index) {
  const near = index ? index.near(st) : [];
  const n = { f: 0, c: 0, w: 0, s: 0, m: 0 }, names = [];
  let mall = '';
  near.sort((a, b) => ORDER[a[2]] - ORDER[b[2]] || metres(st, a) - metres(st, b)).forEach((p) => {
    n[p[2]]++;
    if (p[2] === 'm' && !mall) mall = p[3] || 'ห้างสรรพสินค้า';
    if (p[3] && p[2] !== 'w' && !names.includes(p[3])) names.push(p[3]);
  });
  const g = fromName(st);
  if (!near.length && !g.kinds.size) return null;
  // A mall has food, coffee, toilets and shops even when the map only shows the mall itself.
  const inMall = n.m > 0 || g.kinds.has('m');
  const has = (k) => n[k] > 0 || g.kinds.has(k) || inMall;
  g.names.forEach((b) => { if (!names.includes(b)) names.push(b); });
  return {
    food: has('f') ? Math.max(1, n.f) : 0,
    cafe: has('c') ? Math.max(1, n.c) : 0,
    wc: has('w') ? 1 : 0,
    shop: has('s') ? Math.max(1, n.s) : 0,
    mall: mall || (g.kinds.has('m') ? st.name : ''),
    names: names.filter((x) => x !== st.name && x !== mall).slice(0, 4),
    guess: !near.length, // only from the name: "probably"
  };
}
