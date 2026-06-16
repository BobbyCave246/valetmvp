// Unit tests for service-area coverage. Pure, no DB import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCovered, listAreas, listVillages } from '../src/coverage.js';

test('the default area matches case- and whitespace-insensitively', () => {
  assert.ok(isCovered('The Villages at Coverley'));
  assert.ok(isCovered('the villages at coverley'));
  assert.ok(isCovered('  The Villages at Coverley  '));
});

test('uncovered / empty inputs are rejected', () => {
  assert.ok(!isCovered('Bridgetown'));
  assert.ok(!isCovered(''));
  assert.ok(!isCovered(null));
  assert.ok(!isCovered(undefined));
});

test('areas and villages lists are non-empty', () => {
  assert.ok(listAreas().length >= 1);
  assert.ok(listVillages().length >= 1);
});
