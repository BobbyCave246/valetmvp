// Unit tests for requireAuth / requireRole middleware.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET ??= 'test-secret-for-auth-middleware';
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';

const { requireAuth, requireRole, signToken } = await import('../src/auth.js');

function mkReq(role) {
  const token = signToken({ sub: 'user-1', role });
  return { headers: { cookie: `valet_session=${token}` } };
}

function mkRes() {
  return {
    _status: 200,
    _body: null,
    status(c) {
      this._status = c;
      return this;
    },
    json(o) {
      this._body = o;
      return this;
    },
  };
}

function runAuth(mw, req) {
  const res = mkRes();
  let passed = false;
  mw(req, res, () => {
    passed = true;
  });
  return { res, passed, req };
}

test('requireAuth rejects missing session', () => {
  const { res, passed } = runAuth(requireAuth, { headers: {} });
  assert.equal(passed, false);
  assert.equal(res._status, 401);
});

test('requireAuth accepts valid admin session', () => {
  const req = mkReq('admin');
  const { res, passed } = runAuth(requireAuth, req);
  assert.equal(passed, true);
  assert.equal(req.user.role, 'admin');
  assert.equal(res._status, 200);
});

test('requireRole admin allows admin', () => {
  const req = mkReq('admin');
  const auth = runAuth(requireAuth, req);
  assert.equal(auth.passed, true);
  const role = runAuth(requireRole('admin'), req);
  assert.equal(role.passed, true);
});

test('requireRole admin rejects driver', () => {
  const req = mkReq('driver');
  runAuth(requireAuth, req);
  const role = runAuth(requireRole('admin'), req);
  assert.equal(role.passed, false);
  assert.equal(role.res._status, 403);
});

test('requireRole warehouse allows admin superset', () => {
  const req = mkReq('admin');
  runAuth(requireAuth, req);
  const role = runAuth(requireRole('warehouse', 'admin'), req);
  assert.equal(role.passed, true);
});

test('requireRole driver rejects warehouse', () => {
  const req = mkReq('warehouse');
  runAuth(requireAuth, req);
  const role = runAuth(requireRole('driver', 'admin'), req);
  assert.equal(role.passed, false);
  assert.equal(role.res._status, 403);
});
