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
import reportsRouter from './routes/reports.js';
import intakeRouter from './routes/intake.js';
import authRouter from './routes/auth.js';
import { ensureSchema, pingDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { seedStarterUsers } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// One-time async init: create the schema (idempotent), seed demo data if empty,
// and seed starter staff accounts. seedStarterUsers is its OWN step (not gated
// on the bin count like seedIfEmpty, and never wiped by the demo reset), so
// staff exist even on a DB that already has bins. Runs once per process (e.g.
// per Vercel cold start). Every /api request awaits it before any query runs.
const dbReady = ensureSchema()
  .then(() => seedIfEmpty())
  .then(() => seedStarterUsers());
// Attach a no-op rejection handler so an init failure (e.g. DB unreachable at
// startup) doesn't surface as an unhandledRejection before the first /api
// request awaits it. The /api gate still awaits `dbReady` and re-throws.
dbReady.catch(() => {});

const app = express();
// Behind Vercel's proxy — trust X-Forwarded-* so req.ip and protocol are right.
app.set('trust proxy', true);
// Raised from the ~100kb default so contents-photo data URLs fit (the client
// downscales to a small thumbnail, so payloads stay well under this).
app.use(express.json({ limit: '5mb' }));

// Concise request logging: one line per request on completion. Method, path,
// status and duration only — never bodies (they can carry passwords / PII).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Health probe — defined BEFORE the readiness gate so it reports true status
// (including DB reachability) instead of hanging or 500-ing when the DB is down.
app.get('/api/health', async (_req, res) => {
  try {
    await pingDb();
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// Gate the rest of the API on one-time init (schema + seed) being ready.
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
app.use('/api/reports', reportsRouter);
app.use('/api/auth', authRouter);
app.use('/api', intakeRouter); // /serviceability, /availability, /leads

// --- Static frontends --------------------------------------------------------
// On Vercel the files under public/ are also served directly by the CDN; this
// middleware makes local dev (and the serverless fallback) behave identically.
const publicDir = join(__dirname, '..', 'public');
app.use('/booking', express.static(join(publicDir, 'booking')));
app.use('/admin', express.static(join(publicDir, 'admin')));
app.use('/driver', express.static(join(publicDir, 'driver')));
app.use('/warehouse', express.static(join(publicDir, 'warehouse')));
app.use('/login', express.static(join(publicDir, 'login')));
app.use('/guide', express.static(join(publicDir, 'guide')));
app.use('/shared', express.static(join(publicDir, 'shared')));
app.use('/vendor', express.static(join(publicDir, 'vendor')));

// Root → landing page of the public booking site.
app.get('/', (_req, res) => res.redirect('/booking/'));

// The old all-roles launcher is gone — staff sign in instead.
app.get('/start', (_req, res) => res.redirect('/login/'));
app.get('/start/', (_req, res) => res.redirect('/login/'));

// --- Error fallback ----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

export default app;
