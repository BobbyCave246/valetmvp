// Booking routes. Handlers stay thin — state changes go through transitions.js.

import { Router } from 'express';
import {
  createCustomer,
  findCustomerByPhone,
  createBooking,
  getBooking,
  listBookings,
  findBookingByPhone,
  getCustomer,
  createJob,
  getBinByBarcode,
  listBinsForBooking,
  listAvailableBins,
  setBinFields,
  listJobs,
  setJobBinIds,
} from '../db.js';
import { transitionBin, STATUS } from '../transitions.js';
import { deriveBookingSummary, deriveNextAction } from '../summary.js';

const router = Router();

// POST /api/bookings — create customer (if new) + booking + a deliver_empty job.
router.post('/', (req, res) => {
  const { name, phone, email, address, skuBreakdown = {}, deliveryDate } = req.body || {};

  if (!name || !phone || !deliveryDate) {
    return res.status(400).json({ error: 'name, phone and deliveryDate are required' });
  }

  const binCount = Object.values(skuBreakdown).reduce((a, b) => a + Number(b || 0), 0);
  if (binCount < 1) {
    return res.status(400).json({ error: 'Booking must include at least one bin' });
  }

  // Reuse an existing customer (matched by phone) or create a new one.
  let customer = findCustomerByPhone(phone);
  if (!customer) {
    customer = createCustomer({ name, phone, email, address });
  }

  const booking = createBooking({
    customerId: customer.id,
    binCount,
    skuBreakdown,
    deliveryDate,
  });

  // A deliver_empty job is scheduled for the requested delivery date. Bins are
  // assigned later by the admin, so bin_ids starts empty.
  const job = createJob({
    bookingId: booking.id,
    type: 'deliver_empty',
    scheduledDate: deliveryDate,
    binIds: [],
  });

  res.status(201).json({ booking, customer, job });
});

// GET /api/bookings — admin queue with derived bin-status summaries.
router.get('/', (_req, res) => {
  const bookings = listBookings().map((b) => {
    const customer = getCustomer(b.customer_id);
    const summary = deriveBookingSummary(b.id);
    return {
      ...b,
      sku_breakdown: safeParse(b.sku_breakdown),
      customer,
      summary,
      assignedCount: summary.total,
      nextAction: deriveNextAction(b.id, b),
    };
  });
  res.json(bookings);
});

// GET /api/bookings/by-phone/:phone — customer lookup by phone (no login).
// Defined before /:id so the literal segment isn't shadowed.
router.get('/by-phone/:phone', (req, res) => {
  const bookings = findBookingByPhone(req.params.phone).map((b) => ({
    ...b,
    sku_breakdown: safeParse(b.sku_breakdown),
    summary: deriveBookingSummary(b.id),
  }));
  res.json(bookings);
});

// GET /api/bookings/:id — customer lookup + admin detail (bins + statuses).
router.get('/:id', (req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  res.json({
    ...booking,
    sku_breakdown: safeParse(booking.sku_breakdown),
    customer: getCustomer(booking.customer_id),
    bins: listBinsForBooking(booking.id),
    summary: deriveBookingSummary(booking.id),
  });
});

// POST /api/bookings/:id/assign-bins — bind scanned bins to the booking.
// Body: { barcodes: ["BIN1001", ...] }
router.post('/:id/assign-bins', (req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { barcodes } = req.body || {};
  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return res.status(400).json({ error: 'barcodes array is required' });
  }

  // Validate every barcode up front so the assignment is all-or-nothing-ish.
  const bins = [];
  for (const barcode of barcodes) {
    const bin = getBinByBarcode(barcode);
    if (!bin) return res.status(404).json({ error: `Unknown bin barcode: ${barcode}` });
    if (bin.booking_id) {
      return res.status(409).json({ error: `Bin ${barcode} is already assigned` });
    }
    bins.push(bin);
  }

  try {
    const assigned = bindBinsToBooking(booking, bins);
    res.json({ assigned, summary: deriveBookingSummary(booking.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/auto-assign — system picks free bins matching the
// booking's SKU mix and binds them, producing a pick list for the warehouse.
// Idempotent: re-running tops up whatever is still needed.
router.post('/:id/auto-assign', (req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const breakdown = safeParse(booking.sku_breakdown) || {};

  // What's still needed per SKU = requested minus already-assigned by sku_type.
  const assignedBySku = {};
  for (const b of listBinsForBooking(booking.id)) {
    assignedBySku[b.sku_type] = (assignedBySku[b.sku_type] || 0) + 1;
  }

  // Group free bins by sku_type (ordered by barcode → deterministic picks).
  const freeBySku = {};
  for (const bin of listAvailableBins()) {
    (freeBySku[bin.sku_type] ||= []).push(bin);
  }

  const toAssign = [];
  const shortages = {};
  for (const [sku, requested] of Object.entries(breakdown)) {
    const need = Math.max(0, requested - (assignedBySku[sku] || 0));
    if (need === 0) continue;
    const available = freeBySku[sku] || [];
    const picked = available.slice(0, need);
    toAssign.push(...picked);
    if (picked.length < need) shortages[sku] = need - picked.length;
  }

  try {
    const assigned = toAssign.length ? bindBinsToBooking(booking, toAssign) : [];
    const pickList = listBinsForBooking(booking.id)
      .filter((b) => b.status === STATUS.ASSIGNED)
      .map((b) => ({ barcode: b.barcode, sku_type: b.sku_type }));
    res.json({
      assigned,
      shortages,
      pickList,
      summary: deriveBookingSummary(booking.id),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- helpers -----------------------------------------------------------------

// Binds bins to a booking: sets ownership, transitions each to Assigned (which
// logs a movement), and attaches them to the booking's deliver_empty job.
// Shared by manual assign-bins and auto-assign.
function bindBinsToBooking(booking, bins, actor = 'admin') {
  const assigned = bins.map((bin) => {
    setBinFields(bin.id, { customer_id: booking.customer_id, booking_id: booking.id });
    return transitionBin(bin.id, STATUS.ASSIGNED, { actor });
  });
  attachBinsToDeliverEmptyJob(booking.id, assigned.map((b) => b.id));
  return assigned;
}

function attachBinsToDeliverEmptyJob(bookingId, binIds) {
  // Find the scheduled deliver_empty job for this booking and set its bin_ids.
  const job = listJobs().find(
    (j) => j.booking_id === bookingId && j.type === 'deliver_empty' && j.status === 'Scheduled'
  );
  if (job) {
    const existing = safeParse(job.bin_ids) || [];
    const merged = Array.from(new Set([...existing, ...binIds]));
    setJobBinIds(job.id, merged);
  }
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default router;
