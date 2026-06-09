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

const isSlot = (key) => SLOTS.some((s) => s.key === key);
const labelFor = (key) => SLOTS.find((s) => s.key === key)?.label || key;

// Earliest bookable date (today + LEAD_DAYS), as YYYY-MM-DD.
export function earliestDateISO() {
  const d = new Date();
  d.setDate(d.getDate() + LEAD_DAYS);
  return d.toISOString().slice(0, 10);
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
