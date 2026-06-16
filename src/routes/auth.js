// Auth routes: login / logout / me, plus admin-only staff management.
// Sessions are a signed httpOnly cookie (see src/auth.js) — stateless, so
// nothing to store server-side.

import { Router } from 'express';
import { createUser, getUserByEmail, getUserById, listUsers } from '../db.js';
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
  ROLES,
} from '../auth.js';
import { rateLimit, clientIp } from '../ratelimit.js';

const router = Router();

// Throttle login attempts to blunt brute-force / credential-spray against the
// staff accounts. Keyed by IP + submitted email so one IP can't spray many
// accounts and one account can't be hammered from one IP. Tunable via env.
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.LOGIN_RATE_MAX || 10),
  keyFn: (req) => `${clientIp(req)}|${String(req.body?.email || '').toLowerCase()}`,
});

// POST /api/auth/login { email, password } — public.
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await getUserByEmail(String(email));
  // Always run a hash comparison so unknown-email and wrong-password cost the
  // same time (no enumeration oracle), and return an identical message.
  const ok = user ? await verifyPassword(password, user.password_hash) : (await dummyVerify(password), false);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  setSessionCookie(res, signToken({ sub: user.id, role: user.role }));
  res.json({ user: { email: user.email, role: user.role, name: user.name } });
});

// POST /api/auth/logout — public no-op if not logged in.
router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — current signed-in user.
router.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  res.json({ user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

// GET /api/auth/users — admin: list staff (never includes password hashes).
router.get('/users', requireAuth, requireRole('admin'), async (_req, res) => {
  res.json(await listUsers());
});

// POST /api/auth/users { email, name, role, password } — admin: create staff.
router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const user = await createUser({ email: String(email), passwordHash: await hashPassword(password), role, name: name || null });
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A user with email ${email} already exists` });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
