// Integration tests for transitionBin against a REAL Postgres — they exercise
// the transactional row-locking that unit tests can't. They only run when
// RUN_DB_TESTS=1 and DATABASE_URL points at a throwaway database (CI provisions
// one). Otherwise every test is skipped, so the suite stays green locally.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';

let db, tx, STATUS, TransitionError, sql;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  tx = await import('../src/transitions.js');
  ({ STATUS, TransitionError } = tx);
  sql = db.sql;
  await db.ensureSchema();
});

after(async () => {
  if (RUN && sql) await sql.end({ timeout: 5 });
});

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const bc = () => uid('BC').toUpperCase();

// Advance a fresh bin to In transit (inbound), ready to be stored.
async function binReadyToStore() {
  const bin = await db.createBin({ barcode: bc(), skuType: 'bin' });
  await tx.transitionBin(bin.id, STATUS.ASSIGNED, { actor: 'admin' });
  await tx.transitionBin(bin.id, STATUS.OUT_FOR_FILLING, { actor: 'admin' });
  await tx.transitionBin(bin.id, STATUS.IN_TRANSIT_INBOUND, { actor: 'admin' });
  return bin;
}

async function freeLocation() {
  const id = uid('loc');
  await sql`INSERT INTO locations (id, barcode, occupied) VALUES (${id}, ${uid('L').toUpperCase()}, 0)`;
  return id;
}

test('full lifecycle succeeds and an illegal move throws', { skip: !RUN }, async () => {
  const bin = await binReadyToStore();
  const locId = await freeLocation();
  const stored = await tx.transitionBin(bin.id, STATUS.STORED, { actor: 'admin', locationId: locId });
  assert.equal(stored.status, STATUS.STORED);

  await assert.rejects(
    () => tx.transitionBin(bin.id, STATUS.ASSIGNED, { actor: 'admin' }),
    (e) => e instanceof TransitionError,
  );

  // movements were recorded in the same transaction as each status change.
  const moves = await sql`SELECT 1 FROM movements WHERE bin_id = ${bin.id}`;
  assert.ok(moves.length >= 4);
});

test('a location cannot hold two bins at once', { skip: !RUN }, async () => {
  const locId = await freeLocation();
  const b1 = await binReadyToStore();
  const b2 = await binReadyToStore();
  await tx.transitionBin(b1.id, STATUS.STORED, { actor: 'admin', locationId: locId });
  await assert.rejects(
    () => tx.transitionBin(b2.id, STATUS.STORED, { actor: 'admin', locationId: locId }),
    (e) => e instanceof TransitionError,
  );
});

test('storing requires a location', { skip: !RUN }, async () => {
  const bin = await binReadyToStore();
  await assert.rejects(
    () => tx.transitionBin(bin.id, STATUS.STORED, { actor: 'admin' }),
    (e) => e instanceof TransitionError,
  );
});
