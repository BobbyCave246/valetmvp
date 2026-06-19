// Admin reports — snapshot + date-range activity aggregates.

import { Router } from 'express';
import {
  countBins,
  countBinsByStatus,
  countBinsBySku,
  countLeads,
  countBookingsInRange,
  countJobsCompletedByTypeInRange,
  countMovementsByTransitionInRange,
  listLocations,
  listBookings,
  listJobs,
} from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();

function parseDateParam(value, fallback) {
  if (!value) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : fallback;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function rangeBounds(from, to) {
  const fromTs = `${from}T00:00:00.000Z`;
  const end = new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const toTs = end.toISOString();
  return { fromTs, toTs };
}

async function buildSnapshot() {
  const [byStatus, bySku, locations, jobs, bookings, total, leadsTotal] = await Promise.all([
    countBinsByStatus(),
    countBinsBySku(),
    listLocations(),
    listJobs(),
    listBookings(),
    countBins(),
    countLeads(),
  ]);
  const occupied = locations.filter((l) => l.occupied).length;
  const slots = locations.length;

  return {
    bins: { total, unassigned: byStatus.unassigned || 0, byStatus, bySku },
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
    leads: { total: leadsTotal },
  };
}

// GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/summary', requireAuth, requireRole('admin'), async (req, res) => {
  const defaults = defaultRange();
  const from = parseDateParam(req.query.from, defaults.from);
  const to = parseDateParam(req.query.to, defaults.to);
  if (from > to) {
    return res.status(400).json({ error: 'from must be on or before to' });
  }

  const { fromTs, toTs } = rangeBounds(from, to);
  const [snapshot, jobsCompleted, transitions, bookingsCreated] = await Promise.all([
    buildSnapshot(),
    countJobsCompletedByTypeInRange(from, to),
    countMovementsByTransitionInRange(fromTs, toTs),
    countBookingsInRange(fromTs, toTs),
  ]);

  res.json({
    range: { from, to },
    snapshot,
    activity: {
      jobsCompleted,
      transitions,
      bookingsCreated,
    },
  });
});

export default router;
