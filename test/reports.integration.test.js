// Integration tests for admin Reports API (#43).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const RUN = process.env.RUN_DB_TESTS === '1';
process.env.AUTH_SECRET ??= 'test-secret';

let db, sql, auth, app, server, baseUrl;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  auth = await import('../src/auth.js');
  app = (await import('../src/app.js')).default;
  sql = db.sql;
  await db.ensureSchema();

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  await fetch(`${baseUrl}/api/health`);
});

after(async () => {
  if (RUN && server) await new Promise((resolve) => server.close(resolve));
  if (RUN && sql) await sql.end({ timeout: 5 });
});

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : '';
}

async function login(email, password) {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, cookie: cookieFrom(r) };
}

async function authedGet(path, cookie) {
  return fetch(`${baseUrl}/api${path}`, { headers: { Cookie: cookie } });
}

describe('reports integration', { concurrency: 1 }, () => {
  test('admin can fetch report summary; driver gets 403', { skip: !RUN }, async () => {
    const admin = await login('admin@valet.local', 'admin1234');
    assert.equal(admin.status, 200);

    const summary = await authedGet('/reports/summary', admin.cookie);
    assert.equal(summary.status, 200);
    const data = await summary.json();
    assert.ok(data.range?.from);
    assert.ok(data.range?.to);
    assert.ok(data.snapshot?.bins);
    assert.ok(data.activity);
    assert.equal(typeof data.activity.bookingsCreated, 'number');

    const driverEmail = `${uid('drv')}@test.local`;
    await db.createUser({
      email: driverEmail,
      passwordHash: await auth.hashPassword('testpass123'),
      role: 'driver',
      name: 'Driver',
    });
    const driver = await login(driverEmail, 'testpass123');
    const forbidden = await authedGet('/reports/summary', driver.cookie);
    assert.equal(forbidden.status, 403);
  });

  test('invalid date range returns 400', { skip: !RUN }, async () => {
    const admin = await login('admin@valet.local', 'admin1234');
    const bad = await authedGet('/reports/summary?from=2025-12-01&to=2025-11-01', admin.cookie);
    assert.equal(bad.status, 400);
  });

  test('future range returns zero activity without error', { skip: !RUN }, async () => {
    const admin = await login('admin@valet.local', 'admin1234');
    const res = await authedGet('/reports/summary?from=2000-01-01&to=2000-01-31', admin.cookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.activity.bookingsCreated, 0);
    assert.deepEqual(data.activity.jobsCompleted, {});
    assert.equal(data.activity.transitions.length, 0);
  });
});
