// Integration tests for staff deactivate / reactivate (#41).
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
  // Warm up dbReady gate.
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
  return { status: r.status, data: await r.json(), cookie: cookieFrom(r) };
}

async function authedGet(path, cookie) {
  return fetch(`${baseUrl}/api${path}`, { headers: { Cookie: cookie } });
}

async function authedPost(path, cookie, body = {}) {
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe('staff lifecycle integration', { concurrency: 1 }, () => {
  test('deactivated user cannot login and loses API access', { skip: !RUN }, async () => {
    const email = `${uid('driver')}@test.local`;
    const password = 'testpass123';
    const user = await db.createUser({
      email,
      passwordHash: await auth.hashPassword(password),
      role: 'driver',
      name: 'Test Driver',
    });

    const admin = await login('admin@valet.local', 'admin1234');
    assert.equal(admin.status, 200);

    const activeSession = await login(email, password);
    assert.equal(activeSession.status, 200);

    const deactivate = await authedPost(`/auth/users/${user.id}/deactivate`, admin.cookie);
    assert.equal(deactivate.status, 200);

    const stale = await authedGet('/auth/me', activeSession.cookie);
    assert.equal(stale.status, 401);

    const blocked = await login(email, password);
    assert.equal(blocked.status, 401);

    const reactivate = await authedPost(`/auth/users/${user.id}/reactivate`, admin.cookie);
    assert.equal(reactivate.status, 200);

    const again = await login(email, password);
    assert.equal(again.status, 200);
  });

  test('cannot deactivate own account', { skip: !RUN }, async () => {
    const extraEmail = `${uid('admin_extra')}@test.local`;
    await db.createUser({
      email: extraEmail,
      passwordHash: await auth.hashPassword('testpass123'),
      role: 'admin',
      name: 'Extra Admin',
    });

    const admin = await login('admin@valet.local', 'admin1234');
    assert.equal(admin.status, 200);
    const me = await authedGet('/auth/me', admin.cookie);
    const { user } = await me.json();

    const self = await authedPost(`/auth/users/${user.id}/deactivate`, admin.cookie);
    assert.equal(self.status, 400);
    assert.match((await self.json()).error, /own account/i);
  });

  test('cannot deactivate the last active admin', { skip: !RUN }, async () => {
    const email = `${uid('admin2')}@test.local`;
    const password = 'testpass123';
    const secondAdmin = await db.createUser({
      email,
      passwordHash: await auth.hashPassword(password),
      role: 'admin',
      name: 'Second Admin',
    });

    const all = await db.listUsers();
    for (const u of all) {
      if (u.role === 'admin' && u.id !== secondAdmin.id && u.is_active !== 0) {
        await db.setUserActive(u.id, false);
      }
    }

    const session = await login(email, password);
    assert.equal(session.status, 200);

    const last = await authedPost(`/auth/users/${secondAdmin.id}/deactivate`, session.cookie);
    assert.equal(last.status, 400);
    assert.match((await last.json()).error, /last active admin/i);

    await db.setUserActive((await db.getUserByEmail('admin@valet.local')).id, true);
  });

  test('non-admin cannot deactivate staff', { skip: !RUN }, async () => {
    const email = `${uid('wh')}@test.local`;
    const password = 'testpass123';
    const target = await db.createUser({
      email,
      passwordHash: await auth.hashPassword(password),
      role: 'warehouse',
      name: 'WH',
    });

    const driverEmail = `${uid('drv')}@test.local`;
    const driverPass = 'testpass123';
    await db.createUser({
      email: driverEmail,
      passwordHash: await auth.hashPassword(driverPass),
      role: 'driver',
      name: 'Driver',
    });

    const driver = await login(driverEmail, driverPass);
    assert.equal(driver.status, 200);

    const forbidden = await authedPost(`/auth/users/${target.id}/deactivate`, driver.cookie);
    assert.equal(forbidden.status, 403);

    await db.setUserActive(target.id, true);
  });
});
