import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoStore, photoName, cleanPhotoKey, jpegFromDataUrl, MAX_PHOTO } from '../lib/photos.mjs';
import { cleanPrefs } from '../lib/account.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

test('only a real JPEG data URL of a sensible size is taken', () => {
  assert.deepEqual(jpegFromDataUrl('data:image/jpeg;base64,' + JPEG.toString('base64')), JPEG);
  assert.equal(jpegFromDataUrl('data:image/png;base64,' + JPEG.toString('base64')), null);
  assert.equal(jpegFromDataUrl('data:image/jpeg;base64,' + Buffer.alloc(300, 1).toString('base64')), null); // not a JPEG inside
  assert.equal(jpegFromDataUrl('data:image/jpeg;base64,' + Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO)]).toString('base64')), null);
  assert.equal(cleanPhotoKey('photo:custom:chery|v23 4wd peak'), 'photo:custom:chery|v23 4wd peak');
  assert.equal(cleanPhotoKey('photo:../x'), 'photo:../x'); // only ever hashed into a file name
  assert.equal(cleanPhotoKey('photo:/x'), null);
  assert.equal(cleanPhotoKey('car:x'), null);
  assert.match(photoName('u1', 'photo:gac-aion-y-plus'), /^u1\/[0-9a-f]{32}\.jpg$/);
});

test('photos go to a private bucket made on first use, under the user', async () => {
  const calls = [];
  let bucketMade = false;
  const fetchFn = async (url, o = {}) => {
    calls.push({ url, o });
    if (url.endsWith('/storage/v1/bucket')) {
      if (bucketMade) return { ok: false, status: 400, text: async () => '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}' };
      bucketMade = true;
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (o.method === 'GET' || !o.method) return url.includes('/missing') ? { ok: false, status: 400, text: async () => 'not_found' } : { ok: true, status: 200, arrayBuffer: async () => JPEG };
    return { ok: true, status: 200, text: async () => '{}', json: async () => [{ name: 'a.jpg' }, { name: 'b.jpg' }] };
  };
  const s = photoStore({ url: 'https://p.supabase.co/', key: 'sb_secret_S', fetchFn });
  await s.put('u1', 'photo:tesla-m3-rwd', JPEG);
  assert.equal(calls[0].url, 'https://p.supabase.co/storage/v1/bucket');
  assert.deepEqual(JSON.parse(calls[0].o.body), { id: 'car-photos', name: 'car-photos', public: false, file_size_limit: MAX_PHOTO, allowed_mime_types: ['image/jpeg'] });
  assert.equal(calls[1].url, 'https://p.supabase.co/storage/v1/object/car-photos/' + photoName('u1', 'photo:tesla-m3-rwd'));
  assert.equal(calls[1].o.headers['x-upsert'], 'true');
  assert.equal(calls[1].o.headers.apikey, 'sb_secret_S');
  assert.equal(calls[1].o.headers.Authorization, undefined);
  await s.put('u1', 'photo:tesla-m3-rwd', JPEG);
  assert.equal(calls.filter((c) => c.url.endsWith('/bucket')).length, 1); // once per server start
  assert.deepEqual(await s.get('u1', 'photo:tesla-m3-rwd'), JPEG);
  // A bucket made earlier (another server start) is fine too.
  const again = photoStore({ url: 'https://p.supabase.co', key: 'eyJlegacy', fetchFn });
  await again.put('u2', 'photo:x', JPEG);
  assert.equal(calls.at(-1).o.headers.Authorization, 'Bearer eyJlegacy');
  await s.removeAll('u1');
  assert.deepEqual(JSON.parse(calls.at(-1).o.body), { prefixes: ['u1/a.jpg', 'u1/b.jpg'] });
});

test('the account lists at most 10 photos, newest kept', () => {
  const photos = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['photo:car-' + i, new Date(Date.UTC(2026, 10, 1 + i)).toISOString()]));
  const p = cleanPrefs({ photos: { ...photos, 'photo:/bad': '2026-11-30T00:00:00Z', 'nope': '2026-11-30T00:00:00Z', 'photo:x': 'not a date' } });
  assert.equal(Object.keys(p.photos).length, 10);
  assert.ok(p.photos['photo:car-11'] && !p.photos['photo:car-0'] && !p.photos['photo:car-1']);
});
