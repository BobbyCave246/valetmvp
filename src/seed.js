// Seed script (spec §7). Re-runnable: wipes everything then re-inserts the
// demo fixtures. Exported as seed() so /api/admin/reset can reuse it; also runs
// directly via `npm run seed`.

import { sql, wipeAll, countBins, ensureSchema, nowISO, newId } from './db.js';

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

export async function seed() {
  await wipeAll();

  // 1 demo customer with a placeholder SiteLink Tenant ID.
  await sql`
    INSERT INTO customers (id, sitelink_tenant_id, name, phone, email, address, created_at)
    VALUES ('cust_demo', '236692', 'Demo Customer', '555-0100', 'demo@example.com',
            '12 Demo Street, Sampletown', ${nowISO()})`;

  // 10 unassigned bins BIN1001..BIN1010.
  for (let i = 0; i < BIN_SKUS.length; i++) {
    await sql`
      INSERT INTO bins (id, barcode, sku_type, status, customer_id, booking_id, location_id, photo_ref)
      VALUES (${newId('bin')}, ${`BIN${1001 + i}`}, ${BIN_SKUS[i]}, NULL, NULL, NULL, NULL, NULL)`;
  }

  // 6 free rack locations.
  for (const barcode of LOCATION_BARCODES) {
    await sql`INSERT INTO locations (id, barcode, occupied) VALUES (${newId('loc')}, ${barcode}, 0)`;
  }

  return { customers: 1, bins: BIN_SKUS.length, locations: LOCATION_BARCODES.length };
}

// Seed only if the datastore is empty (never wipes existing data). Used on app
// startup so a fresh database is never empty for the demo.
export async function seedIfEmpty() {
  if ((await countBins()) === 0) return seed();
  return null;
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureSchema();
  const result = await seed();
  console.log('Seeded:', result);
  process.exit(0);
}
