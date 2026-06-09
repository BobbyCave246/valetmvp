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
  setJobScheduledDate,
} from '../db.js';
import { transitionBin, STATUS } from '../transitions.js';
import { deriveBookingSummary, deriveNextAction } from '../summary.js';

const router = Router();

// POST /api/bookings — create customer (if new) + booking + a deliver_empty job.
router.post('/', async (req, res) => {
  const { name, phone, email, address, skuBreakdown = {}, deliveryDate } = req.body || {};

  if (!name || !phone || !deliveryDate) {
    return res.status(400).json({ error: 'name, phone and deliveryDate are required' });
  }

  const binCount = Object.values(skuBreakdown).reduce((a, b) => a + Number(b || 0), 0);
  if (binCount < 1) {
    return res.status(400).json({ error: 'Booking must include at least one bin' });
  }

  try {
    // Reuse an existing customer (matched by phone) or create a new one.
    let customer = await findCustomerByPhone(phone);
    if (!customer) {
      customer = await createCustomer({ name, phone, email, address });
    }

    const booking = await createBooking({
      customerId: customer.id,
      binCount,
      skuBreakdown,
      deliveryDate,
    });

    // A deliver_empty job is scheduled for the requested delivery date. Bins are
    // assigned later by the admin, so bin_ids starts empty.
    const job = await createJob({
      bookingId: booking.id,
      type: 'deliver_empty',
      scheduledDate: deliveryDate,
      binIds: [],
    });

    res.status(201).json({ booking, customer, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/bookings — admin queue with derived bin-status summaries.
router.get('/', async (_req, res) => {
  const rows = await listBookings();
  const bookings = await Promise.all(
    rows.map(async (b) => {
      const [customer, summary, nextAction] = await Promise.all([
        getCustomer(b.customer_id),
        deriveBookingSummary(b.id),
        deriveNextAction(b.id, b),
      ]);
      return {
        ...b,
        sku_breakdown: safeParse(b.sku_breakdown),
        customer,
        summary,
        assignedCount: summary.total,
        nextAction,
      };
    })
  );
  res.json(bookings);
});

// GET /api/bookings/by-phone/:phone — customer lookup by phone (no login).
// Defined before /:id so the literal segment isn't shadowed.
router.get('/by-phone/:phone', async (req, res) => {
  const rows = await findBookingByPhone(req.params.phone);
  const bookings = await Promise.all(
    rows.map(async (b) => ({
      ...b,
      sku_breakdown: safeParse(b.sku_breakdown),
      summary: await deriveBookingSummary(b.id),
    }))
  );
  res.json(bookings);
});

// GET /api/bookings/:id — customer lookup + admin detail (bins + statuses).
router.get('/:id', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const [customer, bins, summary, allJobs] = await Promise.all([
    getCustomer(booking.customer_id),
    listBinsForBooking(booking.id),
    deriveBookingSummary(booking.id),
    listJobs(),
  ]);
  const jobs = allJobs
    .filter((j) => j.booking_id === booking.id)
    .map((j) => ({ ...j, bin_ids: safeParse(j.bin_ids) || [] }));
  res.json({
    ...booking,
    sku_breakdown: safeParse(booking.sku_breakdown),
    customer,
    bins,
    summary,
    jobs,
  });
});

// POST /api/bookings/:id/assign-bins — bind scanned bins to the booking.
// Body: { barcodes: ["BIN1001", ...] }
router.post('/:id/assign-bins', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { barcodes } = req.body || {};
  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return res.status(400).json({ error: 'barcodes array is required' });
  }

  try {
    // Validate every barcode up front so the assignment is all-or-nothing-ish.
    const bins = [];
    for (const barcode of barcodes) {
      const bin = await getBinByBarcode(barcode);
      if (!bin) return res.status(404).json({ error: `Unknown bin barcode: ${barcode}` });
      if (bin.booking_id) {
        return res.status(409).json({ error: `Bin ${barcode} is already assigned` });
      }
      bins.push(bin);
    }

    const assigned = await bindBinsToBooking(booking, bins);
    res.json({ assigned, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/auto-assign — system picks free bins matching the
// booking's SKU mix and binds them, producing a pick list for the warehouse.
// Idempotent: re-running tops up whatever is still needed.
router.post('/:id/auto-assign', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const breakdown = safeParse(booking.sku_breakdown) || {};

  try {
    // What's still needed per SKU = requested minus already-assigned by sku_type.
    const assignedBySku = {};
    for (const b of await listBinsForBooking(booking.id)) {
      assignedBySku[b.sku_type] = (assignedBySku[b.sku_type] || 0) + 1;
    }

    // Group free bins by sku_type (ordered by barcode → deterministic picks).
    const freeBySku = {};
    for (const bin of await listAvailableBins()) {
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

    const assigned = toAssign.length ? await bindBinsToBooking(booking, toAssign) : [];
    const pickList = (await listBinsForBooking(booking.id))
      .filter((b) => b.status === STATUS.ASSIGNED)
      .map((b) => ({ barcode: b.barcode, sku_type: b.sku_type }));
    res.json({
      assigned,
      shortages,
      pickList,
      summary: await deriveBookingSummary(booking.id),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/book-collection — customer schedules (or reschedules)
// the pickup of their filled bins. Idempotent at the booking level: covers all
// the booking's "Out for filling" bins on the chosen date.
// Body: { collectionDate }.
router.post('/:id/book-collection', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { collectionDate } = req.body || {};
  if (!collectionDate) {
    return res.status(400).json({ error: 'collectionDate is required' });
  }

  try {
    const binIds = (await listBinsForBooking(booking.id))
      .filter((b) => b.status === STATUS.OUT_FOR_FILLING)
      .map((b) => b.id);
    if (binIds.length === 0) {
      return res.status(409).json({ error: 'No bins are out for filling yet' });
    }

    // Reschedule the existing scheduled collect_full job, or create one.
    const existing = (await listJobs()).find(
      (j) => j.booking_id === booking.id && j.type === 'collect_full' && j.status === 'Scheduled'
    );
    let job;
    if (existing) {
      await setJobScheduledDate(existing.id, collectionDate);
      await setJobBinIds(existing.id, binIds);
      job = { ...existing, scheduled_date: collectionDate, bin_ids: JSON.stringify(binIds) };
    } else {
      job = await createJob({
        bookingId: booking.id,
        type: 'collect_full',
        scheduledDate: collectionDate,
        binIds,
      });
    }

    res.json({ job, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- helpers -----------------------------------------------------------------

// Binds bins to a booking: sets ownership, transitions each to Assigned (which
// logs a movement), and attaches them to the booking's deliver_empty job.
// Shared by manual assign-bins and auto-assign.
async function bindBinsToBooking(booking, bins, actor = 'admin') {
  const assigned = [];
  for (const bin of bins) {
    // Bind ownership first, then transition (which writes the movement).
    await setBinFields(bin.id, { customer_id: booking.customer_id, booking_id: booking.id });
    assigned.push(await transitionBin(bin.id, STATUS.ASSIGNED, { actor }));
  }
  await attachBinsToDeliverEmptyJob(booking.id, assigned.map((b) => b.id));
  return assigned;
}

async function attachBinsToDeliverEmptyJob(bookingId, binIds) {
  // Find the scheduled deliver_empty job for this booking and set its bin_ids.
  const job = (await listJobs()).find(
    (j) => j.booking_id === bookingId && j.type === 'deliver_empty' && j.status === 'Scheduled'
  );
  if (job) {
    const existing = safeParse(job.bin_ids) || [];
    const merged = Array.from(new Set([...existing, ...binIds]));
    await setJobBinIds(job.id, merged);
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
