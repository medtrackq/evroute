// Google Places (New) as a gap filler: the page asks for EV stations only around stretches of a
// route where our own data has none in reach. Places content may not be cached (place IDs may),
// so every call goes to Google; a daily cap keeps usage inside the free tier, and Google Cloud's
// own per-day quota should be set as the hard stop.

import { networkOf } from './stations.mjs';

const NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELDS = 'places.id,places.displayName,places.location,places.formattedAddress,places.evChargeOptions,places.googleMapsUri,places.businessStatus';
const TYPES = {
  EV_CONNECTOR_TYPE_CCS_COMBO_2: { type: 'CCS2', dc: true },
  EV_CONNECTOR_TYPE_CHADEMO: { type: 'CHAdeMO', dc: true },
  EV_CONNECTOR_TYPE_UNSPECIFIED_GB_T: { type: 'GBT', dc: true },
  EV_CONNECTOR_TYPE_TESLA: { type: 'Tesla', dc: true },
  EV_CONNECTOR_TYPE_NACS: { type: 'Tesla', dc: true },
  EV_CONNECTOR_TYPE_TYPE_2: { type: 'Type2', dc: false },
  EV_CONNECTOR_TYPE_J1772: { type: 'Type1', dc: false },
};
const DC_MIN_KW = 25; // a "Type 2" aggregation above this is a DC socket mislabelled; below it, AC

// One Google place -> our station shape (see lib/stations.mjs).
export function fromGoogle(p) {
  const lat = p.location?.latitude, lng = p.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return null;
  const name = p.displayName?.text || 'สถานีชาร์จ EV';
  const plugs = (p.evChargeOptions?.connectorAggregation || []).map((a) => {
    const def = TYPES[a.type];
    if (!def) return null;
    const kw = Number(a.maxChargeRateKw) || 0;
    return { type: def.type, kw, n: Number(a.count) || 1, dc: def.dc || kw >= DC_MIN_KW };
  }).filter(Boolean);
  return {
    id: 'g:' + p.id, name, op: networkOf(name) || '', lat, lng, plugs,
    guess: !plugs.some((x) => x.dc && x.kw), src: 'google',
    addr: p.formattedAddress || '', hours: '', url: p.googleMapsUri || '',
  };
}

// Counts calls per Bangkok calendar day.
export function dailyCounter(limit, now = () => Date.now()) {
  let day = '', used = 0;
  const today = () => new Date(now() + 7 * 3600e3).toISOString().slice(0, 10);
  return {
    get used() { if (today() !== day) { day = today(); used = 0; } return used; },
    get remaining() { return Math.max(0, limit - this.used); },
    take() { if (this.remaining <= 0) return false; used++; return true; },
  };
}

export function googlePlaces({ key, dailyLimit = 30, fetchFn = fetch }) {
  const counter = dailyCounter(dailyLimit);

  async function nearby(center, radius) {
    const r = await fetchFn(NEARBY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({
        includedTypes: ['electric_vehicle_charging_station'], maxResultCount: 20, rankPreference: 'DISTANCE',
        languageCode: 'th', regionCode: 'TH',
        locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('places ' + r.status + ' ' + (d.error?.status || ''));
    return (d.places || []).map(fromGoogle).filter(Boolean);
  }

  return {
    counter,
    // Search circles around the given points, as many as today's allowance lets us.
    async search(points, radius) {
      const seen = new Map();
      let calls = 0, capped = false;
      for (const pt of points) {
        if (!counter.take()) { capped = true; break; }
        calls++;
        for (const st of await nearby(pt, radius)) seen.set(st.id, st);
      }
      return { stations: [...seen.values()], calls, capped, remaining: counter.remaining };
    },
  };
}
