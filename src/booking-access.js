// Customer access to a booking. Customers never log in, so each booking carries
// a long random access token that we hand out only in the confirmation link
// (and the phone-lookup SMS/email). Every customer-facing booking or bin route
// needs that token, or a signed-in staff session, before it reads or changes
// anything. The booking id alone is a reference, not a key.

import { timingSafeEqual } from 'node:crypto';
import { getBooking, getUserById } from './db.js';
import { verifyToken, readCookie, isUserActive } from './auth.js';

const COOKIE_NAME = 'valet_session';
const isProd = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

// The token travels in a header, never the query string, so it stays out of
// request logs.
export function tokenFromRequest(req) {
  const t = req.get('x-booking-token');
  return typeof t === 'string' && t.length ? t : null;
}

export function tokenMatches(booking, token) {
  if (!booking?.access_token || typeof token !== 'string') return false;
  const a = Buffer.from(booking.access_token);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Signed-in, still-active staff member, or null. Checks the DB so a
// deactivated account loses access at once.
export async function staffFromRequest(req) {
  const claims = verifyToken(readCookie(req, COOKIE_NAME));
  if (!claims) return null;
  const user = await getUserById(claims.sub);
  return isUserActive(user) ? user : null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Resolve who is acting on a booking: 'admin' / 'staff' for a signed-in staff
// member whose role is in staffRoles, 'customer' for a matching token. Throws
// 401 when no credential was sent and 404 for a wrong token or unknown booking
// (the same answer either way, so ids can't be probed).
export async function bookingActor(req, booking, { staffRoles = ['admin'] } = {}) {
  const staff = await staffFromRequest(req);
  if (staff && staffRoles.includes(staff.role)) {
    return staff.role === 'admin' ? 'admin' : 'staff';
  }
  const token = tokenFromRequest(req);
  if (!token) {
    throw httpError(401, 'Open your booking from the link in your confirmation, or look it up by phone');
  }
  if (!booking || !tokenMatches(booking, token)) throw httpError(404, 'Booking not found');
  return 'customer';
}

// Load a booking by id and check access in one step.
export async function loadBookingFor(req, bookingId, opts) {
  const booking = bookingId ? await getBooking(bookingId) : null;
  const actor = await bookingActor(req, booking, opts);
  if (!booking) throw httpError(404, 'Booking not found');
  return { booking, actor };
}

// Access to a bin goes through the booking it belongs to. A bin with no
// booking is staff-only. Unknown bin and no access give the same 404.
export async function binActor(req, bin, opts) {
  const booking = bin?.booking_id ? await getBooking(bin.booking_id) : null;
  const actor = await bookingActor(req, booking, opts);
  if (!bin) throw httpError(404, 'Bin not found');
  return actor;
}

// Base URL for links we send to customers. Comes from config, not the request
// Host header, so a forged Host can't make us text out links to another site.
// Local dev falls back to the request.
export function publicBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : null);
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (!isProd && req) return `${req.protocol}://${req.get('host')}`;
  return null;
}

// The token goes in the URL fragment, which browsers never send to the server.
export function bookingLink(baseUrl, booking) {
  if (!baseUrl || !booking?.access_token) return null;
  return `${baseUrl}/booking/booking.html?ref=${encodeURIComponent(booking.id)}#t=${booking.access_token}`;
}

// Drop the token before a booking goes to anyone who shouldn't hold it.
export function withoutToken(booking) {
  if (!booking) return booking;
  const { access_token: _t, ...rest } = booking;
  return rest;
}
