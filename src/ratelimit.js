// Tiny in-memory fixed-window rate limiter — zero dependencies.
//
// Caveat: on Vercel the app runs as multiple ephemeral serverless instances, so
// this counter is per-instance and resets on cold start. It is therefore
// best-effort, not a hard global limit — but it still meaningfully slows down
// brute-force / credential-spray against a single hot instance. The robust
// upgrade (a shared Postgres- or Redis-backed counter) is a deliberate
// follow-up, not built here.

// key -> { count, resetAt }
const buckets = new Map();

// Drop expired buckets so the Map can't grow without bound. Called on each hit;
// O(n) but n stays small for a low-traffic MVP.
function sweep(now) {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

// Best-effort client IP behind Vercel's proxy. x-forwarded-for is a comma-
// separated list (client, proxy1, ...); the first entry is the original client.
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// rateLimit({ windowMs, max, keyFn }) -> express middleware.
// Returns 429 with a Retry-After header once `max` requests share a key inside
// the current `windowMs` window.
export function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = keyFn(req);
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many attempts. Please wait a moment and try again.',
      });
    }
    next();
  };
}
