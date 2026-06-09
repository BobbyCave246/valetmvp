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
  [STATUS.RETRIEVAL_REQUESTED]: [STATUS.IN_TRANSIT_OUTBOUND],
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
export async function transitionBin(binId, toStatus, { actor, jobId = null, locationId = null, binFields = {} } = {}) {
  // Status change + movement row in ONE transaction (spec §6 invariant). The
  // begin() callback gives a transaction-scoped client; helpers take it so all
  // their statements run on the same connection inside the transaction.
  return sql.begin(async (tx) => {
    // FOR UPDATE: concurrent transitions on the same bin serialise here, so the
    // legality check below always sees the latest committed status (otherwise
    // two racers could both pass it on a stale read and double-assign).
    const bin = await getBinForUpdate(binId, tx);
    if (!bin) throw new TransitionError(`Bin ${binId} not found`);

    const fromStatus = bin.status;
    if (!isLegalTransition(fromStatus, toStatus)) {
      throw new TransitionError(
        `Illegal transition: ${fromStatus ?? '(unassigned)'} → ${toStatus} (bin ${bin.barcode})`
      );
    }

    // Apply the status change plus any caller-supplied fields atomically.
    const fields = { status: toStatus, ...binFields };

    // Location bookkeeping for the two warehouse scans.
    if (toStatus === STATUS.STORED) {
      if (!locationId) throw new TransitionError('Storing a bin requires a location');
      // Row-locked re-check INSIDE the transaction — the route's early check is
      // only a fast path, and two concurrent put-aways could otherwise both
      // claim the same slot.
      const location = await getLocationForUpdate(locationId, tx);
      if (!location) throw new TransitionError('Location not found');
      if (location.occupied) {
        throw new TransitionError(`Location ${location.barcode} is occupied`);
      }
      fields.location_id = locationId;
      await setLocationOccupied(locationId, true, tx);
    }
    if (toStatus === STATUS.IN_TRANSIT_OUTBOUND) {
      // Pulled from the rack — free the slot it was in.
      if (bin.location_id) await setLocationOccupied(bin.location_id, false, tx);
      fields.location_id = null;
    }

    if (toStatus === STATUS.RETURNED_CLOSED) {
      // Lifecycle complete — release the bin back to inventory. Clearing
      // booking/customer/photo makes it appear in listAvailableBins again;
      // the movements log preserves the full history.
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
  });
}

// Maps a job type to the bin status its bins advance to when marked Done.
export const JOB_DONE_TARGET = {
  deliver_empty: STATUS.OUT_FOR_FILLING,
  collect_full: STATUS.IN_TRANSIT_INBOUND,
  deliver_back: STATUS.RETURNED_TO_CUSTOMER,
};
