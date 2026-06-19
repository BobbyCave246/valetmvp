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
  listJobsForBooking,
  setJobBinIds,
  setJobScheduledDate,
  setJobSchedule,
  countDeliveriesForSlot,
  createDeliveryJobIfCapacity,
  deleteBooking,
  sql,
} from '../db.js';
import { transitionBin, transitionBinInTx, cancelBooking, STATUS } from '../transitions.js';
import { requireAuth, requireRole } from '../auth.js';
import { deriveBookingSummary, deriveNextAction, deriveCustomerNextStep } from '../summary.js';
import { isCovered } from '../coverage.js';
import { validateDateSlot, validateFutureDate, SLOT_CAPACITY, SLOTS } from '../slots.js';
import { safeParse, VALID_SKUS } from '../util.js';
import { sendBookingConfirmation } from '../notify.js';

const router = Router();

const MAX_PER_SKU = 50;

// Returns null if ok, else an error message.
function validateSkuBreakdown(skuBreakdown) {
  if (!skuBreakdown || typeof skuBreakdown !== 'object' || Array.isArray(skuBreakdown)) {
    return 'skuBreakdown must be an object';
  }
  for (const [sku, n] of Object.entries(skuBreakdown)) {
    if (!VALID_SKUS.includes(sku)) return `Unknown SKU: ${sku}`;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_SKU) {
      return `Count for ${sku} must be a whole number between 1 and ${MAX_PER_SKU}`;
    }
  }
  return null;
}

