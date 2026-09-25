// Unit tests for the in-memory rate limiter. Pure, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, clientIp } from '../src/ratelimit.js';

function mkRes() {
  return {
    _status: 200, _headers: {}, _body: null,
    set(k, v) { this._headers[k] = v; return this; },
    status(c) { this._status = c; return this; },
    json(o) { this._body = o; return this; },
  };
}
function run(mw, req) {
  const res = mkRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { res, passed };
}

test('allows up to max, then blocks with 429 + Retry-After', () => {
  const mw = rateLimit({ windowMs: 10_000, max: 3, keyFn: () => 'same' });
  const req = { headers: {}, ip: '1.1.1.1' };
  for (let i = 0; i < 3; i++) assert.ok(run(mw, req).passed, `attempt ${i + 1} should pass`);
  const blocked = run(mw, req);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res._status, 429);
  assert.ok(Number(blocked.res._headers['Retry-After']) > 0);
});

test('separate keys have independent budgets', () => {
  const mw = rateLimit({ windowMs: 10_000, max: 1, keyFn: (r) => r.headers['x-key'] });
  assert.ok(run(mw, { headers: { 'x-key': 'a' } }).passed);
  assert.ok(run(mw, { headers: { 'x-key': 'b' } }).passed);
  assert.equal(run(mw, { headers: { 'x-key': 'a' } }).passed, false);
});

test('the window resets after it expires', async () => {
  const mw = rateLimit({ windowMs: 30, max: 1, keyFn: () => 'k' });
  const req = { headers: {}, ip: 'x' };
  assert.ok(run(mw, req).passed);
  assert.equal(run(mw, req).passed, false);
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(run(mw, req).passed, 'should pass again after the window resets');
});

test('clientIp ignores x-forwarded-for unless a proxy is trusted', () => {
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;
  const req = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '2.2.2.2' } };
  assert.equal(clientIp(req), '2.2.2.2', 'a faked header must not change the key');
});

test('clientIp uses the first x-forwarded-for hop behind Vercel or TRUST_PROXY', () => {
  const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '2.2.2.2' } };
  try {
    process.env.VERCEL = '1';
    assert.equal(clientIp(req), '9.9.9.9');
    delete process.env.VERCEL;
    process.env.TRUST_PROXY = '1';
    assert.equal(clientIp(req), '9.9.9.9');
  } finally {
    delete process.env.VERCEL;
    delete process.env.TRUST_PROXY;
  }
});
