// Data-access module — the ONLY file that knows about the database driver.
// Everything else goes through these (now async) helpers. Backed by Postgres
// (Supabase) via postgres.js. All functions return promises.

import 'dotenv/config';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Point it at your Supabase Postgres connection ' +
      '(Project → Settings → Database → Connection string → Transaction pooler). ' +
      'Set it in .env locally and as an env var on Vercel.'
  );
}

// Local Postgres needs no TLS; Supabase requires it. prepare:false keeps us
// compatible with Supabase's transaction pooler (pgbouncer).
const isLocal = /\/\/[^@]*@?(localhost|127\.0\.0\.1)[:/]/.test(url) || /(\b|_)host=localhost/.test(url);
export const sql = postgres(url, {
  max: Number(process.env.PGMAX || 5),
  prepare: false,
  idle_timeout: 20,
  ssl: isLocal ? false : 'require',
  // Quiet the "relation already exists, skipping" notices from idempotent DDL.
  onnotice: () => {},
});

// ----- small helpers ---------------------------------------------------------

export function nowISO() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

// Schema DDL — idempotent. Tables are created in dependency order so the
// foreign keys resolve (a referencing table comes after the tables it points
// at). TEXT ids + ISO-string timestamps, matching the original SQLite design.
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS customers (
  id                 TEXT PRIMARY KEY,
  sitelink_tenant_id TEXT UNIQUE,
  name               TEXT,
  phone              TEXT,
  email              TEXT,
  address            TEXT,
  created_at         TEXT
);
CREATE TABLE IF NOT EXISTS locations (
  id        TEXT PRIMARY KEY,
  barcode   TEXT UNIQUE NOT NULL,
  occupied  INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT REFERENCES customers(id),
  bin_count      INTEGER,
  sku_breakdown  TEXT,
  status         TEXT,  -- display-only / dead: always 'New'; real state is derived from bins
  delivery_date  TEXT,
  created_at     TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT REFERENCES bookings(id),
  type            TEXT,
  status          TEXT,
  scheduled_date  TEXT,
  bin_ids         TEXT
);
CREATE TABLE IF NOT EXISTS bins (
  id           TEXT PRIMARY KEY,
  barcode      TEXT UNIQUE NOT NULL,
  sku_type     TEXT,
  status       TEXT,
  customer_id  TEXT REFERENCES customers(id),
  booking_id   TEXT REFERENCES bookings(id),
  location_id  TEXT REFERENCES locations(id),
  photo_ref    TEXT
);
CREATE TABLE IF NOT EXISTS movements (
  id           TEXT PRIMARY KEY,
  bin_id       TEXT REFERENCES bins(id),
  from_status  TEXT,
  to_status    TEXT,
  location_id  TEXT REFERENCES locations(id),
  actor        TEXT,
  job_id       TEXT REFERENCES jobs(id),
  ts           TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  area        TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,  -- stored lowercased
  password_hash  TEXT NOT NULL,         -- format: scrypt$<saltB64>$<hashB64>
  role           TEXT NOT NULL,         -- 'admin' | 'warehouse' | 'driver'
  name           TEXT,
  created_at     TEXT
);

-- Additive migrations (idempotent) for booking time-windows + serviceability.
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS delivery_slot  TEXT;
ALTER TABLE jobs      ADD COLUMN IF NOT EXISTS scheduled_slot TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postcode       TEXT;