// POST /api/bookings — create customer (if new) + booking + a deliver_empty job.
router.post('/', async (req, res) => {
  const {
    name,
    phone,
    email,
    address,
    area,
    skuBreakdown = {},
    deliveryDate,
    deliverySlot,
  } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }
  // Serviceability gate.
  if (!isCovered(area)) {
    return res.status(409).json({ error: "We don't cover that area yet" });
  }
  // Delivery date + window (lead time / valid slot).
  const slotErr = validateDateSlot(deliveryDate, deliverySlot);
  if (slotErr) return res.status(400).json({ error: slotErr });

  const skuErr = validateSkuBreakdown(skuBreakdown);
  if (skuErr) return res.status(400).json({ error: skuErr });
  const binCount = Object.values(skuBreakdown).reduce((a, b) => a + b, 0);
  if (binCount < 1) {
    return res.status(400).json({ error: 'Booking must include at least one bin' });
  }

  try {
    // Fast-path capacity check (the authoritative check is transactional below).
    if ((await countDeliveriesForSlot(deliveryDate, deliverySlot)) >= SLOT_CAPACITY) {
      return res.status(409).json({ error: 'That delivery window is full — please pick another' });
    }

    // Reuse an existing customer (matched by phone) or create a new one.
    let customer = await findCustomerByPhone(phone);
    if (!customer) {
      customer = await createCustomer({ name, phone, email, address, postcode: area });
    }

    const booking = await createBooking({
      customerId: customer.id,
      binCount,
      skuBreakdown,
      deliveryDate,
      deliverySlot,
    });

    // The deliver_empty job is created with a transactional capacity check so
    // concurrent bookings can't overshoot the window. If we lose that race,
    // remove the just-created booking so no orphan is left behind.
    let job;
    try {
      job = await createDeliveryJobIfCapacity({
        bookingId: booking.id,
        scheduledDate: deliveryDate,
        scheduledSlot: deliverySlot,
        capacity: SLOT_CAPACITY,
      });
    } catch (err) {
      await deleteBooking(booking.id);
      throw err;
    }

    // Fire the confirmation email without blocking the response. notify is
    // self-contained: it no-ops if email isn't configured and never throws, so
    // a mail problem can't fail an otherwise-successful booking.
    void sendBookingConfirmation({ booking, customer, skuBreakdown });

    res.status(201).json({ booking, customer, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/bookings — admin queue with derived bin-status summaries.
router.get('/', requireAuth, requireRole('admin'), async (_req, res) => {
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
// POST /api/bookings/:id/cancel — admin cancel. Releases the booking's bins
// back to inventory (freeing rack slots), logs the release per bin, deletes
// the booking's jobs and the booking itself. Gated by ADMIN_TOKEN if set.
router.post('/:id/cancel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await cancelBooking(req.params.id, { actor: 'admin' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
    customerNextStep: deriveCustomerNextStep(booking, bins, jobs),
  });
});

// POST /api/bookings/:id/assign-bins — bind scanned bins to the booking.
// Body: { barcodes: ["BIN1001", ...] }
router.post('/:id/assign-bins', requireAuth, requireRole('admin'), async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { barcodes } = req.body || {};
  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return res.status(400).json({ error: 'barcodes array is required' });
  }
  if (barcodes.some((b) => typeof b !== 'string' || !b.trim())) {
    return res.status(400).json({ error: 'barcodes must be non-empty strings' });
  }
  if (new Set(barcodes).size !== barcodes.length) {
    return res.status(400).json({ error: 'Duplicate barcodes in request' });
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
router.post('/:id/auto-assign', requireAuth, requireRole('admin'), async (req, res) => {
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
// Body: { collectionDate, collectionSlot? }.
router.post('/:id/book-collection', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { collectionDate, collectionSlot } = req.body || {};
  const dateErr = validateFutureDate(collectionDate);
  if (dateErr) return res.status(400).json({ error: dateErr });
  if (collectionSlot && !SLOTS.some((s) => s.key === collectionSlot)) {
    return res.status(400).json({ error: 'A valid collection window is required' });
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
      await setJobSchedule(existing.id, collectionDate, collectionSlot || null);
      await setJobBinIds(existing.id, binIds);
      job = { ...existing, scheduled_date: collectionDate, scheduled_slot: collectionSlot || null, bin_ids: JSON.stringify(binIds) };
    } else {
      job = await createJob({
        bookingId: booking.id,
        type: 'collect_full',
        scheduledDate: collectionDate,
        scheduledSlot: collectionSlot || null,
        binIds,
      });
    }

    res.json({ job, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/request-return — customer retrieval request for one
// or more Stored bins. Atomic at the booking level: all bins transition together
// and share a single deliver_back job (mirrors book-collection).
// Body: { binIds: string[], deliveryBackDate }.
router.post('/:id/request-return', async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { binIds, deliveryBackDate } = req.body || {};
  const dateErr = validateFutureDate(deliveryBackDate);
  if (dateErr) return res.status(400).json({ error: dateErr });
  if (!Array.isArray(binIds) || binIds.length === 0) {
    return res.status(400).json({ error: 'binIds array is required' });
  }
  if (new Set(binIds).size !== binIds.length) {
    return res.status(400).json({ error: 'Duplicate binIds in request' });
  }

  try {
    const job = await performRequestReturn(booking, binIds, deliveryBackDate);
    res.json({ job, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- helpers -----------------------------------------------------------------

// Booking-level retrieval: transitions all requested Stored bins and creates or
// reschedules a single deliver_back job. Exported for integration tests.
export async function performRequestReturn(booking, binIds, deliveryBackDate) {
  const sortedBinIds = [...binIds].sort();
  const bookingBins = await listBinsForBooking(booking.id);
  const byId = new Map(bookingBins.map((b) => [b.id, b]));
  for (const id of sortedBinIds) {
    const bin = byId.get(id);
    if (!bin) {
      throw Object.assign(new Error(`Bin ${id} does not belong to this booking`), { status: 409 });
    }
    if (bin.status !== STATUS.STORED) {
      throw Object.assign(
        new Error(`Bin ${bin.barcode} is not stored (status: ${bin.status ?? 'unassigned'})`),
        { status: 409 }
      );
    }
  }

  return sql.begin(async (tx) => {
    for (const id of sortedBinIds) {
      await transitionBinInTx(tx, id, STATUS.RETRIEVAL_REQUESTED, { actor: 'customer' });
    }

    const retrievalBinIds = (await listBinsForBooking(booking.id, tx))
      .filter((b) => b.status === STATUS.RETRIEVAL_REQUESTED)
      .map((b) => b.id);

    const existing = (await listJobsForBooking(booking.id, tx)).find(
      (j) => j.type === 'deliver_back' && j.status === 'Scheduled'
    );

    if (existing) {
      await setJobScheduledDate(existing.id, deliveryBackDate, tx);
      await setJobBinIds(existing.id, retrievalBinIds, tx);
      return { ...existing, scheduled_date: deliveryBackDate, bin_ids: JSON.stringify(retrievalBinIds) };
    }

    return createJob(
      {
        bookingId: booking.id,
        type: 'deliver_back',
        scheduledDate: deliveryBackDate,
        binIds: retrievalBinIds,
      },
      tx
    );
  });
}

// Binds bins to a booking: sets ownership, transitions each to Assigned (which
// logs a movement), and attaches them to the booking's deliver_empty job.
// Shared by manual assign-bins and auto-assign.
async function bindBinsToBooking(booking, bins, actor = 'admin') {
  const assigned = [];
  try {
    for (const bin of bins) {
      // Ownership + status change in ONE row-locked transaction (via
      // transitionBin's binFields) so a concurrent assign that loses the
      // legality check can't leave ownership pointing at the losing booking.
      assigned.push(
        await transitionBin(bin.id, STATUS.ASSIGNED, {
          actor,
          binFields: { customer_id: booking.customer_id, booking_id: booking.id },
        })
      );
    }
  } finally {
    // Sync the job's pick list even if the loop aborted partway (a lost race),
    // so already-won bins are never missing from the deliver_empty job.
    await attachBinsToDeliverEmptyJob(booking.id).catch(() => {});
  }
  return assigned;
}

async function attachBinsToDeliverEmptyJob(bookingId) {
  // Recompute the scheduled deliver_empty job's bin list from the DB (all the
  // booking's currently-Assigned bins) — self-healing under partial failures.
  const job = (await listJobs()).find(
    (j) => j.booking_id === bookingId && j.type === 'deliver_empty' && j.status === 'Scheduled'
  );
  if (job) {
    const binIds = (await listBinsForBooking(bookingId))
      .filter((b) => b.status === STATUS.ASSIGNED)
      .map((b) => b.id);
    await setJobBinIds(job.id, binIds);
  }
}

export default router;
