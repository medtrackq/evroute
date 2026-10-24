// Google Places (New) as a gap filler: the page asks for EV stations only around stretches of a
// route where our own data has none in reach. Places content may not be cached (place IDs may),
// so every call goes to Google; a daily cap keeps usage inside the free tier, and Google Cloud's
// own per-day quota should be set as the hard stop.

import { networkOf, guessPlugs } from './stations.mjs';

const NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';
const TEXT = 'https://places.googleapis.com/v1/places:searchText';
// Networks with many sites that publish no list: asked for by name around the planned stops.
export const BRANDS = { pluz: 'PTT EV Station PluZ' };
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
  // Google often has no connector details; a known DC network then gets the same guess as OSM.
  return guessPlugs({
    id: 'g:' + p.id, name, op: networkOf(name) || '', lat, lng, plugs,
    guess: !plugs.some((x) => x.dc && x.kw), src: 'google',
    addr: p.formattedAddress || '', hours: '', url: p.googleMapsUri || '',
  });
}

function metres(a, b) {
  const x = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111320, y = (b.lat - a.lat) * 110570;
  return Math.sqrt(x * x + y * y);
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

  // One network's stations around a point, by name (a Nearby search returns the 20 closest
  // chargers of any kind, which in a town crowds a network out).
  async function named(center, radius, query) {
    const r = await fetchFn(TEXT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({
        textQuery: query, includedType: 'electric_vehicle_charging_station', strictTypeFiltering: true, pageSize: 20,
        languageCode: 'th', regionCode: 'TH',
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('places text ' + r.status + ' ' + (d.error?.status || ''));
    // The circle only biases a text search: keep what is really near.
    return (d.places || []).map(fromGoogle).filter((st) => st && metres(center, st) <= radius * 1.2);
  }

  // For the monthly sweep (lib/sweep.mjs): EV stations of a network inside a rectangle. Only id,
  // name and position (the "Pro" price, 5,000 free a month), and outside the daily allowance.
  async function inBox(c, query) {
    const r = await fetchFn(TEXT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.businessStatus' },
      body: JSON.stringify({
        textQuery: query, includedType: 'electric_vehicle_charging_station', strictTypeFiltering: true, pageSize: 20,
        languageCode: 'th', regionCode: 'TH',
        locationRestriction: { rectangle: { low: { latitude: c.s, longitude: c.w }, high: { latitude: c.n, longitude: c.e } } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('places sweep ' + r.status + ' ' + (d.error?.status || '') + ' ' + (d.error?.message || '').slice(0, 120));
    return (d.places || []).filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL')
      .map((p) => ({ id: p.id, name: p.displayName?.text || '', lat: p.location?.latitude, lng: p.location?.longitude }));
  }

  return {
    counter,
    sweepAsk: (c) => inBox(c, BRANDS.pluz),
    // Search circles around the given points, as many as today's allowance lets us; with a
    // brand (a BRANDS key), that network's stations only.
    async search(points, radius, brand) {
      const seen = new Map();
      let calls = 0, capped = false;
      for (const pt of points) {
        if (!counter.take()) { capped = true; break; }
        calls++;
        for (const st of await (BRANDS[brand] ? named(pt, radius, BRANDS[brand]) : nearby(pt, radius))) seen.set(st.id, st);
      }
      return { stations: [...seen.values()], calls, capped, remaining: counter.remaining };
    },
  };
}
