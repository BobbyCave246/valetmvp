// Derived booking summary (spec §3.2). Bins are the unit of truth; a booking
// has NO status state machine. We compute a display string from the booking's
// bins on the fly, e.g. "5 bins — 4 Stored, 1 Returned to customer".

import { listBinsForBooking, listJobs } from './db.js';
import { STATUS } from './transitions.js';

export async function deriveBookingSummary(bookingId) {
  const bins = await listBinsForBooking(bookingId);
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

// Computes the single most useful "next step" for a booking, for the admin
// queue. Derived from the booking's bin statuses + its scheduled jobs — bins
// are the unit of truth, so this never relies on a booking status.
// Returns { kind, label, jobId?, binBarcode? }.
//   kind: 'assign' | 'job' | 'warehouse' | 'wait' | 'idle' | 'done'
export async function deriveNextAction(bookingId, booking) {
  const bins = await listBinsForBooking(bookingId);
  const assignedCount = bins.length;

  // Bins still need binding to the booking.
  if (assignedCount < (booking.bin_count || 0)) {
    const missing = booking.bin_count - assignedCount;
    return { kind: 'assign', label: `Assign ${missing} more bin${missing === 1 ? '' : 's'}` };
  }

  const has = (status) => bins.find((b) => b.status === status);
  const jobs = (await listJobs()).filter((j) => j.booking_id === bookingId);
  const scheduledOf = (type) => jobs.find((j) => j.type === type && j.status === 'Scheduled');

  // Highest-priority actionable step first, walking the pipeline.
  if (has(STATUS.ASSIGNED)) {
    const job = scheduledOf('deliver_empty');
    return { kind: 'job', label: 'Mark empties delivered', jobId: job?.id };
  }
  if (has(STATUS.IN_TRANSIT_INBOUND)) {
    return { kind: 'warehouse', label: 'Put away in warehouse', binBarcode: has(STATUS.IN_TRANSIT_INBOUND).barcode, mode: 'store' };
  }
  if (has(STATUS.RETRIEVAL_REQUESTED)) {
    return { kind: 'warehouse', label: 'Scan bin out of rack', binBarcode: has(STATUS.RETRIEVAL_REQUESTED).barcode, mode: 'scanout' };
  }
  if (has(STATUS.IN_TRANSIT_OUTBOUND)) {
    const job = scheduledOf('deliver_back');
    return { kind: 'job', label: 'Mark return delivered', jobId: job?.id };
  }
  if (has(STATUS.OUT_FOR_FILLING)) {
    const job = scheduledOf('collect_full');
    if (job) return { kind: 'job', label: 'Mark collection done', jobId: job.id };
    return { kind: 'wait', label: 'Awaiting customer to book collection' };
  }
  if (has(STATUS.STORED)) {
    return { kind: 'idle', label: 'Stored — awaiting customer' };
  }
  if (bins.length && bins.every((b) => b.status === STATUS.RETURNED_CLOSED)) {
    return { kind: 'done', label: 'Complete' };
  }
  return { kind: 'idle', label: 'With customer' };
}
