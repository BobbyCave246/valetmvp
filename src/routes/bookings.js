// Booking routes. Handlers stay thin — state changes go through transitions.js.

import { Router } from 'express';
import {
  createCustomer,
  findMatchingCustomer,
  createBooking,
  getBooking,
  listBookings,
  findBookingByPhone,
  getCustomer,
  getBinByBarcode,
  listBinsForBooking,
  listAvailableBins,
  listJobsForBooking,
  countDeliveriesForSlot,
  deleteBooking,
  createPayment,
  listPaymentsForBooking,
  listPaidBookingIds,
} from '../db.js';
import { TERMS_VERSION } from '../terms.js';
import { cancelBooking, STATUS } from '../transitions.js';
import {
  createDeliverEmpty,
  scheduleCollection,
  requestRetrieval,
  cancelRetrieval,
  cancelUnassignedBooking,
  assignBinsToBooking,
} from '../jobs-lifecycle.js';
import { requireAuth, requireRole } from '../auth.js';
import { loadBookingFor, publicBaseUrl, bookingLink } from '../booking-access.js';
import { rateLimit, clientIp } from '../ratelimit.js';
import { deriveBookingSummary, deriveNextAction, deriveCustomerNextStep } from '../summary.js';
import { isCovered } from '../coverage.js';
import { validateDateSlot, validateFutureDate, SLOT_CAPACITY, SLOTS } from '../slots.js';
import { safeParse, VALID_SKUS } from '../util.js';
import { sendBookingConfirmation, sendBookingLinks } from '../notify.js';
import { enrichBins } from '../storage.js';

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

// Public and unauthenticated, so cap bookings per IP to stop someone filling
// every delivery window with junk.
const createByIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.BOOKING_RATE_MAX || 10),
  keyFn: (req) => `booking-ip|${clientIp(req)}`,
});

// POST /api/bookings — create customer (if new) + booking + a deliver_empty job.
router.post('/', createByIp, async (req, res) => {
  const {
    name,
    phone,
    email,
    address,
    area,
    skuBreakdown = {},
    deliveryDate,
    deliverySlot,
    termsAccepted,
  } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }
  if (termsAccepted !== true) {
    return res.status(400).json({ error: 'Please accept the terms & conditions to book' });
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

    // Reuse an existing customer only on an exact match, else create one.
    const details = { name, phone, email: email || null, address: address || null, postcode: area };
    let customer = await findMatchingCustomer(details);
    if (!customer) customer = await createCustomer(details);

    const booking = await createBooking({
      customerId: customer.id,
      binCount,
      skuBreakdown,
      deliveryDate,
      deliverySlot,
      termsVersion: TERMS_VERSION,
    });

    // The deliver_empty job is created with a transactional capacity check so
    // concurrent bookings can't overshoot the window. If we lose that race,
    // remove the just-created booking so no orphan is left behind.
    let job;
    try {
      job = await createDeliverEmpty(booking.id, {
        date: deliveryDate,
        slot: deliverySlot,
        capacity: SLOT_CAPACITY,
      });
    } catch (err) {
      await deleteBooking(booking.id);
      throw err;
    }

    // Fire the confirmation email without blocking the response. notify is
    // self-contained: it no-ops if email isn't configured and never throws, so
    // a mail problem can't fail an otherwise-successful booking.
    void sendBookingConfirmation({
      booking,
      customer,
      skuBreakdown,
      link: bookingLink(publicBaseUrl(req), booking),
    });

    // Only the id: the caller already knows the details they sent.
    res.status(201).json({ booking, customer: { id: customer.id }, job });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// GET /api/bookings — admin queue with derived bin-status summaries.
router.get('/', requireAuth, requireRole('admin'), async (_req, res) => {
  const [rows, paidIds] = await Promise.all([listBookings(), listPaidBookingIds()]);
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
        paid: paidIds.has(b.id),
      };
    })
  );
  res.json(bookings);
});

// POST /api/bookings/lookup { phone } — customer lost their link. We send the
// booking links to the phone (SMS) and email on file, and never say in the
// response whether the number matched, so it can't be used to find customers.
// Throttled per IP and per phone so it can't be used to spam someone.
const lookupByIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOOKUP_RATE_MAX || 10),
  keyFn: (req) => `lookup-ip|${clientIp(req)}`,
});
const lookupByPhone = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyFn: (req) => `lookup-phone|${String(req.body?.phone || '').trim()}`,
});

router.post('/lookup', lookupByIp, lookupByPhone, async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const bookings = await findBookingByPhone(phone);
  if (bookings.length) {
    const base = publicBaseUrl(req);
    const entries = await Promise.all(
      bookings.map(async (b) => ({
        booking: b,
        link: bookingLink(base, b),
        email: (await getCustomer(b.customer_id))?.email || null,
      }))
    );
    void sendBookingLinks({ phone, entries });
  }
  res.json({ ok: true });
});

// ----- payments (admin) ------------------------------------------------------
// Staff take the money on Plug'n Pay, then record it here by its reference.

const PAYMENT_KINDS = ['first_month', 'storage', 'retrieval', 'other'];

