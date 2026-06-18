// Admin utility routes — the demo reset (spec §7).

import { Router } from 'express';
import { COVERAGE_AREAS, VILLAGES } from '../coverage.js';
import { SLOTS, LEAD_DAYS, SLOT_CAPACITY } from '../slots.js';
import { seed } from '../seed.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();

// GET /api/admin/config — read-only operational config for the admin console.
router.get('/config', requireAuth, requireRole('admin'), (_req, res) => {
  res.json({
    coverageAreas: COVERAGE_AREAS,
    villages: VILLAGES,
    slots: SLOTS,
    leadDays: LEAD_DAYS,
    slotCapacity: SLOT_CAPACITY,
  });
});

// POST /api/admin/reset — wipe + re-seed for a clean demo re-run. Admin only.
router.post('/reset', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    const result = await seed();
    res.json({ ok: true, seeded: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
