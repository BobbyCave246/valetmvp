// Integration tests for Phase 1 lifecycle features (#22–#24).
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

async function makeBooking({ withDeliverJob = true } = {}) {
  bookingSeq += 1;
  const deliveryDate = `2999-02-${String(bookingSeq).padStart(2, '0')}`;
  const customer = await db.createCustomer({
    name: 'Test',
    phone: uid('ph'),
    email: 'test@example.com',
    address: '1 Test St',
    postcode: 'SW1A',
  });
  const booking = await db.createBooking({
    customerId: customer.id,
    binCount: 2,
    skuBreakdown: { bin: 2 },
    deliveryDate,
    deliverySlot: 'am',
  });
  if (withDeliverJob) {
    await jobs.createDeliverEmpty(booking.id, {
      date: deliveryDate,
      slot: 'am',
      capacity: 4,
    });
  }
  return { customer, booking };
}

async function freeLocation() {
  const id = uid('loc');
  await sql`INSERT INTO locations (id, barcode, occupied) VALUES (${id}, ${uid('L').toUpperCase()}, 0)`;
  return id;
}

describe('Phase 1 lifecycle integration', { concurrency: 1 }, () => {
  test('cancelUnassignedBooking deletes booking and jobs when no bins assigned', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();

    await jobs.cancelUnassignedBooking(booking.id);

    assert.equal(await db.getBooking(booking.id), undefined);
    assert.equal((await db.listJobsForBooking(booking.id)).length, 0);

    const byPhone = await db.findBookingByPhone(customer.phone);
    assert.ok(!byPhone.some((b) => b.id === booking.id));
  });

  test('cancelUnassignedBooking rejects when bins are already assigned', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();
    const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
    await tx.transitionBin(bin.id, STATUS.ASSIGNED, {
      actor: 'admin',
      binFields: { customer_id: customer.id, booking_id: booking.id },
    });

    await assert.rejects(() => jobs.cancelUnassignedBooking(booking.id), (e) => e.status === 409);
    assert.ok(await db.getBooking(booking.id));
  });

  test('cancelRetrieval partial cancel updates deliver_back job bin list', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking();

    async function storedBin() {
      const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
      await tx.transitionBin(bin.id, STATUS.ASSIGNED, {
        actor: 'admin',
        binFields: { customer_id: customer.id, booking_id: booking.id },
      });
      await tx.transitionBin(bin.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });
      await tx.transitionBin(bin.id, STATUS.IN_TRANSIT_INBOUND, { actor: 'admin' });
      const locId = await freeLocation();
      await tx.transitionBin(bin.id, STATUS.STORED, { actor: 'admin', locationId: locId });
      return bin;
    }

    const b1 = await storedBin();
    const b2 = await storedBin();
    await jobs.requestRetrieval(booking.id, { binIds: [b1.id, b2.id], date: '2999-06-01' });

    await jobs.cancelRetrieval(booking.id, { binIds: [b1.id], actor: 'customer' });

    assert.equal((await db.getBin(b1.id)).status, STATUS.STORED);
    assert.equal((await db.getBin(b2.id)).status, STATUS.RETRIEVAL_REQUESTED);

    const deliverBack = (await db.listJobsForBooking(booking.id)).find(
      (j) => j.type === 'deliver_back' && j.status === 'Scheduled'
    );
    assert.ok(deliverBack);
    assert.deepEqual(JSON.parse(deliverBack.bin_ids), [b2.id]);
  });

  test('markBinNoShow releases bin and removes it from collect_full job', { skip: !RUN }, async () => {
    const { customer, booking } = await makeBooking({ withDeliverJob: false });
    const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
    await tx.transitionBin(bin.id, STATUS.ASSIGNED, {
      actor: 'admin',
      binFields: { customer_id: customer.id, booking_id: booking.id },
    });
    await tx.transitionBin(bin.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });

    await jobs.scheduleCollection(booking.id, {
      date: '2999-03-01',
      slot: 'am',
      binIds: [bin.id],
    });

    await jobs.markBinNoShow(bin.id, { actor: 'admin' });

    const refreshed = await db.getBin(bin.id);
    assert.equal(refreshed.status, null);
    assert.equal(refreshed.booking_id, null);

    const collectJobs = (await db.listJobsForBooking(booking.id)).filter(
      (j) => j.type === 'collect_full' && j.status === 'Scheduled'
    );
    assert.equal(collectJobs.length, 0);
  });
});