-- Data-integrity constraints. Added idempotently and defensively: a constraint
-- that already exists is silently skipped, and a constraint that pre-existing
-- rows would violate degrades to a logged WARNING rather than crashing startup.
DO $$ BEGIN
  ALTER TABLE bins ADD CONSTRAINT bins_sku_type_chk
    CHECK (sku_type IS NULL OR sku_type IN ('bin','wardrobe','odd'));
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE WARNING 'skipped bins_sku_type_chk: %', SQLERRM;
END $$;
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_bin_count_chk
    CHECK (bin_count IS NULL OR bin_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE WARNING 'skipped bookings_bin_count_chk: %', SQLERRM;
END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_chk
    CHECK (role IN ('admin','warehouse','driver'));
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE WARNING 'skipped users_role_chk: %', SQLERRM;
END $$;
DO $$ BEGIN
  ALTER TABLE locations ADD CONSTRAINT locations_occupied_chk
    CHECK (occupied IN (0,1));
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE WARNING 'skipped locations_occupied_chk: %', SQLERRM;
END $$;
-- At most one bin may occupy a given rack location: a DB-level backstop for the
-- app's row-locked occupancy check in transitions.js.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS bins_one_per_location
    ON bins (location_id) WHERE location_id IS NOT NULL;
EXCEPTION WHEN others THEN RAISE WARNING 'skipped bins_one_per_location: %', SQLERRM;
END $$;
`;

// Run once on startup (idempotent). app.js awaits this before serving.
export async function ensureSchema() {
  await sql.unsafe(SCHEMA_DDL);
}

// Lightweight liveness probe for the health endpoint — confirms the pool can
// actually reach Postgres (a cheap round-trip), not just that the app booted.
export async function pingDb() {
  await sql`SELECT 1`;
}

// ----- customers -------------------------------------------------------------

export async function createCustomer({
  name = null,
  phone = null,
  email = null,
  address = null,
  postcode = null,
  sitelinkTenantId = null,
}) {
  const id = newId('cust');
  const rows = await sql`
    INSERT INTO customers (id, sitelink_tenant_id, name, phone, email, address, postcode, created_at)
    VALUES (${id}, ${sitelinkTenantId}, ${name}, ${phone}, ${email}, ${address}, ${postcode}, ${nowISO()})
    RETURNING *`;
  return rows[0];
}

export async function getCustomer(id) {
  const rows = await sql`SELECT * FROM customers WHERE id = ${id}`;
  return rows[0];
}

export async function findCustomerByPhone(phone) {
  const rows = await sql`SELECT * FROM customers WHERE phone = ${phone}`;
  return rows[0];
}

// ----- users (staff accounts) ------------------------------------------------

export async function createUser({ email, passwordHash, role, name = null }) {
  const rows = await sql`
    INSERT INTO users (id, email, password_hash, role, name, created_at)
    VALUES (${newId('user')}, ${email.toLowerCase()}, ${passwordHash}, ${role}, ${name}, ${nowISO()})
    RETURNING id, email, role, name, created_at`;
  return rows[0];
}

export async function getUserByEmail(email) {
  const rows = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
  return rows[0];
}

export async function getUserById(id) {
  const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
  return rows[0];
}

// Never selects password_hash — safe to return to the admin staff list.
export async function listUsers() {
  return sql`SELECT id, email, role, name, created_at FROM users ORDER BY created_at`;
}

// ----- bins ------------------------------------------------------------------

export async function getBin(id, client = sql) {
  const rows = await client`SELECT * FROM bins WHERE id = ${id}`;
  return rows[0];
}

// Row-locked read for use inside a transaction: serialises concurrent
// transitions on the same bin so the legality check can't act on a stale row.
export async function getBinForUpdate(id, client) {
  const rows = await client`SELECT * FROM bins WHERE id = ${id} FOR UPDATE`;
  return rows[0];
}

export async function getBinByBarcode(barcode) {
  const rows = await sql`SELECT * FROM bins WHERE barcode = ${barcode}`;
  return rows[0];
}

// Register a brand-new physical bin into the pool (status NULL = available
// for assignment). Barcode uniqueness is enforced by the UNIQUE constraint.
export async function createBin({ barcode, skuType }) {
  const rows = await sql`
    INSERT INTO bins (id, barcode, sku_type, status, customer_id, booking_id, location_id, photo_ref)
    VALUES (${newId('bin')}, ${barcode}, ${skuType}, NULL, NULL, NULL, NULL, NULL)
    RETURNING *`;
  return rows[0];
}

export async function listAvailableBins() {
  // Free inventory: never-used bins (status NULL) plus closed bins released
  // back to the pool after a completed lifecycle.
  return sql`
    SELECT * FROM bins
    WHERE booking_id IS NULL AND (status IS NULL OR status = 'Returned / closed')
    ORDER BY barcode`;
}

export async function listBinsForBooking(bookingId, client = sql) {
  return client`SELECT * FROM bins WHERE booking_id = ${bookingId} ORDER BY barcode`;
}

export async function setBinFields(id, fields, client = sql) {
  if (Object.keys(fields).length === 0) return;
  await client`UPDATE bins SET ${client(fields)} WHERE id = ${id}`;
}

// ----- locations -------------------------------------------------------------

export async function getLocation(id, client = sql) {
  const rows = await client`SELECT * FROM locations WHERE id = ${id}`;
  return rows[0];
}

// Row-locked read (inside a transaction) so two put-aways can't both claim a slot.
export async function getLocationForUpdate(id, client) {
  const rows = await client`SELECT * FROM locations WHERE id = ${id} FOR UPDATE`;
  return rows[0];
}

export async function getLocationByBarcode(barcode) {
  const rows = await sql`SELECT * FROM locations WHERE barcode = ${barcode}`;
  return rows[0];
}

export async function listFreeLocations() {
  return sql`SELECT * FROM locations WHERE occupied = 0 ORDER BY barcode`;
}

// All slots with their current occupant's barcode (null if free).
export async function listLocations() {
  return sql`
    SELECT l.*, b.barcode AS bin_barcode
    FROM locations l
    LEFT JOIN bins b ON b.location_id = l.id
    ORDER BY l.barcode`;
}

export async function setLocationOccupied(id, occupied, client = sql) {
  await client`UPDATE locations SET occupied = ${occupied ? 1 : 0} WHERE id = ${id}`;
}

// ----- bookings --------------------------------------------------------------

export async function createBooking({
  customerId = null,
  binCount = null,
  skuBreakdown,
  deliveryDate = null,
  deliverySlot = null,
}) {
  const id = newId('book');
  const rows = await sql`
    INSERT INTO bookings (id, customer_id, bin_count, sku_breakdown, status, delivery_date, delivery_slot, created_at)
    VALUES (${id}, ${customerId}, ${binCount}, ${JSON.stringify(skuBreakdown || {})}, ${'New'}, ${deliveryDate}, ${deliverySlot}, ${nowISO()})
    RETURNING *`;
  return rows[0];
}

export async function getBooking(id) {
  const rows = await sql`SELECT * FROM bookings WHERE id = ${id}`;
  return rows[0];
}

export async function listBookings() {
  return sql`SELECT * FROM bookings ORDER BY created_at DESC`;
}

export async function findBookingByPhone(phone) {
  return sql`
    SELECT b.* FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE c.phone = ${phone}
    ORDER BY b.created_at DESC`;
}

// ----- jobs ------------------------------------------------------------------

export async function createJob(
  {
    bookingId = null,
    type = null,
    scheduledDate = null,
    scheduledSlot = null,
    binIds = [],
  },
  client = sql
) {
  const id = newId('job');
  const rows = await client`
    INSERT INTO jobs (id, booking_id, type, status, scheduled_date, scheduled_slot, bin_ids)
    VALUES (${id}, ${bookingId}, ${type}, ${'Scheduled'}, ${scheduledDate}, ${scheduledSlot}, ${JSON.stringify(binIds)})
    RETURNING *`;
  return rows[0];
}

// How many empty-bin deliveries are already booked for a date + window
// (for per-slot capacity checks).
export async function countDeliveriesForSlot(date, slot) {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM jobs
    WHERE type = 'deliver_empty' AND scheduled_date = ${date} AND scheduled_slot = ${slot}`;
  return rows[0].n;
}

