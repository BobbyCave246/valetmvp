// Location routes — used by the warehouse scan screen's free-slot chips.

import { Router } from 'express';
import { listFreeLocations, listLocations } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();

// Rack data is warehouse/admin only (stats.js reads locations in-process, not
// via this HTTP route, so the admin dashboard is unaffected).
router.use(requireAuth, requireRole('warehouse', 'admin'));

// GET /api/locations/free — free rack slots.
router.get('/free', async (_req, res) => {
  res.json(await listFreeLocations());
});

// GET /api/locations — all slots with their occupant (for the rack map).
router.get('/', async (_req, res) => {
  res.json(await listLocations());
});

export default router;
