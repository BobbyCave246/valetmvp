// Data-access module — the ONLY file that knows about better-sqlite3.
// Everything else goes through these helpers. To move to Postgres later,
// this is the one file you swap (see README migration note).

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where the SQLite file lives. On Vercel the project filesystem is read-only
// except for /tmp, so we write there — note /tmp is ephemeral and per-instance,
// so data resets on cold starts. That's acceptable for the demo until the
// Supabase/Postgres swap (which only touches this file). Override with VALET_DB.
const DB_PATH =
  process.env.VALET_DB || (process.env.VERCEL ? '/tmp/valet.db' : join(__dirname, '..', 'valet.db'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent — uses CREATE TABLE IF NOT EXISTS).
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ----- small helpers ---------------------------------------------------------

export function nowISO() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

// Run a function inside a transaction. better-sqlite3 transactions are sync.
export function tx(fn) {
  return db.transaction(fn)();
}

// ----- raw access (used by the data-access functions below) ------------------

export { db };

// ----- customers -------------------------------------------------------------

export function createCustomer({ name, phone, email, address, sitelinkTenantId = null }) {
  const id = newId('cust');
  db.prepare(
    `INSERT INTO customers (id, sitelink_tenant_id, name, phone, email, address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sitelinkTenantId, name, phone, email, address, nowISO());
  return getCustomer(id);
}

export function getCustomer(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

export function findCustomerByPhone(phone) {
  return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
}

// ----- bins ------------------------------------------------------------------

export function getBin(id) {
  return db.prepare('SELECT * FROM bins WHERE id = ?').get(id);
}

export function getBinByBarcode(barcode) {
  return db.prepare('SELECT * FROM bins WHERE barcode = ?').get(barcode);
}

export function listAvailableBins() {
  // Unassigned bins: no booking bound and status is still null/unassigned.
  return db
    .prepare(`SELECT * FROM bins WHERE booking_id IS NULL ORDER BY barcode`)
    .all();
}

export function listBinsForBooking(bookingId) {
  return db
    .prepare('SELECT * FROM bins WHERE booking_id = ? ORDER BY barcode')
    .all(bookingId);
}

export function setBinFields(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`UPDATE bins SET ${setClause} WHERE id = ?`).run(...values, id);
}

// ----- locations -------------------------------------------------------------

export function getLocation(id) {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

export function getLocationByBarcode(barcode) {
  return db.prepare('SELECT * FROM locations WHERE barcode = ?').get(barcode);
}

export function listFreeLocations() {
  return db
    .prepare('SELECT * FROM locations WHERE occupied = 0 ORDER BY barcode')
    .all();
}

// All slots with their current occupant's barcode (null if free).
export function listLocations() {
  return db
    .prepare(
      `SELECT l.*, b.barcode AS bin_barcode
       FROM locations l
       LEFT JOIN bins b ON b.location_id = l.id
       ORDER BY l.barcode`
    )
    .all();
}

export function setLocationOccupied(id, occupied) {
  db.prepare('UPDATE locations SET occupied = ? WHERE id = ?').run(occupied ? 1 : 0, id);
}

// ----- bookings --------------------------------------------------------------

export function createBooking({ customerId, binCount, skuBreakdown, deliveryDate }) {
  const id = newId('book');
  db.prepare(
    `INSERT INTO bookings (id, customer_id, bin_count, sku_breakdown, status, delivery_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    customerId,
    binCount,
    JSON.stringify(skuBreakdown || {}),
    'New',
    deliveryDate,
    nowISO()
  );
  return getBooking(id);
}

export function getBooking(id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
}

export function listBookings() {
  return db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
}

export function findBookingByPhone(phone) {
  return db
    .prepare(
      `SELECT b.* FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       WHERE c.phone = ?
       ORDER BY b.created_at DESC`
    )
    .all(phone);
}

// ----- jobs ------------------------------------------------------------------

export function createJob({ bookingId, type, scheduledDate, binIds = [] }) {
  const id = newId('job');
  db.prepare(
    `INSERT INTO jobs (id, booking_id, type, status, scheduled_date, bin_ids)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, bookingId, type, 'Scheduled', scheduledDate, JSON.stringify(binIds));
  return getJob(id);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function listJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY scheduled_date').all();
}

export function setJobBinIds(id, binIds) {
  db.prepare('UPDATE jobs SET bin_ids = ? WHERE id = ?').run(JSON.stringify(binIds), id);
}

export function setJobStatus(id, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
}

// ----- movements -------------------------------------------------------------

export function insertMovement({ binId, fromStatus, toStatus, locationId = null, actor, jobId = null }) {
  const id = newId('mov');
  db.prepare(
    `INSERT INTO movements (id, bin_id, from_status, to_status, location_id, actor, job_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, binId, fromStatus, toStatus, locationId, actor, jobId, nowISO());
  return id;
}

export function listMovementsForBin(binId) {
  return db
    .prepare('SELECT * FROM movements WHERE bin_id = ? ORDER BY ts')
    .all(binId);
}

// ----- reset -----------------------------------------------------------------

export function countBins() {
  return db.prepare('SELECT COUNT(*) AS n FROM bins').get().n;
}

// Bin counts grouped by status; null status reported as 'unassigned'.
export function countBinsByStatus() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM bins GROUP BY status').all();
  const out = {};
  for (const r of rows) out[r.status ?? 'unassigned'] = r.n;
  return out;
}

export function wipeAll() {
  // Delete in dependency order (referencing rows before referenced rows) so
  // foreign-key constraints stay satisfied. bins reference bookings, so bins
  // must go before bookings.
  db.exec(`
    DELETE FROM movements;
    DELETE FROM bins;
    DELETE FROM jobs;
    DELETE FROM bookings;
    DELETE FROM locations;
    DELETE FROM customers;
  `);
}
