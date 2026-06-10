// Jobs board routes. Marking a job Done advances its bins to the next status
// via the transition module (which logs movements).

import { Router } from 'express';
import { listJobs, getJob, getBooking, getCustomer, setJobStatus, getBin } from '../db.js';
import { transitionBin, isLegalTransition, JOB_DONE_TARGET } from '../transitions.js';
import { safeParse } from '../util.js';

const router = Router();

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

// POST /api/jobs/:id/done — mark Done and advance its bins.
router.post('/:id/done', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'Done') {
    return res.status(409).json({ error: 'Job is already Done' });
  }

  const target = JOB_DONE_TARGET[job.type];
  if (!target) {
    return res.status(400).json({ error: `Unknown job type: ${job.type}` });
  }

  const binIds = safeParse(job.bin_ids) || [];
  if (binIds.length === 0) {
    return res.status(409).json({
      error: 'Job has no bins assigned yet — assign bins before marking done',
    });
  }

  try {
    // Pre-validate EVERY bin before advancing ANY, so a mid-loop failure can't
    // leave some bins advanced with the job still Scheduled (an unrecoverable
    // wedge — retries would fail on the already-advanced bins).
    const bins = await Promise.all(binIds.map((id) => getBin(id)));
    for (const bin of bins) {
      if (!bin) {
        return res.status(409).json({ error: 'Job references a bin that no longer exists' });
      }
      if (!isLegalTransition(bin.status, target)) {
        return res.status(409).json({
          error: `Bin ${bin.barcode} is "${bin.status ?? 'unassigned'}" and cannot move to "${target}" — job out of sync`,
        });
      }
    }

    const advanced = [];
    for (const binId of binIds) {
      advanced.push(await transitionBin(binId, target, { actor: 'admin', jobId: job.id }));
    }
    await setJobStatus(job.id, 'Done');
    res.json({ job: await getJob(job.id), advanced });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
