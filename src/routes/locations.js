// Location routes — used by the warehouse scan screen's free-slot chips.

import { Router } from 'express';
import { listFreeLocations, listLocations } from '../db.js';

const router = Router();

// GET /api/locations/free — free rack slots.
router.get('/free', (_req, res) => {
  res.json(listFreeLocations());
});

// GET /api/locations — all slots with their occupant (for the rack map).
router.get('/', (_req, res) => {
  res.json(listLocations());
});

export default router;
