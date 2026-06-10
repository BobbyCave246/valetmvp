// Admin utility routes — the demo reset (spec §7).

import { Router } from 'express';
import { seed } from '../seed.js';

const router = Router();

// If ADMIN_TOKEN is set, destructive admin actions require
// `Authorization: Bearer <token>`. Unset = open (demo default).
export function requireAdminToken(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next();
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (supplied !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/admin/reset — wipe + re-seed for a clean demo re-run.
router.post('/reset', requireAdminToken, async (_req, res) => {
  try {
    const result = await seed();
    res.json({ ok: true, seeded: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
