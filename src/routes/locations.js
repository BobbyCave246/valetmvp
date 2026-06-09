// Location routes — used by the warehouse scan screen's free-slot chips.

import { Router } from 'express';
import { listFreeLocations, listLocations } from '../db.js';

const router = Router();

// GET /api/locations/free — free rack slots.
router.get('/free', async (_req, res) => {
  res.json(await listFreeLocations());
});

// GET /api/locations — all slots with their occupant (for the rack map).
router.get('/', async (_req, res) => {
  res.json(await listLocations());
});

export default router;
