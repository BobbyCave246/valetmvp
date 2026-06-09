// Bin routes: photo stub, warehouse put-away/scan-out, retrieval request,
// chain-of-custody history, plus lookup helpers for the UIs.

import { Router } from 'express';
import {
  getBin,
  getBinByBarcode,
  setBinFields,
  listAvailableBins,
  getLocationByBarcode,
  getLocation,
  createJob,
  listMovementsForBin,
} from '../db.js';
import { transitionBin, STATUS } from '../transitions.js';
import { validateFutureDate } from '../slots.js';

const router = Router();

// GET /api/bins/available — unassigned bins for the assign-bins screen.
router.get('/available', async (_req, res) => {
  res.json(await listAvailableBins());
});

// POST /api/bins/:barcode/photo — attach an optional contents photo. Bin must
// be Out for filling. (Collection is booked separately — see
// POST /api/bookings/:id/book-collection — so the photo is purely optional.)
router.post('/:barcode/photo', async (req, res) => {
  const bin = await getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });
  if (bin.status !== STATUS.OUT_FOR_FILLING) {
    return res
      .status(409)
      .json({ error: `Photo can only be added while a bin is "${STATUS.OUT_FOR_FILLING}"` });
  }

  try {
    const photoRef = (req.body && req.body.photoRef) || `photo_${bin.barcode}_${Date.now()}`;
    await setBinFields(bin.id, { photo_ref: photoRef });
    res.json({ bin: await getBin(bin.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:barcode/store — two-scan put-away. Body: { locationBarcode }.
router.post('/:barcode/store', async (req, res) => {
  const bin = await getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const { locationBarcode } = req.body || {};
  if (!locationBarcode) {
    return res.status(400).json({ error: 'locationBarcode is required' });
  }
  const location = await getLocationByBarcode(locationBarcode);
  if (!location) return res.status(404).json({ error: 'Location not found' });
  if (location.occupied) {
    return res.status(409).json({ error: `Location ${locationBarcode} is occupied` });
  }

  try {
    const updated = await transitionBin(bin.id, STATUS.STORED, {
      actor: 'admin',
      locationId: location.id,
    });
    res.json({ bin: updated, location: await getLocation(location.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:barcode/scan-out — pull from rack → In transit (outbound).
router.post('/:barcode/scan-out', async (req, res) => {
  const bin = await getBinByBarcode(req.params.barcode);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const freedLocationId = bin.location_id;
  try {
    const updated = await transitionBin(bin.id, STATUS.IN_TRANSIT_OUTBOUND, { actor: 'admin' });
    res.json({ bin: updated, freedLocation: freedLocationId ? await getLocation(freedLocationId) : null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:id/request-return — customer retrieval request (+deliver_back job).
// Accepts a bin id or barcode. Body: { deliveryBackDate }.
router.post('/:id/request-return', async (req, res) => {
  const bin = (await getBin(req.params.id)) || (await getBinByBarcode(req.params.id));
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const { deliveryBackDate } = req.body || {};
  const dateErr = validateFutureDate(deliveryBackDate);
  if (dateErr) return res.status(400).json({ error: dateErr });

  try {
    const updated = await transitionBin(bin.id, STATUS.RETRIEVAL_REQUESTED, { actor: 'customer' });
    const job = await createJob({
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
router.post('/:id/request-restore', async (req, res) => {
  const bin = (await getBin(req.params.id)) || (await getBinByBarcode(req.params.id));
  if (!bin) return res.status(404).json({ error: 'Bin not found' });
  if (bin.status !== STATUS.RETURNED_TO_CUSTOMER) {
    return res
      .status(409)
      .json({ error: `Only a "${STATUS.RETURNED_TO_CUSTOMER}" bin can be re-stored` });
  }

  const { collectionDate } = req.body || {};
  // Required: a null-dated job would land on the board with no dispatch date.
  const dateErr = validateFutureDate(collectionDate);
  if (dateErr) return res.status(400).json({ error: dateErr });

  try {
    const job = await createJob({
      bookingId: bin.booking_id,
      type: 'collect_full',
      scheduledDate: collectionDate,
      binIds: [bin.id],
    });
    res.json({ bin, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/bins/:id/close — lifecycle complete: Returned to customer → Returned / closed.
router.post('/:id/close', async (req, res) => {
  const bin = (await getBin(req.params.id)) || (await getBinByBarcode(req.params.id));
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  try {
    const updated = await transitionBin(bin.id, STATUS.RETURNED_CLOSED, { actor: 'admin' });
    res.json({ bin: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/bins/:barcode/movements — chain of custody.
router.get('/:barcode/movements', async (req, res) => {
  const bin = (await getBinByBarcode(req.params.barcode)) || (await getBin(req.params.barcode));
  if (!bin) return res.status(404).json({ error: 'Bin not found' });

  const rows = await listMovementsForBin(bin.id);
  const movements = await Promise.all(
    rows.map(async (m) => ({
      ...m,
      location: m.location_id ? await getLocation(m.location_id) : null,
    }))
  );
  res.json({ bin, movements });
});

export default router;
