// Location routes — used by the warehouse scan screen's free-slot chips.

import { Router } from 'express';
import { listFreeLocations } from '../db.js';

const router = Router();

// GET /api/locations/free — free rack slots.
router.get('/free', (_req, res) => {
  res.json(listFreeLocations());
});

export default router;
