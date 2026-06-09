// Seed script (spec §7). Re-runnable: wipes everything then re-inserts the
// demo fixtures so the flow can be walked cleanly. Exported as seed() so the
// /api/admin/reset endpoint can reuse it; also runs directly via `npm run seed`.

import { db, wipeAll, countBins, nowISO, newId } from './db.js';

const BIN_SKUS = [
  'bin', 'bin', 'bin', 'bin',
  'wardrobe', 'wardrobe',
  'odd', 'odd',
  'bin', 'wardrobe',
]; // 10 bins, mixed SKUs

const LOCATION_BARCODES = [
  'A-01-1-01',
  'A-01-1-02',
  'A-01-2-01',
  'A-01-2-02',
  'A-02-1-01',
  'A-02-2-01',
]; // 6 free rack locations

export function seed() {
  wipeAll();

  // 1 demo customer with a placeholder SiteLink Tenant ID.
  const customerId = 'cust_demo';
  db.prepare(
    `INSERT INTO customers (id, sitelink_tenant_id, name, phone, email, address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    customerId,
    '236692',
    'Demo Customer',
    '555-0100',
    'demo@example.com',
    '12 Demo Street, Sampletown',
    nowISO()
  );

  // 10 unassigned bins BIN1001..BIN1010.
  const insertBin = db.prepare(
    `INSERT INTO bins (id, barcode, sku_type, status, customer_id, booking_id, location_id, photo_ref)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)`
  );
  BIN_SKUS.forEach((sku, i) => {
    const barcode = `BIN${1001 + i}`;
    insertBin.run(newId('bin'), barcode, sku);
  });

  // 6 free rack locations.
  const insertLoc = db.prepare(
    `INSERT INTO locations (id, barcode, occupied) VALUES (?, ?, 0)`
  );
  LOCATION_BARCODES.forEach((barcode) => {
    insertLoc.run(newId('loc'), barcode);
  });

  return {
    customers: 1,
    bins: BIN_SKUS.length,
    locations: LOCATION_BARCODES.length,
  };
}

// Seed only if the datastore is empty (never wipes existing data). Used on app
// startup so a fresh clone — or a Vercel cold start with an empty /tmp DB — is
// never empty for the demo.
export function seedIfEmpty() {
  if (countBins() === 0) return seed();
  return null;
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seed();
  console.log('Seeded:', result);
}
