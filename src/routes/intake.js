// Booking intake helpers: serviceability (coverage areas), delivery-window
// availability, and out-of-area lead capture. Mounted at /api.

import { Router } from 'express';
import { listAreas } from '../coverage.js';
import { availabilityForDate, validateDateSlot } from '../slots.js';
import { createLead } from '../db.js';

const router = Router();

// GET /api/serviceability — the service areas (populates the booking dropdown).
router.get('/serviceability', (_req, res) => {
  res.json({ areas: listAreas() });
});

// GET /api/availability?date=YYYY-MM-DD — per-window remaining capacity.
router.get('/availability', async (req, res) => {
  const date = req.query.date;
  // 'am' is a known-valid slot, so this only surfaces date problems.
  const bad = validateDateSlot(date, 'am');
  if (bad) return res.status(400).json({ error: bad });
  res.json({ date, slots: await availabilityForDate(date) });
});

// POST /api/leads { email, area } — out-of-area waitlist capture.
router.post('/leads', async (req, res) => {
  const { email, area } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  try {
    const lead = await createLead({ email, area });
    res.status(201).json({ ok: true, lead });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
