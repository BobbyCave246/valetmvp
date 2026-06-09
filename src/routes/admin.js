// Admin utility routes — the demo reset (spec §7).

import { Router } from 'express';
import { seed } from '../seed.js';

const router = Router();

// POST /api/admin/reset — wipe + re-seed for a clean demo re-run.
router.post('/reset', async (_req, res) => {
  try {
    const result = await seed();
    res.json({ ok: true, seeded: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
