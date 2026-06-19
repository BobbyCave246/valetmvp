// Delivery time-window scheduling config + helpers. Windows, lead time, and
// per-slot capacity are all env-configurable. Used by the booking flow to give
// customers real-time availability and to cap deliveries per window so routes
// can be batched.

import { countDeliveriesForSlot } from './db.js';

export const SLOTS = [
  { key: 'am', label: 'Morning (8am–12pm)' },
  { key: 'pm', label: 'Afternoon (12–5pm)' },
];

export const SLOT_CAPACITY = Number(process.env.SLOT_CAPACITY || 4);
export const LEAD_DAYS = Number(process.env.LEAD_DAYS || 1);

// Barbados (AST, UTC−4) — customer-facing dates follow the local calendar.
export const SERVICE_TZ = 'America/Barbados';

const isSlot = (key) => SLOTS.some((s) => s.key === key);
const labelFor = (key) => SLOTS.find((s) => s.key === key)?.label || key;

/** Calendar date YYYY-MM-DD for an instant in the service timezone. */
export function calendarDateISO(date = new Date(), timeZone = SERVICE_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Today's date on the service calendar. */
export function todayDateISO() {
  return calendarDateISO(new Date(), SERVICE_TZ);
}

function addCalendarDays(isoDate, days, timeZone = SERVICE_TZ) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return calendarDateISO(dt, timeZone);
}

// Earliest bookable date (today + LEAD_DAYS), as YYYY-MM-DD on the service calendar.
export function earliestDateISO() {
  return addCalendarDays(todayDateISO(), LEAD_DAYS);
}

// Validates a bare date for collection/retrieval scheduling: format + not in the
// past (today is allowed — these are customer-requested service dates, not
// capacity-gated delivery slots). Returns null if ok, else an error message.
export function validateFutureDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'A valid date is required';
  const todayISO = todayDateISO();
  if (date < todayISO) return 'Date cannot be in the past';
  return null;
}

// Returns null if ok, or an error message string.
export function validateDateSlot(date, slot) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'A valid delivery date is required';
  if (!isSlot(slot)) return 'A valid delivery window is required';
  if (date < earliestDateISO()) {
    return LEAD_DAYS === 1
      ? 'Earliest delivery is tomorrow'
      : `Delivery must be at least ${LEAD_DAYS} days out`;
  }
  return null;
}

// Per-window availability for a date: remaining capacity + whether bookable.
export async function availabilityForDate(date) {
  return Promise.all(
    SLOTS.map(async (s) => {
      const used = await countDeliveriesForSlot(date, s.key);
      const remaining = Math.max(0, SLOT_CAPACITY - used);
      return { key: s.key, label: s.label, remaining, available: remaining > 0 };
    })
  );
}

export { labelFor as slotLabel };
