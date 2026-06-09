// Builds and exports the Express app (no app.listen here). Both the local
// server (src/server.js) and the Vercel serverless entry (api/index.js) import
// this, so the two run the exact same app.
//
// The frontend never touches the DB — everything flows through these routes
// and, for any status change, through the transition module (spec §1, §6).

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import bookingsRouter from './routes/bookings.js';
import jobsRouter from './routes/jobs.js';
import binsRouter from './routes/bins.js';
import locationsRouter from './routes/locations.js';
import adminRouter from './routes/admin.js';
import statsRouter from './routes/stats.js';
import intakeRouter from './routes/intake.js';
import { ensureSchema } from './db.js';
import { seedIfEmpty } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// One-time async init: create the schema (idempotent) and seed if empty. Runs
// once per process (e.g. per Vercel cold start). Every /api request awaits it
// below, so the DB is guaranteed ready before any query runs.
const dbReady = ensureSchema().then(() => seedIfEmpty());

const app = express();
// Raised from the ~100kb default so contents-photo data URLs fit (the client
// downscales to a small thumbnail, so payloads stay well under this).
app.use(express.json({ limit: '5mb' }));

// Gate API requests on the DB being ready.
app.use('/api', async (_req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});

// --- API ---------------------------------------------------------------------
app.use('/api/bookings', bookingsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/bins', binsRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/stats', statsRouter);
app.use('/api', intakeRouter); // /serviceability, /availability, /leads

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Static frontends --------------------------------------------------------
// On Vercel the files under public/ are also served directly by the CDN; this
// middleware makes local dev (and the serverless fallback) behave identically.
const publicDir = join(__dirname, '..', 'public');
app.use('/booking', express.static(join(publicDir, 'booking')));
app.use('/admin', express.static(join(publicDir, 'admin')));
app.use('/shared', express.static(join(publicDir, 'shared')));

// Root → landing page of the public booking site.
app.get('/', (_req, res) => res.redirect('/booking/'));

// --- Error fallback ----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

export default app;
