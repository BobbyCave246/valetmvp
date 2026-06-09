// Admin utility routes — the demo reset (spec §7).

import { Router } from 'express';
import { seed } from '../seed.js';

const router = Router();

// POST /api/admin/reset — wipe + re-seed for a clean demo re-run.
router.post('/reset', (_req, res) => {
  const result = seed();
  res.json({ ok: true, seeded: result });
});

export default router;
