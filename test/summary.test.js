import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';

const { deriveCustomerNextStepFromBins } = await import('../src/summary.js');
const { STATUS } = await import('../src/transitions.js');

const storedBin = (id) => ({ id, status: STATUS.STORED, barcode: id, sku_type: 'bin' });
const returnedBin = (id) => ({ id, status: STATUS.RETURNED_TO_CUSTOMER, barcode: id, sku_type: 'bin' });

test('mixed Stored + Returned shows split copy, not Safely stored', () => {
  const step = deriveCustomerNextStepFromBins([storedBin('a'), storedBin('b'), returnedBin('c')]);
  assert.equal(step.kind, 'mixed');
  assert.match(step.text, /2 bins in storage/);
  assert.match(step.text, /1 back with you/);
});

test('all Stored prompts retrieval', () => {
  const step = deriveCustomerNextStepFromBins([storedBin('a'), storedBin('b')]);
  assert.equal(step.kind, 'stored');
  assert.match(step.text, /safely stored/i);
});

test('all Returned to customer prompts re-store or close', () => {
  const step = deriveCustomerNextStepFromBins([returnedBin('a')]);
  assert.equal(step.kind, 'returned');
  assert.match(step.text, /back with you/i);
});

test('Out for filling without collection job prompts booking', () => {
  const step = deriveCustomerNextStepFromBins([
    { id: 'a', status: STATUS.OUT_FOR_FILLING, barcode: 'A', sku_type: 'bin' },
  ]);
  assert.equal(step.kind, 'action');
  assert.match(step.text, /book a collection/i);
});

test('Out for filling with scheduled collection shows date', () => {
  const step = deriveCustomerNextStepFromBins(
    [{ id: 'a', status: STATUS.OUT_FOR_FILLING, barcode: 'A', sku_type: 'bin' }],
    [{ type: 'collect_full', status: 'Scheduled', scheduled_date: '2026-07-01' }]
  );
  assert.equal(step.kind, 'scheduled');
  assert.match(step.text, /2026-07-01/);
});

test('transit states beat idle Stored', () => {
  const step = deriveCustomerNextStepFromBins([
    storedBin('a'),
    { id: 'b', status: STATUS.IN_TRANSIT_OUTBOUND, barcode: 'B', sku_type: 'bin' },
  ]);
  assert.equal(step.kind, 'transit');
  assert.match(step.text, /on the way back/i);
});
