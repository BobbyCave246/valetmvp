// Dashboard stats — read-only aggregates for the admin stats bar.

import { Router } from 'express';
import {
  countBins,
  countBinsByStatus,
  listLocations,
  listBookings,
  listJobs,
} from '../db.js';

const router = Router();

// GET /api/stats — counts for the admin dashboard.
router.get('/', (_req, res) => {
  const byStatus = countBinsByStatus();
  const locations = listLocations();
  const occupied = locations.filter((l) => l.occupied).length;
  const total = locations.length;
  const jobs = listJobs();

  res.json({
    bins: {
      total: countBins(),
      unassigned: byStatus.unassigned || 0,
      byStatus,
    },
    locations: {
      total,
      occupied,
      free: total - occupied,
      occupancyPct: total ? Math.round((occupied / total) * 100) : 0,
    },
    bookings: { total: listBookings().length },
    jobs: {
      scheduled: jobs.filter((j) => j.status !== 'Done').length,
      done: jobs.filter((j) => j.status === 'Done').length,
    },
  });
});

export default router;
