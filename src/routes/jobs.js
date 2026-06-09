// Jobs board routes. Marking a job Done advances its bins to the next status
// via the transition module (which logs movements).

import { Router } from 'express';
import { listJobs, getJob, getBooking, setJobStatus } from '../db.js';
import { transitionBin, JOB_DONE_TARGET } from '../transitions.js';

const router = Router();

// GET /api/jobs — jobs board.
router.get('/', (_req, res) => {
  const jobs = listJobs().map((j) => {
    const booking = getBooking(j.booking_id);
    return {
      ...j,
      bin_ids: safeParse(j.bin_ids) || [],
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
