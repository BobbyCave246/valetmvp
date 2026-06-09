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
  status         TEXT,
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
`;

// Run once on startup (idempotent). app.js awaits this before serving.
export async function ensureSchema() {
  await sql.unsafe(SCHEMA_DDL);
}

// ----- customers -------------------------------------------------------------

export async function createCustomer({
  name = null,
  phone = null,
  email = null,
  address = null,
  sitelinkTenantId = null,
}) {
  const id = newId('cust');
  const rows = await sql`
    INSERT INTO customers (id, sitelink_tenant_id, name, phone, email, address, created_at)
    VALUES (${id}, ${sitelinkTenantId}, ${name}, ${phone}, ${email}, ${address}, ${nowISO()})
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

// ----- bins ------------------------------------------------------------------

export async function getBin(id, client = sql) {
  const rows = await client`SELECT * FROM bins WHERE id = ${id}`;
  return rows[0];
}

export async function getBinByBarcode(barcode) {
  const rows = await sql`SELECT * FROM bins WHERE barcode = ${barcode}`;
  return rows[0];
}

export async function listAvailableBins() {
  return sql`SELECT * FROM bins WHERE booking_id IS NULL ORDER BY barcode`;
}

export async function listBinsForBooking(bookingId) {
  return sql`SELECT * FROM bins WHERE booking_id = ${bookingId} ORDER BY barcode`;
}

export async function setBinFields(id, fields, client = sql) {
  if (Object.keys(fields).length === 0) return;
  await client`UPDATE bins SET ${client(fields)} WHERE id = ${id}`;
}

// ----- locations -------------------------------------------------------------

export async function getLocation(id) {
  const rows = await sql`SELECT * FROM locations WHERE id = ${id}`;
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

export async function createBooking({ customerId = null, binCount = null, skuBreakdown, deliveryDate = null }) {
  const id = newId('book');
  const rows = await sql`
    INSERT INTO bookings (id, customer_id, bin_count, sku_breakdown, status, delivery_date, created_at)
    VALUES (${id}, ${customerId}, ${binCount}, ${JSON.stringify(skuBreakdown || {})}, ${'New'}, ${deliveryDate}, ${nowISO()})
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

export async function createJob({ bookingId = null, type = null, scheduledDate = null, binIds = [] }) {
  const id = newId('job');
  const rows = await sql`
    INSERT INTO jobs (id, booking_id, type, status, scheduled_date, bin_ids)
    VALUES (${id}, ${bookingId}, ${type}, ${'Scheduled'}, ${scheduledDate}, ${JSON.stringify(binIds)})
    RETURNING *`;
  return rows[0];
}

export async function getJob(id) {
  const rows = await sql`SELECT * FROM jobs WHERE id = ${id}`;
  return rows[0];
}

export async function listJobs() {
  return sql`SELECT * FROM jobs ORDER BY scheduled_date`;
}

export async function setJobBinIds(id, binIds) {
  await sql`UPDATE jobs SET bin_ids = ${JSON.stringify(binIds)} WHERE id = ${id}`;
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
  return sql`SELECT * FROM movements WHERE bin_id = ${binId} ORDER BY ts`;
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