function validatePayment({ kind, amount, reference, period, note }) {
  if (!PAYMENT_KINDS.includes(kind)) return `kind must be one of: ${PAYMENT_KINDS.join(', ')}`;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 100000 || Math.round(n * 100) !== n * 100) {
    return 'amount must be a positive BDS$ amount with at most 2 decimal places';
  }
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 100) {
    return "reference (the Plug'n Pay transaction reference) is required";
  }
  if (period != null && period !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) {
    return 'period must be YYYY-MM';
  }
  if (note != null && String(note).length > 500) return 'note is too long';
  return null;
}

// GET /api/bookings/:id/payments
router.get('/:id/payments', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await listPaymentsForBooking(req.params.id));
});

// POST /api/bookings/:id/payments { kind, amount, reference, period?, note? }
router.post('/:id/payments', requireAuth, requireRole('admin'), async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const body = req.body || {};
  const err = validatePayment(body);
  if (err) return res.status(400).json({ error: err });
  const payment = await createPayment({
    bookingId: booking.id,
    kind: body.kind,
    amount: Number(body.amount),
    reference: body.reference.trim(),
    period: body.period || null,
    note: body.note ? String(body.note) : null,
    recordedBy: req.user.id,
  });
  res.status(201).json({ payment });
});

// GET /api/bookings/:id — customer lookup + admin detail (bins + statuses).
// POST /api/bookings/:id/cancel — admin cancel. Releases the booking's bins
// back to inventory (freeing rack slots), logs the release per bin, deletes
// the booking's jobs and the booking itself. Gated by ADMIN_TOKEN if set.
// POST /api/bookings/:id/cancel-unassigned — admin cancel when no bins assigned.
router.post('/:id/cancel-unassigned', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await cancelUnassignedBooking(req.params.id);
    res.json(result);
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

router.post('/:id/cancel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await cancelBooking(req.params.id, { actor: 'admin' });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// POST /api/bookings/:id/cancel-retrieval — customer or admin cancels retrieval
// for one or more bins in Retrieval requested. Body: { binIds: string[] }.
router.post('/:id/cancel-retrieval', async (req, res) => {
  const { booking, actor } = await loadBookingFor(req, req.params.id);

  const { binIds } = req.body || {};
  if (!Array.isArray(binIds) || binIds.length === 0) {
    return res.status(400).json({ error: 'binIds array is required' });
  }
  if (new Set(binIds).size !== binIds.length) {
    return res.status(400).json({ error: 'Duplicate binIds in request' });
  }

  try {
    const result = await cancelRetrieval(booking.id, { binIds, actor });
    res.json({ ...result, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { booking } = await loadBookingFor(req, req.params.id);

  const [customer, rawBins, summary, rawJobs] = await Promise.all([
    getCustomer(booking.customer_id),
    listBinsForBooking(booking.id),
    deriveBookingSummary(booking.id),
    listJobsForBooking(booking.id),
  ]);
  const bins = await enrichBins(rawBins);
  const jobs = rawJobs.map((j) => ({ ...j, bin_ids: safeParse(j.bin_ids) || [] }));
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

    const assigned = await assignBinsToBooking(
      booking.id,
      bins.map((b) => b.id),
      { actor: 'admin' }
    );
    res.json({ assigned, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
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

    const assigned = toAssign.length
      ? await assignBinsToBooking(
          booking.id,
          toAssign.map((b) => b.id),
          { actor: 'admin' }
        )
      : [];
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
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// POST /api/bookings/:id/book-collection — customer schedules (or reschedules)
// the pickup of their filled bins. Idempotent at the booking level: covers all
// the booking's "Out for filling" bins on the chosen date.
// Body: { collectionDate, collectionSlot? }.
router.post('/:id/book-collection', async (req, res) => {
  const { booking } = await loadBookingFor(req, req.params.id);

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

    const job = await scheduleCollection(booking.id, {
      date: collectionDate,
      slot: collectionSlot || null,
      binIds,
    });

    res.json({ job, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// POST /api/bookings/:id/request-return — customer retrieval request for one
// or more Stored bins. Atomic at the booking level: all bins transition together
// and share a single deliver_back job (mirrors book-collection).
// Body: { binIds: string[], deliveryBackDate, deliveryBackSlot? }.
router.post('/:id/request-return', async (req, res) => {
  const { booking } = await loadBookingFor(req, req.params.id);

  const { binIds, deliveryBackDate, deliveryBackSlot } = req.body || {};
  const dateErr = validateFutureDate(deliveryBackDate);
  if (dateErr) return res.status(400).json({ error: dateErr });
  if (deliveryBackSlot && !SLOTS.some((s) => s.key === deliveryBackSlot)) {
    return res.status(400).json({ error: 'A valid delivery window is required' });
  }
  if (!Array.isArray(binIds) || binIds.length === 0) {
    return res.status(400).json({ error: 'binIds array is required' });
  }
  if (new Set(binIds).size !== binIds.length) {
    return res.status(400).json({ error: 'Duplicate binIds in request' });
  }

  try {
    const job = await requestRetrieval(booking.id, {
      binIds,
      date: deliveryBackDate,
      slot: deliveryBackSlot || null,
    });
    res.json({ job, summary: await deriveBookingSummary(booking.id) });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

export default router;
