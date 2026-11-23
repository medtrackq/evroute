import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoStore, photoName, cleanPhotoKey, jpegFromDataUrl, MAX_PHOTO } from '../lib/photos.mjs';

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
    return { ok: true, status: 200, text: async () => '{}', json: async () => [{ name: photoName('u1', 'photo:tesla-m3-rwd').slice(3), updated_at: '2026-11-23T05:00:00.000Z' }, { name: 'b.jpg', updated_at: '2026-11-23T04:00:00.000Z' }, { name: '.emptyFolderPlaceholder' }] };
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
  // Storage says which cars have a photo, and when it was put there.
  assert.deepEqual(await s.when('u1', ['photo:tesla-m3-rwd', 'photo:byd-atto3-std']), { 'photo:tesla-m3-rwd': '2026-11-23T05:00:00.000Z' });
  assert.equal(JSON.parse(calls.at(-1).o.body).prefix, 'u1');
  await s.removeAll('u1');
  assert.deepEqual(JSON.parse(calls.at(-1).o.body), { prefixes: [photoName('u1', 'photo:tesla-m3-rwd'), 'u1/b.jpg'] });
});
