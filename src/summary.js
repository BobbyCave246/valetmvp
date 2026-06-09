// Derived booking summary (spec §3.2). Bins are the unit of truth; a booking
// has NO status state machine. We compute a display string from the booking's
// bins on the fly, e.g. "5 bins — 4 Stored, 1 Returned to customer".

import { listBinsForBooking } from './db.js';

export function deriveBookingSummary(bookingId) {
  const bins = listBinsForBooking(bookingId);
  const total = bins.length;

  if (total === 0) {
    return { total: 0, counts: {}, text: '0 bins — unassigned' };
  }

  const counts = {};
  for (const bin of bins) {
    const label = bin.status ?? 'unassigned';
    counts[label] = (counts[label] || 0) + 1;
  }

  const parts = Object.entries(counts).map(([status, n]) => `${n} ${status}`);
  const text = `${total} bin${total === 1 ? '' : 's'} — ${parts.join(', ')}`;

  return { total, counts, text };
}
