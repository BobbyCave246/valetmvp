// Integration tests for booking-level request-return (atomic multi-bin retrieval).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';

let db, tx, STATUS, sql, performRequestReturn;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  tx = await import('../src/transitions.js');
  ({ performRequestReturn } = await import('../src/routes/bookings.js'));
  ({ STATUS } = tx);
  sql = db.sql;
  await db.ensureSchema();
});

after(async () => {
  if (RUN && sql) await sql.end({ timeout: 5 });
});

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const bc = () => uid('BC').toUpperCase();

async function freeLocation() {
  const id = uid('loc');
  await sql`INSERT INTO locations (id, barcode, occupied) VALUES (${id}, ${uid('L').toUpperCase()}, 0)`;
  return id;
}

async function storedBinOnBooking(bookingId, customerId) {
  const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
  await tx.transitionBin(bin.id, STATUS.ASSIGNED, {
    actor: 'admin',
    binFields: { customer_id: customerId, booking_id: bookingId },
  });
  await tx.transitionBin(bin.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });
  await tx.transitionBin(bin.id, STATUS.IN_TRANSIT_INBOUND, { actor: 'admin' });
  const locId = await freeLocation();
  await tx.transitionBin(bin.id, STATUS.STORED, { actor: 'admin', locationId: locId });
  return bin;
}

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
    binCount: 2,
    skuBreakdown: { bin: 2 },
    deliveryDate: '2999-01-01',
    deliverySlot: 'am',
  });
  return { customer, booking };
}

test('performRequestReturn transitions all bins and creates one deliver_back job', { skip: !RUN }, async () => {
  const { customer, booking } = await makeBooking();
  const b1 = await storedBinOnBooking(booking.id, customer.id);
  const b2 = await storedBinOnBooking(booking.id, customer.id);

  const job = await performRequestReturn(booking, [b1.id, b2.id], '2999-06-01');
  assert.equal(job.type, 'deliver_back');

  const bins = await db.listBinsForBooking(booking.id);
  assert.ok(bins.every((b) => b.status === STATUS.RETRIEVAL_REQUESTED));

  const jobs = (await db.listJobsForBooking(booking.id)).filter(
    (j) => j.type === 'deliver_back' && j.status === 'Scheduled'
  );
  assert.equal(jobs.length, 1);
  const binIds = JSON.parse(jobs[0].bin_ids);
  assert.deepEqual(new Set(binIds), new Set([b1.id, b2.id]));
});

test('performRequestReturn rejects non-Stored bins before any transition', { skip: !RUN }, async () => {
  const { customer, booking } = await makeBooking();
  const stored = await storedBinOnBooking(booking.id, customer.id);
  const bin2 = await db.createBin({ barcode: bc(), skuType: 'bin' });
  await tx.transitionBin(bin2.id, STATUS.ASSIGNED, {
    actor: 'admin',
    binFields: { customer_id: customer.id, booking_id: booking.id },
  });

  await assert.rejects(
    () => performRequestReturn(booking, [stored.id, bin2.id], '2999-06-01'),
    (e) => e.status === 409
  );

  const refreshed = await db.getBin(stored.id);
  assert.equal(refreshed.status, STATUS.STORED);
});
