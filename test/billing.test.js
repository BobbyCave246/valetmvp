// Unit tests for the monthly billing rules (src/billing.js). Pure, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';

const { monthBounds, facilityStays, buildBill, isMonth } = await import('../src/billing.js');

const mv = (bin, to, ts, booking = 'book_a', from = null) => ({
  bin_id: bin, booking_id: booking, from_status: from, to_status: to, ts,
});

test('months run on the Barbados calendar (UTC-4)', () => {
  const { start, end } = monthBounds('2026-01');
  assert.equal(new Date(start).toISOString(), '2026-01-01T04:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-02-01T04:00:00.000Z');
  // December rolls into the next year.
  assert.equal(new Date(monthBounds('2026-12').end).toISOString(), '2027-01-01T04:00:00.000Z');
});

test('isMonth accepts YYYY-MM only', () => {
  assert.ok(isMonth('2026-09'));
  for (const bad of ['2026-13', '2026-9', '2026-09-01', '', null]) assert.equal(isMonth(bad), false);
});

test('a stay runs from Stored until the bin leaves; cancelling a retrieval keeps it open', () => {
  const stays = facilityStays([
    mv('b1', 'In transit (inbound)', '2026-01-01T12:00:00Z'),
    mv('b1', 'Stored', '2026-01-02T12:00:00Z'),
    mv('b1', 'Retrieval requested', '2026-01-05T12:00:00Z'),
    mv('b1', 'Stored', '2026-01-06T12:00:00Z'), // retrieval cancelled: never left
    mv('b1', 'Retrieval requested', '2026-01-08T12:00:00Z'),
    mv('b1', 'In transit (outbound)', '2026-01-09T12:00:00Z'),
    mv('b2', 'Stored', '2026-01-03T12:00:00Z', 'book_b'),
  ]);
  assert.deepEqual(stays, [
    { binId: 'b1', bookingId: 'book_a', start: Date.parse('2026-01-02T12:00:00Z'), end: Date.parse('2026-01-09T12:00:00Z') },
    { binId: 'b2', bookingId: 'book_b', start: Date.parse('2026-01-03T12:00:00Z'), end: null },
  ]);
});

test('a cancelled booking releasing a stored bin ends its stay', () => {
  const stays = facilityStays([
    mv('b1', 'Stored', '2026-01-02T12:00:00Z'),
    mv('b1', null, '2026-01-04T12:00:00Z'),
  ]);
  assert.equal(stays[0].end, Date.parse('2026-01-04T12:00:00Z'));
});

test('storage is charged pro rata for the time in the facility that month', () => {
  // Stored from local midnight on Jan 11 to the end of the month: 21 of 31 days.
  const bill = buildBill({
    month: '2026-01',
    movements: [mv('b1', 'Stored', '2026-01-11T04:00:00Z')],
    returnOrders: [],
    payments: [],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  const [line] = bill.lines;
  assert.equal(line.bins, 1);
  assert.equal(line.binDays, 21);
  assert.equal(line.storage, Math.round((30 * 21 / 31) * 100) / 100); // 20.32
});

test('a stay from an earlier month is charged the full month', () => {
  const bill = buildBill({
    month: '2026-02',
    movements: [mv('b1', 'Stored', '2025-12-15T12:00:00Z'), mv('b2', 'Stored', '2025-12-15T12:00:00Z')],
    returnOrders: [],
    payments: [],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  assert.equal(bill.lines[0].bins, 2);
  assert.equal(bill.lines[0].storage, 60);
});

test('the current month is only charged up to now', () => {
  const { start, end } = monthBounds('2026-04');
  const mid = start + (end - start) / 2;
  const bill = buildBill({
    month: '2026-04',
    movements: [mv('b1', 'Stored', new Date(start).toISOString())],
    returnOrders: [],
    payments: [],
    now: mid,
  });
  assert.equal(bill.lines[0].storage, 15);
});

test('return orders are $50 each, and payments for the month come off', () => {
  const bill = buildBill({
    month: '2026-02',
    movements: [mv('b1', 'Stored', '2025-12-15T12:00:00Z')],
    returnOrders: [{ job_id: 'j1', booking_id: 'book_a' }, { job_id: 'j2', booking_id: 'book_a' }],
    payments: [{ booking_id: 'book_a', amount: '80.00' }],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  const [line] = bill.lines;
  assert.equal(line.returnOrders, 2);
  assert.equal(line.retrieval, 100);
  assert.equal(line.total, 130);
  assert.equal(line.paid, 80);
  assert.equal(line.due, 50);
  assert.deepEqual(bill.totals, { storage: 30, retrieval: 100, total: 130, paid: 80, due: 50 });
});

test('a prepayment with nothing yet to charge shows as a credit', () => {
  const bill = buildBill({
    month: '2026-02',
    movements: [],
    returnOrders: [],
    payments: [{ booking_id: 'book_new', amount: '165' }],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  assert.equal(bill.lines[0].due, -165);
});

test('stays outside the month cost nothing and do not appear', () => {
  const bill = buildBill({
    month: '2026-03',
    movements: [
      mv('b1', 'Stored', '2026-01-02T12:00:00Z'),
      mv('b1', 'In transit (outbound)', '2026-01-20T12:00:00Z'),
    ],
    returnOrders: [],
    payments: [],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  assert.deepEqual(bill.lines, []);
});

test('lines with nothing to charge and nothing paid are left off', () => {
  const bill = buildBill({
    month: '2026-01',
    movements: [
      mv('b1', 'Stored', '2026-01-02T12:00:00.000Z'),
      mv('b1', 'Retrieval requested', '2026-01-02T12:00:00.001Z'),
      mv('b1', 'In transit (outbound)', '2026-01-02T12:00:00.002Z'),
    ],
    returnOrders: [],
    payments: [],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  assert.deepEqual(bill.lines, []);
});
