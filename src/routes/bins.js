// Bin routes: photo stub, warehouse put-away/scan-out, retrieval request,
// chain-of-custody history, plus lookup helpers for the UIs.

import { Router } from 'express';
import {
  getBin,
  getBinByBarcode,
  setBinFields,
  listAvailableBins,
  getLocationByBarcode,
  listFreeLocations,
  getLocation,
  createJob,
  listJobs,
  setJobBinIds,
  getBooking,
  listMovementsForBin,
} from '../db.js';
import { transitionBin, STATUS } from '../transitions.js';

const router = Router();

// GET /api/bins/available — unassigned bins for the assign-bins screen.
router.get('/available', (_req, res) => {
  res.json(listAvailableBins());
});

// POST /api/bins/:barcode/photo — attach contents-photo stub + schedule a
// collect_full job (spec §4 step 5). Bin must be Out for filling.
router.post('/:barcode/photo', (req, res) => {
  const bin = getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });
  if (bin.status !== STATUS.OUT_FOR_FILLING) {
    return res
      .status(409)
      .json({ error: `Photo can only be added while a bin is "${STATUS.OUT_FOR_FILLING}"` });
  }

  const photoRef = (req.body && req.body.photoRef) || `photo_${bin.barcode}_${Date.now()}`;
  setBinFields(bin.id, { photo_ref: photoRef });

  // Ensure a collect_full job exists for this booking and includes this bin.
  const job = ensureCollectFullJob(bin.booking_id, bin.id);

  res.json({ bin: getBin(bin.id), job });
});

// POST /api/bins/:barcode/store — two-scan put-away. Body: { locationBarcode }.
router.post('/:barcode/store', (req, res) => {
  const bin = getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const { locationBarcode } = req.body || {};
  if (!locationBarcode) {
    return res.status(400).json({ error: 'locationBarcode is required' });
  }
  const location = getLocationByBarcode(locationBarcode);
  if (!location) return res.status(404).json({ error: 'Location not found' });
  if (location.occupied) {
    return res.status(409).json({ error: `Location ${locationBarcode} is occupied` });
  }

  try {
    const updated = transitionBin(bin.id, STATUS.STORED, {
      actor: 'admin',
      locationId: location.id,
    });
    res.json({ bin: updated, location: getLocation(location.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:barcode/scan-out — pull from rack → In transit (outbound).
router.post('/:barcode/scan-out', (req, res) => {
  const bin = getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const freedLocationId = bin.location_id;
  try {
    const updated = transitionBin(bin.id, STATUS.IN_TRANSIT_OUTBOUND, { actor: 'admin' });
    res.json({ bin: updated, freedLocation: freedLocationId ? getLocation(freedLocationId) : null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:id/request-return — customer retrieval request (+deliver_back job).
// Accepts a bin id or barcode. Body: { deliveryBackDate }.
router.post('/:id/request-return', (req, res) => {
  const bin = getBin(req.params.id) || getBinByBarcode(req.params.id);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const { deliveryBackDate } = req.body || {};
  if (!deliveryBackDate) {
    return res.status(400).json({ error: 'deliveryBackDate is required' });
  }

  try {
    const updated = transitionBin(bin.id, STATUS.RETRIEVAL_REQUESTED, { actor: 'customer' });
    const job = createJob({
      bookingId: bin.booking_id,
      type: 'deliver_back',
      scheduledDate: deliveryBackDate,
      binIds: [bin.id],
    });
    res.json({ bin: updated, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:id/request-restore — a Returned-to-customer bin the customer
// wants stored again. It's already filled, so it does NOT go back through
// "Out for filling": we schedule a collect_full job, and marking that Done
// moves the bin Returned to customer → In transit (inbound) (re-store loop,
// spec §3.1 / §4 tail). The warehouse then scans it back to Stored.
router.post('/:id/request-restore', (req, res) => {
  const bin = getBin(req.params.id) || getBinByBarcode(req.params.id);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });
  if (bin.status !== STATUS.RETURNED_TO_CUSTOMER) {
    return res
      .status(409)
      .json({ error: `Only a "${STATUS.RETURNED_TO_CUSTOMER}" bin can be re-stored` });
  }

  const { collectionDate } = req.body || {};
  const job = createJob({
    bookingId: bin.booking_id,
    type: 'collect_full',
    scheduledDate: collectionDate || null,
    binIds: [bin.id],
  });
  res.json({ bin, job });
});

// POST /api/bins/:id/close — lifecycle complete: Returned to customer → Returned / closed.
router.post('/:id/close', (req, res) => {
  const bin = getBin(req.params.id) || getBinByBarcode(req.params.id);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  try {
    const updated = transitionBin(bin.id, STATUS.RETURNED_CLOSED, { actor: 'admin' });
    res.json({ bin: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/bins/:barcode/movements — chain of custody.
router.get('/:barcode/movements', (req, res) => {
  const bin = getBinByBarcode(req.params.barcode) || getBin(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const movements = listMovementsForBin(bin.id).map((m) => ({
    ...m,
    location: m.location_id ? getLocation(m.location_id) : null,
  }));
  res.json({ bin, movements });
});

// --- helpers -----------------------------------------------------------------

function ensureCollectFullJob(bookingId, binId) {
  let job = listJobs().find(
    (j) => j.booking_id === bookingId && j.type === 'collect_full' && j.status === 'Scheduled'
  );

  const booking = getBooking(bookingId);
  if (!job) {
    job = createJob({
      bookingId,
      type: 'collect_full',
      scheduledDate: booking ? booking.delivery_date : null,
      binIds: [binId],
    });
    return job;
  }

  const existing = safeParse(job.bin_ids) || [];
  if (!existing.includes(binId)) {
    setJobBinIds(job.id, [...existing, binId]);
  }
  return listJobs().find((j) => j.id === job.id);
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default router;
