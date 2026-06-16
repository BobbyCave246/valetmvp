// Unit tests for the small shared helpers. Pure, no DB import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeParse, VALID_SKUS } from '../src/util.js';

test('safeParse returns the parsed value for valid JSON', () => {
  assert.deepEqual(safeParse('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
});

test('safeParse returns null for invalid / non-JSON input', () => {
  assert.equal(safeParse('not json'), null);
  assert.equal(safeParse(undefined), null);
  assert.equal(safeParse(''), null);
});

test('VALID_SKUS holds the bin catalogue', () => {
  assert.deepEqual([...VALID_SKUS].sort(), ['bin', 'odd', 'wardrobe']);
});
