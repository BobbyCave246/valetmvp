// Integration tests for T&Cs at booking, recorded payments, paid demand and
// the monthly bill, over real HTTP against Postgres.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';
process.env.BOOKING_RATE_MAX ??= '1000';

let db, tx, jobs, app, server, baseUrl, admin;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  tx = await import('../src/transitions.js');
  jobs = await import('../src/jobs-lifecycle.js');
  app = (await import('../src/app.js')).default;
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/health`);
  admin = await login('admin@valet.local', 'admin1234');
});

after(async () => {
  if (RUN && server) await new Promise((resolve) => server.close(resolve));
  if (RUN && db) await db.sql.end({ timeout: 5 });
});

const uid = () => Math.random().toString(36).slice(2, 10);

function call(method, path, { cookie, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

async function bookViaApi(extra = {}) {
  const svc = await (await call('GET', '/serviceability')).json();
  return call('POST', '/bookings', {
    body: {
      name: 'Billing Test',
      phone: `+1555${uid()}`,
      area: svc.areas[0],
      skuBreakdown: { bin: 1 },
      deliveryDate: `2997-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`,
      deliverySlot: 'am',
      ...extra,
    },
  });
}

// Walk one bin all the way into the rack, then backdate the put-away so the
// bill for January 2026 is deterministic.
async function storedBin(storedAt) {
  const { booking } = await (await bookViaApi({ termsAccepted: true })).json();
  const bin = await db.createBin({ barcode: `BILL-${uid().toUpperCase()}`, skuType: 'bin' });
  const [loc] = await db.sql`
    INSERT INTO locations (id, barcode, occupied) VALUES (${'loc_' + uid()}, ${'R-' + uid().toUpperCase()}, 0)
    RETURNING *`;
  await jobs.assignBinsToBooking(booking.id, [bin.id], { actor: 'admin' });
  await tx.transitionBin(bin.id, tx.STATUS.OUT_FOR_FILLING, { actor: 'admin' });
  await tx.transitionBin(bin.id, tx.STATUS.IN_TRANSIT_INBOUND, { actor: 'admin' });
  await tx.transitionBin(bin.id, tx.STATUS.STORED, { actor: 'admin', locationId: loc.id });
  await db.sql`UPDATE movements SET ts = ${storedAt} WHERE bin_id = ${bin.id} AND to_status = 'Stored'`;
  await db.sql`UPDATE movements SET ts = '2026-01-01T00:00:00.000Z' WHERE bin_id = ${bin.id} AND to_status <> 'Stored'`;
  return { booking, bin };
}

describe('T&Cs, payments and billing', { concurrency: 1 }, () => {
  test('booking needs the T&Cs accepted, and records the version', { skip: !RUN }, async () => {
    assert.equal((await bookViaApi()).status, 400);
    assert.equal((await bookViaApi({ termsAccepted: 'yes' })).status, 400);
    const r = await bookViaApi({ termsAccepted: true });
    assert.equal(r.status, 201);
    const { booking } = await r.json();
    assert.equal(booking.terms_version, 'draft');
    assert.ok(booking.terms_accepted_at);

    const svc = await (await call('GET', '/serviceability')).json();
    assert.deepEqual(svc.terms, { version: 'draft', url: null });
  });

  test('every movement records the bin\'s booking', { skip: !RUN }, async () => {
    const { booking, bin } = await storedBin('2026-01-11T04:00:00.000Z');
    const rows = await db.sql`SELECT booking_id FROM movements WHERE bin_id = ${bin.id}`;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.booking_id === booking.id));
  });

  test('payments are admin-only and validated', { skip: !RUN }, async () => {
    const { booking } = await (await bookViaApi({ termsAccepted: true })).json();
    const path = `/bookings/${booking.id}/payments`;
    const good = { kind: 'first_month', amount: 30, reference: 'PNP-123' };

    assert.equal((await call('POST', path, { body: good })).status, 401);
    const driver = await login('driver@valet.local', 'driver1234');
    assert.equal((await call('POST', path, { cookie: driver, body: good })).status, 403);

    for (const bad of [
      { ...good, kind: 'tip' },
      { ...good, amount: 0 },
      { ...good, amount: 10.555 },
      { ...good, reference: '  ' },
      { ...good, period: '2026-13' },
    ]) {
      assert.equal((await call('POST', path, { cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('POST', `/bookings/nope/payments`, { cookie: admin, body: good })).status, 404);

    const r = await call('POST', path, { cookie: admin, body: { ...good, period: '2026-01' } });
    assert.equal(r.status, 201);
    const list = await (await call('GET', path, { cookie: admin })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].reference, 'PNP-123');
  });

  test('a first-month payment marks the booking paid and counts as paid demand', { skip: !RUN }, async () => {
    const { booking } = await (await bookViaApi({ termsAccepted: true })).json();
    const before = (await (await call('GET', '/reports/summary', { cookie: admin })).json()).snapshot.bookings;
    const find = async () =>
      (await (await call('GET', '/bookings', { cookie: admin })).json()).find((b) => b.id === booking.id);

    assert.equal((await find()).paid, false);
    // A non-first-month payment doesn't count as paid demand.
    await call('POST', `/bookings/${booking.id}/payments`, { cookie: admin, body: { kind: 'other', amount: 5, reference: 'PNP-x' } });
    assert.equal((await find()).paid, false);
    await call('POST', `/bookings/${booking.id}/payments`, { cookie: admin, body: { kind: 'first_month', amount: 30, reference: 'PNP-y' } });
    assert.equal((await find()).paid, true);

    const after = (await (await call('GET', '/reports/summary', { cookie: admin })).json()).snapshot.bookings;
    assert.equal(after.paid, before.paid + 1);
    assert.equal(after.paidReservedBins, before.paidReservedBins + 1);
  });

  test('the monthly bill charges time in the facility, less payments', { skip: !RUN }, async () => {
    const { booking } = await storedBin('2026-01-11T04:00:00.000Z');
    await call('POST', `/bookings/${booking.id}/payments`, {
      cookie: admin,
      body: { kind: 'storage', amount: 20, reference: 'PNP-jan', period: '2026-01' },
    });

    const r = await call('GET', '/billing?month=2026-01', { cookie: admin });
    assert.equal(r.status, 200);
    const bill = await r.json();
    const line = bill.lines.find((l) => l.bookingId === booking.id);
    assert.ok(line, 'booking should be on the January bill');
    assert.equal(line.bins, 1);
    assert.equal(line.binDays, 21);
    assert.equal(line.storage, 20.32);
    assert.equal(line.paid, 20);
    assert.equal(line.due, 0.32);
    assert.equal(line.customer.name, 'Billing Test');
    assert.equal(line.cancelled, false);
  });

  test('billing is admin-only and needs a valid month', { skip: !RUN }, async () => {
    assert.equal((await call('GET', '/billing?month=2026-01')).status, 401);
    const warehouse = await login('warehouse@valet.local', 'warehouse1234');
    assert.equal((await call('GET', '/billing?month=2026-01', { cookie: warehouse })).status, 403);
    assert.equal((await call('GET', '/billing?month=Jan', { cookie: admin })).status, 400);
  });
});
