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
  resolvePhotoUrl,
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

test('resolvePhotoUrl builds public object URL for storage refs', () => {
  const url = resolvePhotoUrl('storage:contents-photos/bin_x1/123.jpg');
  assert.equal(
    url,
    'https://abc123.supabase.co/storage/v1/object/public/contents-photos/bin_x1/123.jpg'
  );
});

test('resolvePhotoUrl passes through legacy data URLs', () => {
  assert.equal(resolvePhotoUrl(tinyPng), tinyPng);
});

test('enrichBin adds photoUrl when resolvable', () => {
  const bin = enrichBin({ id: 'b1', photo_ref: 'storage:contents-photos/b1/x.jpg' });
  assert.ok(bin.photoUrl.includes('/storage/v1/object/public/'));
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
