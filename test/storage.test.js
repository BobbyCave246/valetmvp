// Unit tests for Supabase Storage photo helpers (fetch mocked).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';

const origFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://abc123.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_key';
  process.env.SUPABASE_STORAGE_BUCKET = 'contents-photos';
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
});

const {
  parsePhotoDataUrl,
  parseStorageRef,
  signPhotoUrls,
  uploadContentsPhoto,
  isStorageConfigured,
  enrichBin,
} = await import('../src/storage.js');

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('isStorageConfigured is true when URL and service key are set', () => {
  assert.equal(isStorageConfigured(), true);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(isStorageConfigured(), false);
});

test('parsePhotoDataUrl decodes a data URL', () => {
  const parsed = parsePhotoDataUrl(tinyPng);
  assert.ok(parsed);
  assert.equal(parsed.contentType, 'image/png');
  assert.ok(parsed.buffer.length > 0);
});

test('parseStorageRef splits bucket and path', () => {
  assert.deepEqual(parseStorageRef('storage:contents-photos/bin_x1/123.jpg'), {
    bucket: 'contents-photos',
    path: 'bin_x1/123.jpg',
  });
  assert.equal(parseStorageRef('https://example.com/x.jpg'), null);
});

test('signPhotoUrls batch-signs storage refs per bucket', async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      status: 200,
      json: async () => [{ path: 'bin_x1/123.jpg', signedURL: '/object/sign/contents-photos/bin_x1/123.jpg?token=abc', error: null }],
    };
  };
  const urls = await signPhotoUrls(['storage:contents-photos/bin_x1/123.jpg', null]);
  assert.equal(captured.url, 'https://abc123.supabase.co/storage/v1/object/sign/contents-photos');
  assert.deepEqual(JSON.parse(captured.opts.body).paths, ['bin_x1/123.jpg']);
  assert.equal(
    urls.get('storage:contents-photos/bin_x1/123.jpg'),
    'https://abc123.supabase.co/storage/v1/object/sign/contents-photos/bin_x1/123.jpg?token=abc'
  );
});

test('signPhotoUrls passes through legacy data URLs without a request', async () => {
  globalThis.fetch = async () => assert.fail('should not fetch');
  const urls = await signPhotoUrls([tinyPng]);
  assert.equal(urls.get(tinyPng), tinyPng);
});

test('enrichBin leaves photoUrl off when signing fails', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const bin = await enrichBin({ id: 'b1', photo_ref: 'storage:contents-photos/b1/x.jpg' });
  assert.equal(bin.photoUrl, undefined);
});

test('enrichBin adds a signed photoUrl', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ path: 'b1/x.jpg', signedURL: '/object/sign/contents-photos/b1/x.jpg?token=t' }],
  });
  const bin = await enrichBin({ id: 'b1', photo_ref: 'storage:contents-photos/b1/x.jpg' });
  assert.match(bin.photoUrl, /\/storage\/v1\/object\/sign\/contents-photos\/b1\/x\.jpg\?token=t$/);
});

test('uploadContentsPhoto POSTs to Supabase Storage', async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '' };
  };
  const buf = Buffer.from('abc');
  const ref = await uploadContentsPhoto({ binId: 'bin_test', imageBuffer: buf, contentType: 'image/jpeg' });
  assert.match(ref, /^storage:contents-photos\/bin_test\//);
  assert.match(captured.url, /\/storage\/v1\/object\/contents-photos\/bin_test\//);
  assert.match(captured.opts.headers.Authorization, /Bearer test_service_key/);
});

test('uploadContentsPhoto rejects when storage not configured', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(
    () => uploadContentsPhoto({ binId: 'b', imageBuffer: Buffer.from('x') }),
    (e) => e.status === 503
  );
});
