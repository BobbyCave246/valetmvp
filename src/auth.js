// Authentication core — password hashing, stateless signed session tokens,
// cookie helpers, and the requireAuth / requireRole middleware. Uses only
// Node's built-in crypto (no bcrypt/jsonwebtoken/cookie-parser), keeping the
// dependency surface tiny and Vercel-serverless friendly (no session store).

import { randomBytes, scrypt, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createUser, getUserByEmail } from './db.js';

const scryptAsync = promisify(scrypt);

const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  throw new Error(
    'AUTH_SECRET is not set. Generate one (e.g. `openssl rand -base64 32`) and ' +
      'set it in .env locally and as an env var on Vercel. It signs session tokens.'
  );
}

// Session lifetime — cookie Max-Age and token exp are kept in lock-step.
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 12 * 60 * 60); // 12h
const COOKIE_NAME = 'valet_session';
const SCRYPT_KEYLEN = 32;
const isProd = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

export const ROLES = ['admin', 'warehouse', 'driver'];

// ----- password hashing ------------------------------------------------------

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(String(plain), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  // Always returns a boolean; never throws on malformed input (treated as no-match).
  if (typeof stored !== 'string') return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  let derived;
  try {
    derived = await scryptAsync(String(plain), Buffer.from(saltB64, 'base64'), expected.length);
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// A fixed dummy hash so login can spend ~the same time whether or not the email
// exists, removing a timing oracle for email enumeration.
let DUMMY_HASH = null;
export async function dummyVerify(plain) {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy-password-not-used');
  await verifyPassword(plain, DUMMY_HASH);
}

// ----- stateless signed token ------------------------------------------------
// Compact JWT-like form: base64url(payload).base64url(HMAC-SHA256(payload)).

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(data) {
  return createHmac('sha256', AUTH_SECRET).update(data).digest();
}

export function signToken({ sub, role }) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = b64url(JSON.stringify({ sub, role, exp }));
  const sig = b64url(hmac(payload));
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(hmac(payload));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ----- cookies ---------------------------------------------------------------

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setCookie(res, value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isProd) parts.push('Secure');
  // Append so we never clobber an existing Set-Cookie on the response.
  const prev = res.getHeader('Set-Cookie');
  const cookie = parts.join('; ');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

export function setSessionCookie(res, token) {
  setCookie(res, token, SESSION_TTL_SECONDS);
}

export function clearSessionCookie(res) {
  setCookie(res, '', 0);
}

// ----- middleware ------------------------------------------------------------

export function requireAuth(req, res, next) {
  const claims = verifyToken(readCookie(req, COOKIE_NAME));
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: claims.sub, role: claims.role };
  next();
}

// requireRole(...roles) — must run after requireAuth.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// ----- starter staff seeding (idempotent, runs every boot) -------------------

export async function seedStarterUsers() {
  const starters = [
    { role: 'admin', email: process.env.SEED_ADMIN_EMAIL || 'admin@valet.local', password: process.env.SEED_ADMIN_PASSWORD, fallback: 'admin1234', name: 'Admin' },
    { role: 'driver', email: process.env.SEED_DRIVER_EMAIL || 'driver@valet.local', password: process.env.SEED_DRIVER_PASSWORD, fallback: 'driver1234', name: 'Driver' },
    { role: 'warehouse', email: process.env.SEED_WAREHOUSE_EMAIL || 'warehouse@valet.local', password: process.env.SEED_WAREHOUSE_PASSWORD, fallback: 'warehouse1234', name: 'Warehouse' },
  ];

  // Guard against shipping the well-known default passwords to production.
  // Default behaviour is a loud warning (so an existing deploy keeps working);
  // set SEED_STRICT=1 to hard-fail boot until real passwords are supplied.
  const usingDefaults = starters.filter((s) => !s.password).map((s) => s.role);
  if (isProd && usingDefaults.length) {
    const msg =
      `Insecure default staff password(s) in use for: ${usingDefaults.join(', ')}. ` +
      'Set SEED_ADMIN_PASSWORD / SEED_DRIVER_PASSWORD / SEED_WAREHOUSE_PASSWORD ' +
      '(strong values) as environment variables.';
    if (process.env.SEED_STRICT === '1') {
      throw new Error(`[SECURITY] ${msg} (SEED_STRICT=1 refuses to boot.)`);
    }
    console.warn(`\n⚠️  [SECURITY WARNING] ${msg}\n`);
  }

  for (const s of starters) {
    if (await getUserByEmail(s.email)) continue; // already seeded
    await createUser({ email: s.email, passwordHash: await hashPassword(s.password || s.fallback), role: s.role, name: s.name });
  }
}
