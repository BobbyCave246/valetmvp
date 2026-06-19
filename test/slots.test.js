// Unit tests for delivery-window validation + labels. Pure logic; the DB import
// is satisfied with a dummy connection string (no query runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';
const {
  validateDateSlot,
  validateFutureDate,
  slotLabel,
  earliestDateISO,
  todayDateISO,
  calendarDateISO,
  SERVICE_TZ,
  SLOTS,
} = await import('../src/slots.js');

const farFuture = '2999-01-01';

test('slotLabel maps known keys and falls back to the raw key', () => {
  assert.equal(slotLabel('am'), 'Morning (8am–12pm)');
  assert.equal(slotLabel('pm'), 'Afternoon (12–5pm)');
  assert.equal(slotLabel('zzz'), 'zzz');
});

test('validateDateSlot accepts a valid future date + slot', () => {
  assert.equal(validateDateSlot(farFuture, 'am'), null);
});

test('validateDateSlot rejects a missing/bad date', () => {
  assert.match(validateDateSlot('', 'am'), /valid delivery date/i);
  assert.match(validateDateSlot('2026/01/01', 'am'), /valid delivery date/i);
});

test('validateDateSlot rejects an unknown window', () => {
  assert.match(validateDateSlot(farFuture, 'midnight'), /valid delivery window/i);
});

test('validateDateSlot rejects a past date (before earliest)', () => {
  assert.notEqual(validateDateSlot('2000-01-01', 'am'), null);
});

test('earliestDateISO is a YYYY-MM-DD string in the future-ish', () => {
  assert.match(earliestDateISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(SLOTS.length >= 1);
});

test('calendarDateISO uses Barbados timezone, not UTC midnight', () => {
  assert.equal(SERVICE_TZ, 'America/Barbados');
  // 2026-06-19T02:30:00Z is still 2026-06-18 evening in Barbados (UTC−4).
  const instant = new Date('2026-06-19T02:30:00Z');
  assert.equal(calendarDateISO(instant), '2026-06-18');
  assert.equal(instant.toISOString().slice(0, 10), '2026-06-19');
});

test('validateFutureDate allows today on the Barbados calendar', () => {
  const today = todayDateISO();
  assert.equal(validateFutureDate(today), null);
  assert.match(validateFutureDate('2000-01-01'), /past/i);
});
