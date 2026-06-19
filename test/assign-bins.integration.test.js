// Integration tests for atomic assign bins (#30).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';

let db, tx, STATUS, sql, jobs;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  tx = await import('../src/transitions.js');
  jobs = await import('../src/jobs-lifecycle.js');
  ({ STATUS } = tx);
  sql = db.sql;
  await db.ensureSchema();
});

after(async () => {
  if (RUN && sql) await sql.end({ timeout: 5 });
});

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const bc = () => uid('BC').toUpperCase();

let bookingSeq = 0;

async function makeBooking() {
  bookingSeq += 1;
  const deliveryDate = `2999-03-${String(bookingSeq).padStart(2, '0')}`;
  const customer = await db.createCustomer({
    name: 'Test',
    phone: uid('ph'),
    email: null,
    address: '1 Test St',
    postcode: 'SW1A',
  });
  const booking = await db.createBooking({
    customerId: customer.id,
    binCount: 1,
    skuBreakdown: { bin: 1 },
    deliveryDate,
    deliverySlot: 'am',
  });
  await jobs.createDeliverEmpty(booking.id, {
    date: deliveryDate,
    slot: 'am',
    capacity: 4,
  });
  return { customer, booking };
}

describe('assignBinsToBooking integration', { concurrency: 1 }, () => {
  test('assigns bins and syncs deliver_empty job atomically', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();
    const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });

    const assigned = await jobs.assignBinsToBooking(booking.id, [bin.id], { actor: 'admin' });
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].status, STATUS.ASSIGNED);
    assert.equal(assigned[0].booking_id, booking.id);

    const deliverJob = (await db.listJobsForBooking(booking.id)).find(
      (j) => j.type === 'deliver_empty' && j.status === 'Scheduled'
    );
    assert.deepEqual(JSON.parse(deliverJob.bin_ids), [bin.id]);
  });

  test('concurrent assign on same bin — one wins, one gets 409', { skip: !RUN }, async () => {
    const { customer: c1, booking: b1 } = await makeBooking();
    const { customer: c2, booking: b2 } = await makeBooking();
    const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });

    const results = await Promise.allSettled([
      jobs.assignBinsToBooking(b1.id, [bin.id], { actor: 'admin' }),
      jobs.assignBinsToBooking(b2.id, [bin.id], { actor: 'admin' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409);

    const winner = fulfilled[0].value[0];
    assert.equal(winner.booking_id, winner.booking_id);
    const refreshed = await db.getBin(bin.id);
    assert.equal(refreshed.booking_id, winner.booking_id);
  });
});