// Creates a deliver_empty job only if the window still has capacity, counting
// and inserting in ONE transaction so concurrent bookings can't overshoot the
// cap. Throws a 409-flavoured error when the window is full.
export async function createDeliveryJobIfCapacity({ bookingId, scheduledDate, scheduledSlot, capacity }) {
  return sql.begin(async (tx) => {
    // Advisory xact-lock on the (date, slot) pair: concurrent bookings for the
    // same window serialise here, so count+insert can't overshoot the cap.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${scheduledDate}|${scheduledSlot}`}))`;
    const rows = await tx`
      SELECT COUNT(*)::int AS n FROM jobs
      WHERE type = 'deliver_empty' AND scheduled_date = ${scheduledDate} AND scheduled_slot = ${scheduledSlot}`;
    if (rows[0].n >= capacity) {
      const err = new Error('That delivery window is full — please pick another');
      err.status = 409;
      throw err;
    }
    const id = newId('job');
    const inserted = await tx`
      INSERT INTO jobs (id, booking_id, type, status, scheduled_date, scheduled_slot, bin_ids)
      VALUES (${id}, ${bookingId}, ${'deliver_empty'}, ${'Scheduled'}, ${scheduledDate}, ${scheduledSlot}, ${'[]'})
      RETURNING *`;
    return inserted[0];
  });
}

