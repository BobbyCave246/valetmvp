// Monthly billing. The app doesn't take cards: Store All charges on its
// existing Plug'n Pay till, and this module tells the office what to charge.
//
// Rules (the business case: "$30/bin/month while the bin is in the facility,
// meter stops on redelivery; $50 per trip back out"):
// - Storage: a bin is "in the facility" from the movement that makes it Stored
//   until the one that takes it out (In transit (outbound), or a release).
//   Retrieval requested still counts, since the bin hasn't left. Each stay is
//   charged pro rata: price × (time in facility that month ÷ length of month).
// - Returns: each deliver_back job handed over in the month is one order at
//   the retrieval fee, however many bins it carried.
// - Paid: payments recorded with period = that month are taken off.
// Months run on the Barbados calendar (SERVICE_TZ).

import { SERVICE_TZ } from './slots.js';
import { STATUS } from './transitions.js';

export const STORAGE_PRICE = Number(process.env.STORAGE_PRICE_PER_BIN || 30);
export const RETRIEVAL_FEE = Number(process.env.RETRIEVAL_FEE || 50);

const IN_FACILITY = new Set([STATUS.STORED, STATUS.RETRIEVAL_REQUESTED]);
const DAY_MS = 24 * 60 * 60 * 1000;

export function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// Offset of `timeZone` from UTC at `utcMs`, in ms.
function tzOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

function localMidnightUtc(y, m, timeZone) {
  const guess = Date.UTC(y, m - 1, 1);
  return guess - tzOffsetMs(guess, timeZone);
}

/** [start, end) of a YYYY-MM month in the service timezone, as epoch ms. */
export function monthBounds(month, timeZone = SERVICE_TZ) {
  const [y, m] = month.split('-').map(Number);
  const start = localMidnightUtc(y, m, timeZone);
  const end = m === 12 ? localMidnightUtc(y + 1, 1, timeZone) : localMidnightUtc(y, m + 1, timeZone);
  return { start, end };
}

/**
 * Stays in the facility, from movements ordered by bin then time.
 * Returns [{ binId, bookingId, start, end }] with epoch ms; end is null while
 * the bin is still in.
 */
export function facilityStays(movements) {
  const stays = [];
  let open = null;
  let currentBin = null;
  for (const m of movements) {
    if (m.bin_id !== currentBin) {
      if (open) stays.push(open);
      open = null;
      currentBin = m.bin_id;
    }
    const ts = Date.parse(m.ts);
    if (!open && m.to_status === STATUS.STORED) {
      open = { binId: m.bin_id, bookingId: m.booking_id, start: ts, end: null };
    } else if (open && !IN_FACILITY.has(m.to_status)) {
      open.end = ts;
      stays.push(open);
      open = null;
    }
  }
  if (open) stays.push(open);
  return stays;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Build the month's bill lines. Pure: pass in the data, get lines back.
 * @param {object} p
 * @param {string} p.month           YYYY-MM
 * @param {Array}  p.movements       as from listMovementsBefore(monthEnd)
 * @param {Array}  p.returnOrders    as from listReturnOrdersInRange(monthStart, monthEnd)
 * @param {Array}  p.payments        payments with period = month
 * @param {number} [p.now]           epoch ms; caps open stays for the current month
 */
export function buildBill({ month, movements, returnOrders, payments, now = Date.now() }) {
  const { start, end } = monthBounds(month);
  const monthMs = end - start;
  const cap = Math.min(end, now);
  const lines = new Map();
  const line = (bookingId) => {
    if (!lines.has(bookingId)) {
      lines.set(bookingId, { bookingId, bins: new Set(), facilityMs: 0, returnOrders: 0, paid: 0 });
    }
    return lines.get(bookingId);
  };

  for (const s of facilityStays(movements)) {
    const from = Math.max(s.start, start);
    const to = Math.min(s.end ?? cap, cap);
    if (to <= from || !s.bookingId) continue;
    const l = line(s.bookingId);
    l.bins.add(s.binId);
    l.facilityMs += to - from;
  }
  for (const o of returnOrders) line(o.booking_id).returnOrders += 1;
  for (const p of payments) line(p.booking_id).paid += Number(p.amount);

  const out = [...lines.values()].map((l) => {
    const storage = round2((STORAGE_PRICE * l.facilityMs) / monthMs);
    const retrieval = round2(l.returnOrders * RETRIEVAL_FEE);
    const total = round2(storage + retrieval);
    const paid = round2(l.paid);
    return {
      bookingId: l.bookingId,
      bins: l.bins.size,
      binDays: Math.round((l.facilityMs / DAY_MS) * 10) / 10,
      storage,
      returnOrders: l.returnOrders,
      retrieval,
      total,
      paid,
      due: round2(total - paid),
    };
  });
  // Nothing to charge and nothing paid: leave it off (e.g. a stay of seconds).
  const billable = out.filter((l) => l.total !== 0 || l.paid !== 0);
  billable.sort((a, b) => b.due - a.due || a.bookingId.localeCompare(b.bookingId));

  const sum = (k) => round2(billable.reduce((a, l) => a + l[k], 0));
  return {
    month,
    prices: { storagePerBinMonth: STORAGE_PRICE, retrievalPerOrder: RETRIEVAL_FEE },
    lines: billable,
    totals: { storage: sum('storage'), retrieval: sum('retrieval'), total: sum('total'), paid: sum('paid'), due: sum('due') },
  };
}
