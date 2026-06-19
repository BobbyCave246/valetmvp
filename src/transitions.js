// The bin-status state machine — the heart of the system.
//
// transitionBin() is the ONLY function permitted to change bins.status.
// It rejects any move not in the legal table and writes a movements row in
// the SAME transaction as the status change (spec §6 invariant). Routes never
// touch bins.status or movements directly.

import {
  sql,
  getBin,
  getBinForUpdate,
  setBinFields,
  insertMovement,
  getLocationForUpdate,
  setLocationOccupied,
  getBooking,
  listBinsForBookingForUpdate,
  detachMovementsFromBookingJobs,
  deleteJobsForBooking,
  deleteBooking,
} from './db.js';

// The seven bin statuses (plus the implicit UNASSIGNED start state).
export const STATUS = {
  UNASSIGNED: null,
  ASSIGNED: 'Assigned',
  OUT_FOR_FILLING: 'Out for filling',
  IN_TRANSIT_INBOUND: 'In transit (inbound)',
  STORED: 'Stored',
  RETRIEVAL_REQUESTED: 'Retrieval requested',
  IN_TRANSIT_OUTBOUND: 'In transit (outbound)',
  RETURNED_TO_CUSTOMER: 'Returned to customer',
  RETURNED_CLOSED: 'Returned / closed',
};

// Legal transitions. Key is the current status (use '(unassigned)' for null).
// Value is the set of statuses it may move to. Anything not listed is rejected.
const LEGAL = {
  '(unassigned)': [STATUS.ASSIGNED],
  [STATUS.ASSIGNED]: [STATUS.OUT_FOR_FILLING],
  [STATUS.OUT_FOR_FILLING]: [STATUS.IN_TRANSIT_INBOUND],
  [STATUS.IN_TRANSIT_INBOUND]: [STATUS.STORED],
  [STATUS.STORED]: [STATUS.RETRIEVAL_REQUESTED],
  [STATUS.RETRIEVAL_REQUESTED]: [STATUS.IN_TRANSIT_OUTBOUND, STATUS.STORED],
  [STATUS.IN_TRANSIT_OUTBOUND]: [STATUS.RETURNED_TO_CUSTOMER],
  // Returned to customer can either be re-stored (already filled, so it goes
  // straight back to In transit (inbound) — NOT through Out for filling) or
  // closed out for good.
  [STATUS.RETURNED_TO_CUSTOMER]: [STATUS.IN_TRANSIT_INBOUND, STATUS.RETURNED_CLOSED],
  // A closed bin is physically back in the warehouse and re-enters inventory:
  // it may start a NEW lifecycle by being assigned to another booking. Its
  // movement log carries the full chain of custody across lifecycles.
  [STATUS.RETURNED_CLOSED]: [STATUS.ASSIGNED],
};

function key(status) {
  return status == null ? '(unassigned)' : status;
}

export function isLegalTransition(fromStatus, toStatus) {
  const allowed = LEGAL[key(fromStatus)] || [];
  return allowed.includes(toStatus);
}

export class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionError';
    this.status = 422; // unprocessable — illegal state move
  }
}

/**
 * The single gateway for changing a bin's status.
 * @param {string} binId
 * @param {string} toStatus  one of STATUS.*
 * @param {object} opts
 * @param {'customer'|'admin'} opts.actor
 * @param {string|null} [opts.jobId]
 * @param {string|null} [opts.locationId]  set when storing; cleared when scanning out
 * @param {object} [opts.binFields]        extra bins.* fields to set atomically
 * @returns the updated bin row
 */
/**
 * Transition a bin inside an existing transaction (for batch routes).
 * Caller must provide a transaction-scoped client from sql.begin().
 */
export async function transitionBinInTx(
  tx,
  binId,
  toStatus,
  { actor, jobId = null, locationId = null, binFields = {} } = {}
) {
  const bin = await getBinForUpdate(binId, tx);
  if (!bin) throw new TransitionError(`Bin ${binId} not found`);

  const fromStatus = bin.status;
  if (!isLegalTransition(fromStatus, toStatus)) {
    throw new TransitionError(
      `Illegal transition: ${fromStatus ?? '(unassigned)'} → ${toStatus} (bin ${bin.barcode})`
    );
  }

  const fields = { status: toStatus, ...binFields };

  if (toStatus === STATUS.STORED) {
    // Cancel retrieval: bin still holds its rack slot — restore status only.
    if (fromStatus === STATUS.RETRIEVAL_REQUESTED && bin.location_id) {
      fields.location_id = bin.location_id;
    } else {
      if (!locationId) throw new TransitionError('Storing a bin requires a location');
      const location = await getLocationForUpdate(locationId, tx);
      if (!location) throw new TransitionError('Location not found');
      if (location.occupied) {
        throw new TransitionError(`Location ${location.barcode} is occupied`);
      }
      fields.location_id = locationId;
      await setLocationOccupied(locationId, true, tx);
    }
  }
  if (toStatus === STATUS.IN_TRANSIT_OUTBOUND) {
    if (bin.location_id) await setLocationOccupied(bin.location_id, false, tx);
    fields.location_id = null;
  }

  if (toStatus === STATUS.RETURNED_CLOSED) {
    fields.booking_id = null;
    fields.customer_id = null;
    fields.photo_ref = null;
  }

  await setBinFields(binId, fields, tx);

  await insertMovement(
    {
      binId,
      fromStatus,
      toStatus,
      locationId: toStatus === STATUS.STORED ? locationId : null,
      actor,
      jobId,
    },
    tx
  );

  return getBin(binId, tx);
}

export async function transitionBin(binId, toStatus, opts = {}) {
  return sql.begin(async (tx) => transitionBinInTx(tx, binId, toStatus, opts));
}

/**
 * Cancel a booking — the one sanctioned escape hatch from the legal-transition
 * table (alongside the demo reset). In a single transaction it:
 *   1. releases the booking's bins back to inventory (status → unassigned,
 *      customer/photo cleared), freeing any rack slot a stored bin occupied;
 *   2. logs a movement per bin (to_status NULL = released), so the chain of
 *      custody records the cancellation instead of losing it;
 *   3. detaches old movements from the booking's jobs, then deletes the jobs
 *      and the booking row itself.
 * The §6 invariant holds: every bin change writes its movement in the SAME
 * transaction. Customers are kept (they may have other bookings).
 * @returns {{ releasedBins: number, freedLocations: number }}
 */
export async function cancelBooking(bookingId, { actor = 'admin' } = {}) {
  return sql.begin(async (tx) => {
    const booking = await getBooking(bookingId);
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

    const bins = await listBinsForBookingForUpdate(bookingId, tx);
    let freedLocations = 0;
    for (const bin of bins) {
      if (bin.location_id) {
        await setLocationOccupied(bin.location_id, false, tx);
        freedLocations++;
      }
      await setBinFields(
        bin.id,
        { status: null, booking_id: null, customer_id: null, photo_ref: null, location_id: null },
        tx
      );
      await insertMovement(
        { binId: bin.id, fromStatus: bin.status, toStatus: null, actor },
        tx
      );
    }

    await detachMovementsFromBookingJobs(bookingId, tx);
    await deleteJobsForBooking(bookingId, tx);
    await deleteBooking(bookingId, tx);

    return { releasedBins: bins.length, freedLocations };
  });
}

