// Integration tests for customer access to bookings and bins: the booking id
// alone is not enough, the access token (or a staff session) is.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';
// This file makes many bookings from one IP; the per-IP cap has its own test.
process.env.BOOKING_RATE_MAX ??= '1000';

let db, sql, app, server, baseUrl;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  app = (await import('../src/app.js')).default;
  sql = db.sql;
  await db.ensureSchema();
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/health`);
});

after(async () => {
  if (RUN && server) await new Promise((resolve) => server.close(resolve));
  if (RUN && sql) await sql.end({ timeout: 5 });
});

const uid = () => Math.random().toString(36).slice(2, 10);

function call(method, path, { token, cookie, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Booking-Token'] = token;
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

// A real booking through the public API, plus one bin bound to it.
async function makeBooking() {
  const svc = await (await call('GET', '/serviceability')).json();
  const phone = `+1555${uid()}`;
  const r = await call('POST', '/bookings', {
    body: {
      name: 'Access Test',
      phone,
      area: svc.areas[0],
      skuBreakdown: { bin: 1 },
      termsAccepted: true,
      // Far future so this never fights other tests for window capacity.
      deliveryDate: `2998-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`,
      deliverySlot: 'am',
    },
  });
  assert.equal(r.status, 201, await r.clone().text());
  const { booking } = await r.json();
  const bin = await db.createBin({ barcode: `ACC-${uid().toUpperCase()}`, skuType: 'bin' });
  await db.setBinFields(bin.id, { booking_id: booking.id, customer_id: booking.customer_id });
  return { booking, bin, phone };
}

describe('customer access', { concurrency: 1 }, () => {
  test('new bookings come back with an access token', { skip: !RUN }, async () => {
    const { booking } = await makeBooking();
    assert.equal(typeof booking.access_token, 'string');
    assert.ok(booking.access_token.length >= 32);
  });

  test('booking detail needs the token or an admin session', { skip: !RUN }, async () => {
    const { booking } = await makeBooking();
    const other = await makeBooking();

    assert.equal((await call('GET', `/bookings/${booking.id}`)).status, 401);
    assert.equal((await call('GET', `/bookings/${booking.id}`, { token: 'wrong' })).status, 404);
    assert.equal(
      (await call('GET', `/bookings/${booking.id}`, { token: other.booking.access_token })).status,
      404
    );
    assert.equal((await call('GET', `/bookings/does_not_exist`, { token: 'x' })).status, 404);

    const ok = await call('GET', `/bookings/${booking.id}`, { token: booking.access_token });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).customer.name, 'Access Test');

    const admin = await login('admin@valet.local', 'admin1234');
    assert.equal((await call('GET', `/bookings/${booking.id}`, { cookie: admin })).status, 200);

    // A driver is staff, but not allowed to act on customer bookings.
    const driver = await login('driver@valet.local', 'driver1234');
    assert.equal((await call('GET', `/bookings/${booking.id}`, { cookie: driver })).status, 401);
  });

  test('customer booking actions are guarded', { skip: !RUN }, async () => {
    const { booking, bin } = await makeBooking();
    const body = { collectionDate: '2999-01-01' };
    assert.equal((await call('POST', `/bookings/${booking.id}/book-collection`, { body })).status, 401);
    assert.equal(
      (await call('POST', `/bookings/${booking.id}/request-return`, { body: { binIds: [bin.id], deliveryBackDate: '2999-01-01' } })).status,
      401
    );
    assert.equal(
      (await call('POST', `/bookings/${booking.id}/cancel-retrieval`, { body: { binIds: [bin.id] } })).status,
      401
    );
    // With the token, the request gets past the guard to the normal rules
    // (no bins out for filling yet → 409).
    const r = await call('POST', `/bookings/${booking.id}/book-collection`, { token: booking.access_token, body });
    assert.equal(r.status, 409);
  });

  test('bin routes check the token against the bin\'s booking', { skip: !RUN }, async () => {
    const { booking, bin } = await makeBooking();
    const other = await makeBooking();

    assert.equal((await call('GET', `/bins/${bin.barcode}/movements`)).status, 401);
    assert.equal(
      (await call('GET', `/bins/${bin.barcode}/movements`, { token: other.booking.access_token })).status,
      404
    );
    assert.equal(
      (await call('GET', `/bins/${bin.barcode}/movements`, { token: booking.access_token })).status,
      200
    );
    const warehouse = await login('warehouse@valet.local', 'warehouse1234');
    assert.equal((await call('GET', `/bins/${bin.barcode}/movements`, { cookie: warehouse })).status, 200);

    for (const path of [`/bins/${bin.id}/close`, `/bins/${bin.id}/request-return`, `/bins/${bin.id}/request-restore`, `/bins/${bin.barcode}/photo`]) {
      assert.equal((await call('POST', path, { body: {} })).status, 401, path);
      assert.equal((await call('POST', path, { token: other.booking.access_token, body: {} })).status, 404, path);
    }

    // Unknown bin looks the same as someone else's bin.
    assert.equal((await call('GET', `/bins/NOPE-${uid()}/movements`, { token: booking.access_token })).status, 404);
  });

  test('bins with no booking are staff only', { skip: !RUN }, async () => {
    const { booking } = await makeBooking();
    const loose = await db.createBin({ barcode: `LOOSE-${uid().toUpperCase()}`, skuType: 'bin' });
    assert.equal(
      (await call('GET', `/bins/${loose.barcode}/movements`, { token: booking.access_token })).status,
      404
    );
  });

  test('phone lookup never returns booking data', { skip: !RUN }, async () => {
    const { phone } = await makeBooking();
    for (const p of [phone, '+19999999999']) {
      const r = await call('POST', '/bookings/lookup', { body: { phone: p } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    }
    assert.equal((await call('GET', `/bookings/by-phone/${encodeURIComponent(phone)}`)).status, 404);
  });

  test('a booking with someone else\'s phone gets its own customer', { skip: !RUN }, async () => {
    const { booking, phone } = await makeBooking();
    const svc = await (await call('GET', '/serviceability')).json();
    const r = await call('POST', '/bookings', {
      body: { name: 'Stranger', phone, area: svc.areas[0], skuBreakdown: { bin: 1 }, deliveryDate: '2998-02-20', deliverySlot: 'pm', termsAccepted: true },
    });
    assert.equal(r.status, 201);
    const created = await r.json();
    assert.deepEqual(Object.keys(created.customer), ['id']);
    assert.notEqual(created.booking.customer_id, booking.customer_id);
    const detail = await (await call('GET', `/bookings/${created.booking.id}`, { token: created.booking.access_token })).json();
    assert.equal(detail.customer.name, 'Stranger');
  });

  test('an unexpected async error is a generic 500, and the server stays up', { skip: !RUN }, async () => {
    // A NUL byte makes Postgres reject the query inside a handler with no try.
    const r = await call('GET', '/bins/A%00B/movements');
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Internal error' });
    assert.equal((await call('GET', '/health')).status, 200);
  });

  test('jobs board does not hand drivers the customer token', { skip: !RUN }, async () => {
    const { booking } = await makeBooking();
    const driver = await login('driver@valet.local', 'driver1234');
    const jobs = await (await call('GET', '/jobs', { cookie: driver })).json();
    const mine = jobs.find((j) => j.booking_id === booking.id);
    assert.ok(mine);
    assert.equal(mine.booking.access_token, undefined);
  });
});