export async function deleteBooking(id, client = sql) {
  await client`DELETE FROM bookings WHERE id = ${id}`;
}

// ----- cancel-booking helpers (transaction-scoped, used by transitions.js) ----

export async function listBinsForBookingForUpdate(bookingId, client) {
  return client`SELECT * FROM bins WHERE booking_id = ${bookingId} FOR UPDATE`;
}

// Keep movement history when a booking's jobs are deleted: detach the FK
// rather than deleting the rows (chain of custody survives cancellation).
export async function detachMovementsFromBookingJobs(bookingId, client) {
  await client`
    UPDATE movements SET job_id = NULL
    WHERE job_id IN (SELECT id FROM jobs WHERE booking_id = ${bookingId})`;
}

export async function deleteJobsForBooking(bookingId, client) {
  await client`DELETE FROM jobs WHERE booking_id = ${bookingId}`;
}

export async function createLead({ email = null, area = null }) {
  const id = newId('lead');
  const rows = await sql`
    INSERT INTO leads (id, email, area, created_at)
    VALUES (${id}, ${email}, ${area}, ${nowISO()})
    RETURNING *`;
  return rows[0];
}

export async function listLeads() {
  return sql`SELECT * FROM leads ORDER BY created_at DESC`;
}

export async function getJob(id) {
  const rows = await sql`SELECT * FROM jobs WHERE id = ${id}`;
  return rows[0];
}

export async function listJobs(client = sql) {
  return client`SELECT * FROM jobs ORDER BY scheduled_date`;
}

export async function listJobsForBooking(bookingId, client = sql) {
  return client`SELECT * FROM jobs WHERE booking_id = ${bookingId}`;
}

export async function setJobBinIds(id, binIds, client = sql) {
  await client`UPDATE jobs SET bin_ids = ${JSON.stringify(binIds)} WHERE id = ${id}`;
}

export async function setJobScheduledDate(id, scheduledDate, client = sql) {
  await client`UPDATE jobs SET scheduled_date = ${scheduledDate} WHERE id = ${id}`;
}

export async function setJobSchedule(id, scheduledDate, scheduledSlot = null) {
  await sql`UPDATE jobs SET scheduled_date = ${scheduledDate}, scheduled_slot = ${scheduledSlot} WHERE id = ${id}`;
}

export async function setJobStatus(id, status) {
  await sql`UPDATE jobs SET status = ${status} WHERE id = ${id}`;
}

// ----- movements -------------------------------------------------------------

export async function insertMovement(
  { binId, fromStatus, toStatus, locationId = null, actor, jobId = null },
  client = sql
) {
  const id = newId('mov');
  await client`
    INSERT INTO movements (id, bin_id, from_status, to_status, location_id, actor, job_id, ts)
    VALUES (${id}, ${binId}, ${fromStatus}, ${toStatus}, ${locationId}, ${actor}, ${jobId}, ${nowISO()})`;
  return id;
}

export async function listMovementsForBin(binId) {
  // id tiebreak keeps ordering stable when two movements share a timestamp.
  return sql`SELECT * FROM movements WHERE bin_id = ${binId} ORDER BY ts, id`;
}

// ----- aggregates / reset ----------------------------------------------------

export async function countBins() {
  const rows = await sql`SELECT COUNT(*)::int AS n FROM bins`;
  return rows[0].n;
}

// Bin counts grouped by status; null status reported as 'unassigned'.
export async function countBinsByStatus() {
  const rows = await sql`SELECT status, COUNT(*)::int AS n FROM bins GROUP BY status`;
  const out = {};
  for (const r of rows) out[r.status ?? 'unassigned'] = r.n;
  return out;
}

export async function wipeAll() {
  // Delete in dependency order (referencing rows before referenced rows).
  await sql.unsafe(`
    DELETE FROM movements;
    DELETE FROM bins;
    DELETE FROM jobs;
    DELETE FROM bookings;
    DELETE FROM locations;
    DELETE FROM customers;
  `);
}
