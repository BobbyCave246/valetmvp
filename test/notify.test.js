// Unit tests for the booking-confirmation notifier. The DB import is satisfied
// with a dummy connection string; the network call is stubbed via global fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';
delete process.env.RESEND_API_KEY; // start from the stub default
const { sendBookingConfirmation } = await import('../src/notify.js');

const booking = { id: 'book_x1', delivery_date: '2026-07-01', delivery_slot: 'am' };
const customer = { email: 'c@example.com', name: 'Sam' };
const skuBreakdown = { bin: 2, wardrobe: 1 }; // 2*15 + 1*25 = $55/mo

test('no-ops (returns false) when RESEND_API_KEY is unset', async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendBookingConfirmation({ booking, customer, skuBreakdown }), false);
});

test('skips silently when the customer has no email', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  try {
    assert.equal(await sendBookingConfirmation({ booking, customer: { name: 'x' }, skuBreakdown }), false);
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test('POSTs a correct payload to Resend when configured', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const orig = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const sent = await sendBookingConfirmation({ booking, customer, skuBreakdown });
    assert.equal(sent, true);
    assert.equal(captured.url, 'https://api.resend.com/emails');
    assert.match(captured.opts.headers.Authorization, /^Bearer test_key$/);
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body.to, ['c@example.com']);
    assert.match(body.subject, /book_x1/);
    assert.match(body.html, /\$55\/mo/);
    assert.match(body.html, /Morning/);
    assert.match(body.html, /\$30 per delivery/);
  } finally {
    globalThis.fetch = orig;
    delete process.env.RESEND_API_KEY;
  }
});

test('never throws — a fetch failure resolves to false', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await sendBookingConfirmation({ booking, customer, skuBreakdown }), false);
  } finally {
    globalThis.fetch = orig;
    delete process.env.RESEND_API_KEY;
  }
});
