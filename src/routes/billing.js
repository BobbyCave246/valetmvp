// Admin billing: what to charge on Plug'n Pay for a month (see src/billing.js).

import { Router } from 'express';
import {
  listMovementsBefore,
  listReturnOrdersInRange,
  listPaymentsForPeriod,
  listBookingsWithCustomers,
} from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { buildBill, isMonth, monthBounds } from '../billing.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/billing?month=YYYY-MM
router.get('/', async (req, res) => {
  const month = String(req.query.month || '');
  if (!isMonth(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });

  const { start, end } = monthBounds(month);
  const [startIso, endIso] = [new Date(start).toISOString(), new Date(end).toISOString()];
  const [movements, returnOrders, payments] = await Promise.all([
    listMovementsBefore(endIso),
    listReturnOrdersInRange(startIso, endIso),
    listPaymentsForPeriod(month),
  ]);
  const bill = buildBill({ month, movements, returnOrders, payments });

  const details = new Map(
    (await listBookingsWithCustomers(bill.lines.map((l) => l.bookingId))).map((b) => [b.id, b])
  );
  bill.lines = bill.lines.map((l) => {
    const b = details.get(l.bookingId);
    return {
      ...l,
      // A cancelled booking is gone, but its stored time still happened.
      cancelled: !b,
      customer: b ? { name: b.name, phone: b.phone, email: b.email, address: b.address } : null,
    };
  });
  res.json({ ...bill, range: { start: startIso, end: endIso } });
});

export default router;
