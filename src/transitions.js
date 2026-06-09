// The bin-status state machine — the heart of the system.
//
// transitionBin() is the ONLY function permitted to change bins.status.
// It rejects any move not in the legal table and writes a movements row in
// the SAME transaction as the status change (spec §6 invariant). Routes never
// touch bins.status or movements directly.

import {
  tx,
  getBin,
  setBinFields,
  insertMovement,
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
  [STATUS.RETURNED_CLOSED]: [], // terminal
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
export function transitionBin(binId, toStatus, { actor, jobId = null, locationId = null, binFields = {} } = {}) {
  return tx(() => {
    const bin = getBin(binId);
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
      fields.location_id = locationId;
      setLocationOccupied(locationId, true);
    }
    if (toStatus === STATUS.IN_TRANSIT_OUTBOUND) {
      // Pulled from the rack — free the slot it was in.
      if (bin.location_id) setLocationOccupied(bin.location_id, false);
      fields.location_id = null;
    }

    setBinFields(binId, fields);

    insertMovement({
      binId,
      fromStatus,
      toStatus,
      locationId: toStatus === STATUS.STORED ? locationId : null,
      actor,
      jobId,
    });

    return getBin(binId);
  });
}

// Maps a job type to the bin status its bins advance to when marked Done.
export const JOB_DONE_TARGET = {
  deliver_empty: STATUS.OUT_FOR_FILLING,
  collect_full: STATUS.IN_TRANSIT_INBOUND,
  deliver_back: STATUS.RETURNED_TO_CUSTOMER,
};
