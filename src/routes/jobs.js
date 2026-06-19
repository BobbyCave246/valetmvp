// Jobs board routes. Marking a job Done advances its bins to the next status
// via the job lifecycle module (which calls transitions.js for each bin).

import { Router } from 'express';
import { listJobs, getJob, getBooking, getCustomer, getBin } from '../db.js';
import { completeJob } from '../jobs-lifecycle.js';
import { safeParse } from '../util.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();

// The jobs board is the driver's workspace (admin can see it too).
router.use(requireAuth, requireRole('driver', 'admin'));

// GET /api/jobs — jobs board. Each job resolves its bin_ids to {barcode,
// sku_type, status} so the board can show a concrete pick list, plus the
// booking's customer so the driver app can show who/where without extra calls.
router.get('/', async (_req, res) => {
  const rows = await listJobs();
  const jobs = await Promise.all(
    rows.map(async (j) => {
      const binIds = safeParse(j.bin_ids) || [];
      const [booking, binRows] = await Promise.all([
        getBooking(j.booking_id),
        Promise.all(binIds.map((id) => getBin(id))),
      ]);
      const bins = binRows
        .filter(Boolean)
        .map((b) => ({ barcode: b.barcode, sku_type: b.sku_type, status: b.status }));
      let customer = null;
      if (booking?.customer_id) {
        const c = await getCustomer(booking.customer_id);
        if (c) customer = { name: c.name, phone: c.phone, address: c.address, postcode: c.postcode };
      }
      return { ...j, bin_ids: binIds, bins, booking: booking ? { ...booking, customer } : booking };
    })
  );
  res.json(jobs);
});

// POST /api/jobs/:id/done — mark Done and advance its bins (all-or-nothing).
router.post('/:id/done', async (req, res) => {
  try {
    const result = await completeJob(req.params.id, { actor: 'admin' });
    res.json({ job: await getJob(req.params.id), advanced: result.advanced });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
