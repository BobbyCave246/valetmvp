// Unit tests for driver job sort + maps URL helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sortTodayJobs, mapsUrl, customerAddress } = await import('../src/driver-jobs.js');

const job = (slot, address, postcode = '') => ({
  scheduled_slot: slot,
  booking: { customer: { address, postcode } },
});

test('sortTodayJobs orders am before pm, then address', () => {
  const sorted = sortTodayJobs([
    job('pm', 'Zulu Rd'),
    job('am', 'Beta St'),
    job('am', 'Alpha Ave'),
    job(null, 'No slot'),
  ]);
  assert.equal(sorted[0].booking.customer.address, 'Alpha Ave');
  assert.equal(sorted[1].booking.customer.address, 'Beta St');
  assert.equal(sorted[2].scheduled_slot, 'pm');
});

test('mapsUrl encodes destination for Google Maps', () => {
  const url = mapsUrl({ address: '10 Main St', postcode: 'BB11000' });
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  assert.ok(url.includes(encodeURIComponent('10 Main St, BB11000')));
});

test('mapsUrl returns null without address', () => {
  assert.equal(mapsUrl({}), null);
  assert.equal(mapsUrl(null), null);
});

test('customerAddress joins address and postcode', () => {
  assert.equal(customerAddress({ address: '1 Foo', postcode: 'X1' }), '1 Foo, X1');
});
