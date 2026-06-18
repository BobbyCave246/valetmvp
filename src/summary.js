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

// Customer-facing "what happens next" for the booking site.
export function deriveCustomerNextStep(booking, bins = [], jobs = []) {
  const assignedCount = bins.length;
  const windowLabel = booking.delivery_slot
    ? ` (${booking.delivery_slot === 'am' ? 'morning' : 'afternoon'})`
    : '';

  if (assignedCount < (booking.bin_count || 0)) {
    return {
      title: 'We received your booking',
      message: `We're assigning physical bins to your order. Empty bins will be delivered on ${booking.delivery_date}${windowLabel}.`,
      timeline: [
        { label: 'Booking received', state: 'done' },
        { label: 'Assigning bins', state: 'current' },
        { label: `Delivery on ${booking.delivery_date}`, state: 'upcoming' },
      ],
    };
  }

  const has = (status) => bins.some((b) => b.status === status);
  const scheduledOf = (type) => jobs.find((j) => j.type === type && j.status === 'Scheduled');

  if (has(STATUS.ASSIGNED)) {
    return {
      title: 'Bins reserved for you',
      message: `Your bins are assigned. We'll deliver empty bins on ${booking.delivery_date}${windowLabel}.`,
      timeline: [
        { label: 'Booking received', state: 'done' },
        { label: 'Bins assigned', state: 'done' },
        { label: `Delivery on ${booking.delivery_date}`, state: 'current' },
      ],
    };
  }
  if (has(STATUS.OUT_FOR_FILLING)) {
    const job = scheduledOf('collect_full');
    if (job) {
      return {
        title: 'Fill your bins',
        message: `Collection scheduled for ${job.scheduled_date}. Pack your bins and we'll pick them up.`,
        timeline: null,
      };
    }
    return {
      title: 'Fill your bins',
      message: 'Your empty bins have been delivered. Fill them, add a photo if you like, then book a collection date.',
      timeline: null,
    };
  }
  if (has(STATUS.IN_TRANSIT_INBOUND)) {
    return {
      title: 'On the way to our warehouse',
      message: "Your filled bins are in transit. We'll rack and store them shortly.",
      timeline: null,
    };
  }
  if (has(STATUS.STORED)) {
    return {
      title: 'Safely stored',
      message: 'Your bins are in our warehouse. Request any bin back whenever you need it ($30 delivery fee per request).',
      timeline: null,
    };
  }
  if (has(STATUS.RETRIEVAL_REQUESTED) || has(STATUS.IN_TRANSIT_OUTBOUND)) {
    return {
      title: 'Bins on their way back',
      message: 'Your requested bins are being returned to your door.',
      timeline: null,
    };
  }
  if (bins.length && bins.every((b) => b.status === STATUS.RETURNED_CLOSED)) {
    return { title: 'All bins closed', message: 'This booking is complete. Thank you for using Store All Valet.', timeline: null };
  }
  return {
    title: 'With you',
    message: 'Your bins are with you. Store them again or close bins you no longer need.',
    timeline: null,
  };
}
