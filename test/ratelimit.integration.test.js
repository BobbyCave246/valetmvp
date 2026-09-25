// Integration tests for the per-IP limits on public routes and login, over
// real HTTP. Limits are set low here so the tests stay fast.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';
process.env.BOOKING_RATE_MAX = '2';
process.env.LEADS_RATE_MAX = '2';
process.env.LOGIN_IP_RATE_MAX = '3';
delete process.env.VERCEL;
delete process.env.TRUST_PROXY;

let db, app, server, baseUrl;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  app = (await import('../src/app.js')).default;
  await db.ensureSchema();
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/health`);
});

after(async () => {
  if (RUN && server) await new Promise((resolve) => server.close(resolve));
  if (RUN && db) await db.sql.end({ timeout: 5 });
});

// Each call claims a different IP; without a trusted proxy that must not help.
let n = 0;
function post(path, body) {
  n += 1;
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${n}` },
    body: JSON.stringify(body),
  });
}

describe('per-IP rate limits', { concurrency: 1 }, () => {
  test('bookings are capped per IP, and a faked X-Forwarded-For does not reset it', { skip: !RUN }, async () => {
    // Invalid bodies still count: the limit runs before validation.
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post('/bookings', {})).status);
    assert.deepEqual(statuses, [400, 400, 429]);
  });

  test('waitlist leads are capped per IP', { skip: !RUN }, async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post('/leads', { email: `x${i}@example.com` })).status);
    assert.deepEqual(statuses, [201, 201, 429]);
  });

  test('login is capped per IP across different accounts', { skip: !RUN }, async () => {
    // A different email each time, so only the per-IP budget can stop it.
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/auth/login', { email: `spray${i}@example.com`, password: 'nope-nope' })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429]);
  });
});
