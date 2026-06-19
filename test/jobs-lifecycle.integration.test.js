// Integration tests for the job lifecycle module.
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

async function makeBooking() {
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
    deliveryDate: '2999-01-01',
    deliverySlot: 'am',
  });
  return { customer, booking };
}

async function assignedBin(bookingId, customerId) {
  const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
  await tx.transitionBin(bin.id, STATUS.ASSIGNED, {
    actor: 'admin',
    binFields: { customer_id: customerId, booking_id: bookingId },
  });
  return bin;
}

describe('jobs-lifecycle integration', { concurrency: 1 }, () => {
  test('completeJob advances all bins and marks Done atomically', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();
    const bin = await assignedBin(booking.id, customer.id);
    const job = await db.createJob({
      bookingId: booking.id,
      type: 'deliver_empty',
      scheduledDate: '2999-01-01',
      scheduledSlot: 'am',
      binIds: [bin.id],
    });

    const { advanced } = await jobs.completeJob(job.id, { actor: 'admin' });
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0].status, STATUS.OUT_FOR_FILLING);

    const refreshed = await db.getJob(job.id);
    assert.equal(refreshed.status, 'Done');
  });

  test('completeJob rejects out-of-sync bins without partial advance', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();
    const bin = await assignedBin(booking.id, customer.id);
    await tx.transitionBin(bin.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });

    const job = await db.createJob({
      bookingId: booking.id,
      type: 'deliver_empty',
      scheduledDate: '2999-01-01',
      scheduledSlot: 'am',
      binIds: [bin.id],
    });

    await assert.rejects(() => jobs.completeJob(job.id), (e) => e.status === 409);

    const refreshedJob = await db.getJob(job.id);
    assert.equal(refreshedJob.status, 'Scheduled');
    const refreshedBin = await db.getBin(bin.id);
    assert.equal(refreshedBin.status, STATUS.OUT_FOR_FILLING);
  });

  test('scheduleCollection merges into one Scheduled collect_full job', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();
    const b1 = await assignedBin(booking.id, customer.id);
    const b2 = await assignedBin(booking.id, customer.id);
    await tx.transitionBin(b1.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });
    await tx.transitionBin(b2.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });

    await jobs.scheduleCollection(booking.id, {
      date: '2999-03-01',
      slot: 'am',
      binIds: [b1.id],
    });
    await jobs.scheduleCollection(booking.id, {
      date: '2999-03-02',
      slot: 'pm',
      binIds: [b2.id],
    });

    const scheduled = (await db.listJobsForBooking(booking.id)).filter(
      (j) => j.type === 'collect_full' && j.status === 'Scheduled'
    );
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].scheduled_date, '2999-03-02');
    const binIds = JSON.parse(scheduled[0].bin_ids);
    assert.deepEqual(new Set(binIds), new Set([b1.id, b2.id]));
  });

  test('createDeliverEmpty rejects when window is at capacity', { skip: !RUN }, async () => {
    const { booking: b1 } = await makeBooking();
    const { booking: b2 } = await makeBooking();

    await jobs.createDeliverEmpty(b1.id, { date: '2999-12-01', slot: 'am', capacity: 1 });

    await assert.rejects(
      () => jobs.createDeliverEmpty(b2.id, { date: '2999-12-01', slot: 'am', capacity: 1 }),
      (e) => e.status === 409
    );
  });
});
