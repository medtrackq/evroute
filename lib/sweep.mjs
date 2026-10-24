// A monthly sweep of Google Places for PTT EV Station PluZ (over a thousand sites, no public list).
// Thailand is cut into squares about 45 km wide; each is one Text Search restricted to it, and a
// square whose answer is full (20 places, the most one call returns) is cut into four and asked
// again. Only the place id, position and our own reading of the name ("which network") are kept,
// for at most 30 days, as Google's terms allow; the page shows them on the Google map only.
// Asking for id, name and position only is the Text Search "Pro" price (5,000 free calls a month).

// Thailand's outline, simplified and a little generous (lat, lng), clockwise from Mae Sai.
const THAILAND = [
  [20.5, 99.85], [20.4, 100.55], [19.6, 101.3], [18.4, 101.15], [17.85, 101.6], [17.95, 102.6], [18.45, 103.7],
  [17.5, 104.85], [16.5, 104.85], [15.9, 105.4], [15.2, 105.65], [14.3, 105.25], [14.4, 103.9], [14.3, 102.9],
  [13.6, 102.65], [12.6, 102.6], [11.6, 103.0], [12.1, 102.3], [12.55, 101.9], [12.55, 100.8], [13.4, 100.85],
  [13.5, 100.4], [13.2, 99.95], [12.3, 100.05], [11.6, 99.85], [10.4, 99.3], [9.6, 100.2], [8.3, 100.4],
  [7.0, 100.75], [6.8, 101.6], [6.2, 102.15], [5.6, 101.2], [6.4, 100.2], [6.5, 99.6], [7.5, 99.2], [7.6, 98.2], [8.0, 98.1],
  [9.0, 98.1], [10.0, 98.4], [10.6, 98.75], [11.8, 99.5], [13.0, 99.1], [14.3, 98.4], [15.3, 98.1], [16.4, 98.5],
  [17.4, 97.7], [18.5, 97.3], [19.8, 97.7], [20.1, 98.9], [20.35, 99.4],
];

export function inThailand(lat, lng) {
  let inside = false;
  for (let i = 0, j = THAILAND.length - 1; i < THAILAND.length; j = i++) {
    const [ay, ax] = THAILAND[i], [by, bx] = THAILAND[j];
    if ((ay > lat) !== (by > lat) && lng < (bx - ax) * (lat - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

// Squares { s, w, n, e } of `size` degrees that touch Thailand (any of nine sample points inside).
export function cells(size = 0.4) {
  const out = [];
  for (let s = 5.6; s < 20.5; s += size) {
    for (let w = 97.3; w < 105.7; w += size) {
      const c = { s: +s.toFixed(4), w: +w.toFixed(4), n: +(s + size).toFixed(4), e: +(w + size).toFixed(4) };
      let hit = false;
      for (let i = 0; i <= 2 && !hit; i++) for (let j = 0; j <= 2 && !hit; j++) hit = inThailand(c.s + (c.n - c.s) * i / 2, c.w + (c.e - c.w) * j / 2);
      if (hit) out.push(c);
    }
  }
  return out;
}

export function quarter(c) {
  const mLat = +((c.s + c.n) / 2).toFixed(5), mLng = +((c.w + c.e) / 2).toFixed(5);
  return [
    { s: c.s, w: c.w, n: mLat, e: mLng }, { s: c.s, w: mLng, n: mLat, e: c.e },
    { s: mLat, w: c.w, n: c.n, e: mLng }, { s: mLat, w: mLng, n: c.n, e: c.e },
  ];
}

const FULL = 20;       // a Text Search answers with at most 20 places
const SMALLEST = 0.05; // ~5 km: don't cut finer than this

// The sweep. ask(cell) -> [{ id, name, lat, lng }] (one Google call); store: see server.mjs.
// Picks up where a stopped sweep left off (cursor = squares done). Returns the sweep's record.
export async function sweep({ ask, store, cap, networkOf, wait = 120, log = () => {} }) {
  const list = cells();
  let run = await store.current();
  if (!run) run = await store.start(list.length);
  let calls = run.calls || 0, found = run.found || 0;
  for (let i = run.cursor || 0; i < list.length; i++) {
    const queue = [list[i]], batch = new Map();
    while (queue.length) {
      if (calls >= cap) {
        await store.save([...batch.values()]);
        return store.finish(run.id, { status: 'capped', calls, found: found + batch.size, cursor: i });
      }
      const c = queue.shift();
      const places = await ask(c);
      calls++;
      for (const p of places) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        batch.set(p.id, { place_id: p.id, lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6, op: networkOf(p.name) || null });
      }
      if (places.length >= FULL && c.n - c.s > SMALLEST) queue.push(...quarter(c));
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
    await store.save([...batch.values()]);
    found += batch.size;
    if (i % 10 === 9) { await store.progress(run.id, { cursor: i + 1, calls, found }); log(`${i + 1}/${list.length} squares, ${calls} calls`); }
  }
  return store.finish(run.id, { status: 'done', calls, found, cursor: list.length });
}
