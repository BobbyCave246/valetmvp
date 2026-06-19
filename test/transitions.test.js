// Unit tests for the bin state-machine legality table — the heart of the
// system. Pure function, no DB. transitions.js transitively imports db.js,
// which only requires DATABASE_URL/AUTH_SECRET to be *present* at import (it
// never connects for these checks), so we set harmless defaults then import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';
const { isLegalTransition, STATUS } = await import('../src/transitions.js');

test('an unassigned bin can only be assigned', () => {
  assert.ok(isLegalTransition(STATUS.UNASSIGNED, STATUS.ASSIGNED));
  assert.ok(!isLegalTransition(STATUS.UNASSIGNED, STATUS.STORED));
  assert.ok(!isLegalTransition(STATUS.UNASSIGNED, STATUS.OUT_FOR_FILLING));
});

test('the full happy-path lifecycle is legal end to end', () => {
  const path = [
    [STATUS.UNASSIGNED, STATUS.ASSIGNED],
    [STATUS.ASSIGNED, STATUS.OUT_FOR_FILLING],
    [STATUS.OUT_FOR_FILLING, STATUS.IN_TRANSIT_INBOUND],
    [STATUS.IN_TRANSIT_INBOUND, STATUS.STORED],
    [STATUS.STORED, STATUS.RETRIEVAL_REQUESTED],
    [STATUS.RETRIEVAL_REQUESTED, STATUS.IN_TRANSIT_OUTBOUND],
    [STATUS.IN_TRANSIT_OUTBOUND, STATUS.RETURNED_TO_CUSTOMER],
    [STATUS.RETURNED_TO_CUSTOMER, STATUS.RETURNED_CLOSED],
  ];
  for (const [from, to] of path) {
    assert.ok(isLegalTransition(from, to), `${from ?? '(unassigned)'} -> ${to}`);
  }
});

test('a returned bin can be re-stored without re-filling', () => {
  assert.ok(isLegalTransition(STATUS.RETURNED_TO_CUSTOMER, STATUS.IN_TRANSIT_INBOUND));
  // ...but it must not jump back through the filling step.
  assert.ok(!isLegalTransition(STATUS.RETURNED_TO_CUSTOMER, STATUS.OUT_FOR_FILLING));
});

test('a closed bin re-enters inventory only via assignment', () => {
  assert.ok(isLegalTransition(STATUS.RETURNED_CLOSED, STATUS.ASSIGNED));
  assert.ok(!isLegalTransition(STATUS.RETURNED_CLOSED, STATUS.STORED));
});

test('retrieval can be cancelled back to stored', () => {
  assert.ok(isLegalTransition(STATUS.RETRIEVAL_REQUESTED, STATUS.STORED));
  assert.ok(isLegalTransition(STATUS.RETRIEVAL_REQUESTED, STATUS.IN_TRANSIT_OUTBOUND));
});

test('illegal jumps are rejected', () => {
  assert.ok(!isLegalTransition(STATUS.ASSIGNED, STATUS.STORED));
  assert.ok(!isLegalTransition(STATUS.STORED, STATUS.ASSIGNED));
  assert.ok(!isLegalTransition(STATUS.OUT_FOR_FILLING, STATUS.STORED));
  assert.ok(!isLegalTransition(STATUS.IN_TRANSIT_INBOUND, STATUS.RETRIEVAL_REQUESTED));
});

test('an unknown status has no legal moves', () => {
  assert.ok(!isLegalTransition('Bogus', STATUS.ASSIGNED));
  assert.ok(!isLegalTransition(STATUS.ASSIGNED, 'Bogus'));
});
