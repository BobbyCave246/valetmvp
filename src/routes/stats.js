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
router.get('/', async (_req, res) => {
  const [byStatus, locations, jobs, bookings, total] = await Promise.all([
    countBinsByStatus(),
    listLocations(),
    listJobs(),
    listBookings(),
    countBins(),
  ]);
  const occupied = locations.filter((l) => l.occupied).length;
  const slots = locations.length;

  res.json({
    bins: {
      total,
      unassigned: byStatus.unassigned || 0,
      byStatus,
    },
    locations: {
      total: slots,
      occupied,
      free: slots - occupied,
      occupancyPct: slots ? Math.round((occupied / slots) * 100) : 0,
    },
    bookings: { total: bookings.length },
    jobs: {
      scheduled: jobs.filter((j) => j.status !== 'Done').length,
      done: jobs.filter((j) => j.status === 'Done').length,
    },
  });
});

export default router;
