// Admin utility routes — the demo reset (spec §7).

import { Router } from 'express';
import { seed } from '../seed.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();

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
