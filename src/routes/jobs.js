// Jobs board routes. Marking a job Done advances its bins to the next status
// via the transition module (which logs movements).

import { Router } from 'express';
import { listJobs, getJob, getBooking, setJobStatus, getBin } from '../db.js';
import { transitionBin, JOB_DONE_TARGET } from '../transitions.js';

const router = Router();

// GET /api/jobs — jobs board. Each job resolves its bin_ids to {barcode,
// sku_type, status} so the board can show a concrete pick list.
router.get('/', (_req, res) => {
  const jobs = listJobs().map((j) => {
    const booking = getBooking(j.booking_id);
    const binIds = safeParse(j.bin_ids) || [];
    const bins = binIds
      .map((id) => getBin(id))
      .filter(Boolean)
      .map((b) => ({ barcode: b.barcode, sku_type: b.sku_type, status: b.status }));
    return {
      ...j,
      bin_ids: binIds,
      bins,
      booking,
    };
  });
  res.json(jobs);
});

// POST /api/jobs/:id/done — mark Done and advance its bins.
router.post('/:id/done', (req, res) => {
  const job = getJob(req.params.id);
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
    const advanced = binIds.map((binId) =>
      transitionBin(binId, target, { actor: 'admin', jobId: job.id })
    );
    setJobStatus(job.id, 'Done');
    res.json({ job: getJob(job.id), advanced });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default router;
