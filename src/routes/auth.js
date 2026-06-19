// Auth routes: login / logout / me, plus admin-only staff management.
// Sessions are a signed httpOnly cookie (see src/auth.js) — stateless, so
// nothing to store server-side.

import { Router } from 'express';
import {
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  setUserActive,
  countActiveAdmins,
} from '../db.js';
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
  isUserActive,
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

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    is_active: user.is_active ?? 1,
    deactivated_at: user.deactivated_at ?? null,
  };
}

// POST /api/auth/login { email, password } — public.
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await getUserByEmail(String(email));
  // Always run a hash comparison so unknown-email and wrong-password cost the
  // same time (no enumeration oracle), and return an identical message.
  let ok = false;
  if (user && isUserActive(user)) {
    ok = await verifyPassword(password, user.password_hash);
  } else {
    await dummyVerify(password);
  }
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
  if (!isUserActive(user)) return res.status(401).json({ error: 'Authentication required' });
  res.json({ user: publicUser(user) });
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
    res.status(201).json({ user: publicUser({ ...user, is_active: 1, deactivated_at: null }) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A user with email ${email} already exists` });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/auth/users/:id/deactivate — admin: soft-deactivate staff.
router.post('/users/:id/deactivate', requireAuth, requireRole('admin'), async (req, res) => {
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!isUserActive(target)) {
    return res.status(400).json({ error: 'User is already inactive' });
  }
  if (target.role === 'admin' && (await countActiveAdmins()) <= 1) {
    return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  const user = await setUserActive(target.id, false);
  res.json({ user: publicUser(user) });
});

// POST /api/auth/users/:id/reactivate — admin: re-enable staff.
router.post('/users/:id/reactivate', requireAuth, requireRole('admin'), async (req, res) => {
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isUserActive(target)) {
    return res.status(400).json({ error: 'User is already active' });
  }
  const user = await setUserActive(target.id, true);
  res.json({ user: publicUser(user) });
});

export default router;
