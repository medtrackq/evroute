// Car photos people add themselves (the "รูปรถของคุณ" button), kept with their account so every device
// they sign in on shows the same: Supabase Storage, a private bucket made on first use, one JPEG per
// user and car, read and written only through this server with the service key. The page keys a
// photo by car (photoKey in assets/js/app.js); the file is named by a hash of it under the user's id.
// Storage itself says which photos a user has and when each was put there (when()): nothing about
// them is kept anywhere else, so two devices can't overwrite each other's.
import { createHash } from 'node:crypto';

export const PHOTO_BUCKET = 'car-photos';
export const MAX_PHOTO = 1536 * 1024; // the page scales to 1280 px, JPEG 0.82: usually 150–500 KB

export const cleanPhotoKey = (k) => (typeof k === 'string' && /^photo:[^\s/\\]/.test(k) && k.length <= 140 ? k : null);
export const photoName = (uid, key) => uid + '/' + createHash('sha256').update(key).digest('hex').slice(0, 32) + '.jpg';

// A data: URL from the page → the JPEG's bytes, or null if it isn't one or is too big.
export function jpegFromDataUrl(s) {
  const m = typeof s === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 100 && buf.length <= MAX_PHOTO && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? buf : null;
}

export function photoStore({ url, key, fetchFn = fetch }) {
  const base = String(url).replace(/\/+$/, '') + '/storage/v1/';
  // As lib/stats.mjs: a legacy service_role JWT also goes as Bearer; a new sb_secret_ key in apikey only.
  const auth = key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {};
  const headers = (more) => ({ apikey: key, ...auth, ...more });
  const fail = async (what, r) => { const e = new Error('storage ' + what + ' ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160)); e.status = r.status; return e; };
  let bucket = null; // made (or found) once per server start

  function ensureBucket() {
    bucket ||= (async () => {
      const r = await fetchFn(base + 'bucket', {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ id: PHOTO_BUCKET, name: PHOTO_BUCKET, public: false, file_size_limit: MAX_PHOTO, allowed_mime_types: ['image/jpeg'] }),
      });
      if (r.ok) return;
      const text = await r.text().catch(() => '');
      if (/exist|duplicate/i.test(text) || r.status === 409) { // made before: keep its limits as here
        await fetchFn(base + 'bucket/' + PHOTO_BUCKET, {
          method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ public: false, file_size_limit: MAX_PHOTO, allowed_mime_types: ['image/jpeg'] }),
        }).catch(() => {});
        return;
      }
      const e = new Error('storage bucket ' + r.status + ' ' + text.slice(0, 160));
      e.status = r.status;
      throw e;
    })().catch((err) => { bucket = null; throw err; });
    return bucket;
  }

  return {
    async put(uid, photoKey, buf) {
      await ensureBucket();
      const r = await fetchFn(base + 'object/' + PHOTO_BUCKET + '/' + photoName(uid, photoKey), {
        method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'Cache-Control': 'no-cache' }), body: buf, signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw await fail('upload', r);
    },
    // The JPEG's bytes, or null when there's none.
    async get(uid, photoKey) {
      const r = await fetchFn(base + 'object/authenticated/' + PHOTO_BUCKET + '/' + photoName(uid, photoKey), { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (r.status === 404 || r.status === 400) return null; // Storage answers 400 "not_found" for a missing file or bucket
      if (!r.ok) throw await fail('download', r);
      return Buffer.from(await r.arrayBuffer());
    },
    async remove(uid, photoKeys) {
      if (!photoKeys.length) return;
      const r = await fetchFn(base + 'object/' + PHOTO_BUCKET, {
        method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: photoKeys.map((k) => photoName(uid, k)) }), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok && r.status !== 404 && r.status !== 400) throw await fail('delete', r);
    },
    // A user's files: name → when last put there.
    async list(uid) {
      const r = await fetchFn(base + 'object/list/' + PHOTO_BUCKET, {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ prefix: uid, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (!r.ok) throw await fail('list', r);
      const out = {};
      for (const o of await r.json()) if (o && /\.jpg$/.test(o.name || '')) out[uid + '/' + o.name] = o.updated_at || o.created_at || null;
      return out;
    },
    // The page's photo keys that have a photo: key → when it was put there.
    async when(uid, photoKeys) {
      const files = await this.list(uid);
      return Object.fromEntries(photoKeys.map((k) => [k, files[photoName(uid, k)]]).filter(([, at]) => at));
    },
    // Run when the server starts: can it make the bucket, and put, list, read and delete a file there?
    async check() {
      const probe = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(124)]);
      await this.put('_check', 'photo:check', probe);
      if (!(await this.when('_check', ['photo:check']))['photo:check']) throw new Error('storage check: the file put there is not in the list');
      const back = await this.get('_check', 'photo:check');
      await this.remove('_check', ['photo:check']);
      if (!back || !back.equals(probe)) throw new Error('storage check: the file put there did not come back');
    },
    // Every photo of a user, when the account is deleted.
    async removeAll(uid) {
      const names = Object.keys(await this.list(uid));
      if (!names.length) return;
      const d = await fetchFn(base + 'object/' + PHOTO_BUCKET, { method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: names }), signal: AbortSignal.timeout(15000) });
      if (!d.ok) throw await fail('delete', d);
    },
  };
}
