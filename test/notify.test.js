// Unit tests for outbound notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test';
process.env.AUTH_SECRET ??= 'test-secret';
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const {
  sendBookingConfirmation,
  sendJobDoneEmail,
  sendJobDoneSms,
  JOB_DONE_COPY,
} = await import('../src/notify.js');

const booking = { id: 'book_x1', delivery_date: '2026-07-01', delivery_slot: 'am' };
const customer = { email: 'c@example.com', name: 'Sam', phone: '+15550123' };
const skuBreakdown = { bin: 2, wardrobe: 1 };
const job = { id: 'job_1', type: 'deliver_empty', status: 'Done', booking_id: booking.id };

test('no-ops (returns false) when RESEND_API_KEY is unset', async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendBookingConfirmation({ booking, customer, skuBreakdown }), false);
  assert.equal(await sendJobDoneEmail({ booking, customer, job }), false);
});

test('skips silently when the customer has no email', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  try {
    assert.equal(await sendJobDoneEmail({ booking, customer: { name: 'x' }, job }), false);
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test('booking confirmation POSTs to Resend when configured', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const orig = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const sent = await sendBookingConfirmation({ booking, customer, skuBreakdown: { bin: 2, wardrobe: 1 } });
    assert.equal(sent, true);
    assert.equal(captured.url, 'https://api.resend.com/emails');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body.to, ['c@example.com']);
    assert.match(body.subject, /book_x1/);
    assert.match(body.html, /\$55\/mo/);
  } finally {
    globalThis.fetch = orig;
    delete process.env.RESEND_API_KEY;
  }
});

test('POSTs a correct job-done payload to Resend when configured', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const orig = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const sent = await sendJobDoneEmail({ booking, customer, job });
    assert.equal(sent, true);
    assert.equal(captured.url, 'https://api.resend.com/emails');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body.to, ['c@example.com']);
    assert.match(body.subject, /book_x1/);
    assert.match(body.html, /delivered/i);
    assert.match(body.html, /Fill your bins/);
  } finally {
    globalThis.fetch = orig;
    delete process.env.RESEND_API_KEY;
  }
});

test('POSTs job-done SMS to Twilio when configured', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_FROM_NUMBER = '+15559999';
  const orig = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const sent = await sendJobDoneSms({ booking, customer, job: { ...job, type: 'collect_full' } });
    assert.equal(sent, true);
    assert.match(captured.url, /AC_test/);
    assert.match(captured.opts.body, /15550123/);
    assert.match(captured.opts.body, /collected/i);
  } finally {
    globalThis.fetch = orig;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  }
});

test('SMS no-ops when Twilio is not configured', async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  assert.equal(await sendJobDoneSms({ booking, customer, job }), false);
});

test('never throws — a fetch failure resolves to false', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await sendJobDoneEmail({ booking, customer, job }), false);
  } finally {
    globalThis.fetch = orig;
    delete process.env.RESEND_API_KEY;
  }
});
