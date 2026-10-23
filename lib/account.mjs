// Optional accounts: sign in with an emailed one-time code (Supabase Auth), then saved trips follow
// the user to any device and charging reports become their own history. The page talks only to our
// server; the Supabase secret key never leaves it.

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function cleanEmail(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

// Supabase's code length is a project setting (6 by default).
export function cleanCode(v) {
  const c = typeof v === 'string' ? v.replace(/\s+/g, '') : '';
  return /^\d{6,10}$/.test(c) ? c : null;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// A saved trip as the page keeps it (see savePlan in app.js); anything else is dropped.
export function cleanTrip(t) {
  if (!t || typeof t !== 'object' || typeof t.q !== 'string' || !/^\?[^#\s]{1,4000}$/.test(t.q)) return null;
  return {
    q: t.q, title: str(t.title, 120), from: str(t.from, 120), car: str(t.car, 80),
    km: num(t.km), stops: num(t.stops), at: str(t.at, 40), dep: str(t.dep, 20),
    cost: t.cost == null ? null : num(t.cost), mins: num(t.mins),
  };
}

export const MAX_TRIPS = 50;

export function cleanTrips(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set(), out = [];
  for (const t of list) {
    const c = cleanTrip(t);
    if (!c || seen.has(c.q)) continue;
    seen.add(c.q);
    out.push(c);
    if (out.length >= MAX_TRIPS) break;
  }
  return out;
}

// Supabase Auth REST: send a code, check it, refresh a session, look up the user behind a token,
// and delete a user. Signed-in users are looked up once per token for a few minutes.
export function supabaseAuth({ url, key, fetchFn = fetch, now = () => Date.now() }) {
  const base = url.replace(/\/+$/, '') + '/auth/v1/';
  const admin = key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}; // see lib/stats.mjs
  const users = new Map(); // access token -> { user, until }

  async function call(path, { method = 'POST', body, token } = {}) {
    const headers = { apikey: key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : admin) };
    const r = await fetchFn(base + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error('auth ' + path.split('?')[0] + ' ' + r.status + ' ' + (d.error_code || d.code || d.msg || d.error || ''));
      err.status = r.status;
      throw err;
    }
    return d;
  }

  const session = (d) => ({
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(now() / 1000) + (d.expires_in || 3600),
    user: { id: d.user?.id, email: d.user?.email },
  });

  return {
    sendCode: (email) => call('otp', { body: { email, create_user: true } }),
    verify: async (email, code) => session(await call('verify', { body: { type: 'email', email, token: code } })),
    refresh: async (refreshToken) => session(await call('token?grant_type=refresh_token', { body: { refresh_token: refreshToken } })),
    async user(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
      const hit = users.get(token);
      if (hit && hit.until > now()) return hit.user;
      try {
        const d = await call('user', { method: 'GET', token });
        const user = d?.id ? { id: d.id, email: d.email } : null;
        users.set(token, { user, until: now() + 5 * 60 * 1000 });
        if (users.size > 5000) users.delete(users.keys().next().value);
        return user;
      } catch (err) {
        if (err.status === 401 || err.status === 403) return null;
        throw err;
      }
    },
    // A fresh session for a user who already proved they own the email (on another device), made
    // without sending mail: an admin one-time link token, redeemed at once.
    async sessionFor(email) {
      const d = await call('admin/generate_link', { body: { type: 'magiclink', email } });
      const hash = d.hashed_token || d.properties?.hashed_token;
      if (!hash) throw new Error('auth generate_link: no token');
      return session(await call('verify', { body: { type: d.verification_type || d.properties?.verification_type || 'magiclink', token_hash: hash } }));
    },
    async deleteUser(id) {
      for (const [t, v] of users) if (v.user?.id === id) users.delete(t);
      await call('admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
    },
  };
}

// Sign-in requests waiting to be approved from another device. The email's link often opens in a
// different browser from the one the user asked in (Gmail on iPhone opens Chrome, not Safari). The
// asking browser shows a two-digit number and waits; the browser the link opened shows the same
// number and asks the user to approve, so a request someone else made for this email isn't let in
// by mistake. Kept in memory for 15 minutes.
export function handoffs({ ttl = 15 * 60 * 1000, now = () => Date.now(), random = Math.random } = {}) {
  const items = new Map(); // id -> { email, pair, at, ok }
  const sweep = () => { for (const [id, h] of items) if (now() - h.at > ttl) items.delete(id); };
  const newId = () => Array.from({ length: 4 }, () => Math.floor(random() * 2 ** 32).toString(36).padStart(7, '0')).join('');
  return {
    open(email) {
      sweep();
      if (items.size > 10000) items.delete(items.keys().next().value);
      const id = newId(), pair = String(10 + Math.floor(random() * 90));
      items.set(id, { email, pair, at: now(), ok: false });
      return { id, pair };
    },
    // What the asking browser polls: null (unknown or expired), or the request.
    get(id) { sweep(); return (typeof id === 'string' && items.get(id)) || null; },
    done(id) { items.delete(id); },
    // Requests for this email, for the signed-in device to approve.
    waiting(email) {
      sweep();
      return [...items].filter(([, h]) => h.email === email && !h.ok).map(([id, h]) => ({ id, pair: h.pair, at: h.at }));
    },
    approve(id, email) {
      const h = this.get(id);
      if (!h || h.email !== email) return false;
      h.ok = true;
      return true;
    },
    deny(id, email) {
      const h = this.get(id);
      if (h && h.email === email) items.delete(id);
    },
  };
}

// Real consumption from a driver's own charging reports (newest first): between two reports of
// the same car, distance from the odometer and energy from the battery drop. The same rules as the
// car_consumption view in db/schema.sql.
export function realUse(charges) {
  const byCar = {};
  [...charges].reverse().forEach((c) => {
    if (!c.ok || c.odometer == null || c.soc_from == null || c.soc_to == null || !c.battery_kwh) return;
    const k = c.car_id || '?', prev = byCar[k]?.last;
    const car = byCar[k] || (byCar[k] = { km: 0, kwh: 0, segments: 0, last: null });
    if (prev) {
      const km = c.odometer - prev.odometer, kwh = (prev.soc_to - c.soc_from) / 100 * c.battery_kwh;
      if (km >= 20 && km <= 800 && kwh > 0 && kwh / km * 100 >= 8 && kwh / km * 100 <= 40) {
        car.km += km; car.kwh += kwh; car.segments++;
      }
    }
    car.last = c;
  });
  const out = {};
  for (const [k, v] of Object.entries(byCar)) if (v.segments) out[k] = { kwh100: Math.round(v.kwh / v.km * 1000) / 10, km: Math.round(v.km), segments: v.segments };
  return out;
}
