// Job lifecycle module — the single seam for scheduling, syncing, and
// completing Jobs (Deliver empty, Collect full, Deliver back). Routes call
// these verbs; Bin status changes go through transitions.js.

import {
  sql,
  getBooking,
  getBin,
  getBinForUpdate,
  listBinsForBooking,
  listJobs,
  listJobsForBooking,
  createJob,
  setJobBinIds,
  setJobSchedule,
  setJobStatus,
  setBinFields,
  insertMovement,
  deleteJobsForBooking,
  deleteBooking,
  deleteJob,
} from './db.js';
import { transitionBinInTx, isLegalTransition, STATUS } from './transitions.js';
import { sendJobDoneNotifications } from './notify.js';

const JOB_DONE_TARGET = {
  deliver_empty: STATUS.OUT_FOR_FILLING,
  collect_full: STATUS.IN_TRANSIT_INBOUND,
  deliver_back: STATUS.RETURNED_TO_CUSTOMER,
};

const COLLECT_FULL_SCHEDULABLE = new Set([
  STATUS.OUT_FOR_FILLING,
  STATUS.RETURNED_TO_CUSTOMER,
]);

export class JobError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'JobError';
    this.status = status;
  }
}

function err409(message) {
  return new JobError(message, 409);
}

function err404(message) {
  return new JobError(message, 404);
}

function parseBinIds(job) {
  try {
    return JSON.parse(job.bin_ids) || [];
  } catch {
    return [];
  }
}

async function getJobInTx(jobId, tx) {
  const rows = await tx`SELECT * FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  return rows[0];
}

async function reconcileCollectFullJob(bookingId, removedBinIds, tx) {
  const collectJob = (await listJobsForBooking(bookingId, tx)).find(
    (j) => j.type === 'collect_full' && j.status === 'Scheduled'
  );
  if (!collectJob) return;

  const remaining = parseBinIds(collectJob).filter((id) => !removedBinIds.includes(id));
  if (remaining.length === 0) {
    await deleteJob(collectJob.id, tx);
  } else {
    await setJobBinIds(collectJob.id, remaining, tx);
  }
}

async function reconcileDeliverBackJob(bookingId, removedBinIds, tx) {
  const deliverBack = (await listJobsForBooking(bookingId, tx)).find(
    (j) => j.type === 'deliver_back' && j.status === 'Scheduled'
  );
  if (!deliverBack) return;

  const remaining = parseBinIds(deliverBack).filter((id) => !removedBinIds.includes(id));
  if (remaining.length === 0) {
    await deleteJob(deliverBack.id, tx);
  } else {
    await setJobBinIds(deliverBack.id, remaining, tx);
  }
}

/**
 * Create a Deliver empty Job if the delivery window still has capacity.
 * Uses an advisory lock so concurrent bookings cannot overshoot the cap.
 */
export async function createDeliverEmpty(bookingId, { date, slot, capacity }) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${date}|${slot}`}))`;
    const rows = await tx`
      SELECT COUNT(*)::int AS n FROM jobs
      WHERE type = 'deliver_empty' AND scheduled_date = ${date} AND scheduled_slot = ${slot}`;
    if (rows[0].n >= capacity) {
      throw err409('That delivery window is full — please pick another');
    }
    return createJob(
      {
        bookingId,
        type: 'deliver_empty',
        scheduledDate: date,
        scheduledSlot: slot,
        binIds: [],
      },
      tx
    );
  });
}

/**
 * Schedule (or reschedule) a Collect full Job. At most one Scheduled Collect
 * full per Booking — new binIds merge into the existing Job's pick list.
 */
export async function scheduleCollection(bookingId, { date, slot = null, binIds }) {
  if (!Array.isArray(binIds) || binIds.length === 0) {
    throw err409('binIds array is required');
  }
  if (new Set(binIds).size !== binIds.length) {
    throw err409('Duplicate binIds in request');
  }

  const booking = await getBooking(bookingId);
  if (!booking) throw err404('Booking not found');

  const sortedBinIds = [...binIds].sort();
  const bookingBins = await listBinsForBooking(bookingId);
  const byId = new Map(bookingBins.map((b) => [b.id, b]));

  for (const id of sortedBinIds) {
    const bin = byId.get(id);
    if (!bin) throw err409(`Bin ${id} does not belong to this booking`);
    if (!COLLECT_FULL_SCHEDULABLE.has(bin.status)) {
      throw err409(
        `Bin ${bin.barcode} cannot be scheduled for collection (status: ${bin.status ?? 'unassigned'})`
      );
    }
  }

  return sql.begin(async (tx) => {
    const existing = (await listJobsForBooking(bookingId, tx)).find(
      (j) => j.type === 'collect_full' && j.status === 'Scheduled'
    );

    if (existing) {
      const merged = [...new Set([...parseBinIds(existing), ...sortedBinIds])];
      await setJobSchedule(existing.id, date, slot, tx);
      await setJobBinIds(existing.id, merged, tx);
      return { ...existing, scheduled_date: date, scheduled_slot: slot, bin_ids: JSON.stringify(merged) };
    }

    return createJob(
      {
        bookingId,
        type: 'collect_full',
        scheduledDate: date,
        scheduledSlot: slot,
        binIds: sortedBinIds,
      },
      tx
    );
  });
}

/**
 * Customer retrieval request: transition bins to Retrieval requested and
 * find-or-create a single Scheduled Deliver back Job for the Booking.
 */
export async function requestRetrieval(bookingId, { binIds, date, slot = null }) {
  if (!Array.isArray(binIds) || binIds.length === 0) {
    throw err409('binIds array is required');
  }
  if (new Set(binIds).size !== binIds.length) {
    throw err409('Duplicate binIds in request');
  }

  const booking = await getBooking(bookingId);
  if (!booking) throw err404('Booking not found');

  const sortedBinIds = [...binIds].sort();
  const bookingBins = await listBinsForBooking(bookingId);
  const byId = new Map(bookingBins.map((b) => [b.id, b]));

  for (const id of sortedBinIds) {
    const bin = byId.get(id);
    if (!bin) throw err409(`Bin ${id} does not belong to this booking`);
    if (bin.status !== STATUS.STORED) {
      throw err409(`Bin ${bin.barcode} is not stored (status: ${bin.status ?? 'unassigned'})`);
    }
  }

  return sql.begin(async (tx) => {
    for (const id of sortedBinIds) {
      await transitionBinInTx(tx, id, STATUS.RETRIEVAL_REQUESTED, { actor: 'customer' });
    }

    const retrievalBinIds = (await listBinsForBooking(bookingId, tx))
      .filter((b) => b.status === STATUS.RETRIEVAL_REQUESTED)
      .map((b) => b.id);

    const existing = (await listJobsForBooking(bookingId, tx)).find(
      (j) => j.type === 'deliver_back' && j.status === 'Scheduled'
    );

    if (existing) {
      await setJobSchedule(existing.id, date, slot, tx);
      await setJobBinIds(existing.id, retrievalBinIds, tx);
      return { ...existing, scheduled_date: date, scheduled_slot: slot, bin_ids: JSON.stringify(retrievalBinIds) };
    }

    return createJob(
      {
        bookingId,
        type: 'deliver_back',
        scheduledDate: date,
        scheduledSlot: slot,
        binIds: retrievalBinIds,
      },
      tx
    );
  });
}

/**
 * Cancel an active retrieval: bins return to Stored and the Deliver back Job
 * is updated or removed. Partial cancel supported (multi-bin bookings).
 */
export async function cancelRetrieval(bookingId, { binIds, actor = 'customer' }) {
  if (!Array.isArray(binIds) || binIds.length === 0) {
    throw err409('binIds array is required');
  }
  if (new Set(binIds).size !== binIds.length) {
    throw err409('Duplicate binIds in request');
  }

  const booking = await getBooking(bookingId);
  if (!booking) throw err404('Booking not found');

  const sortedBinIds = [...binIds].sort();
  const bookingBins = await listBinsForBooking(bookingId);
  const byId = new Map(bookingBins.map((b) => [b.id, b]));

  for (const id of sortedBinIds) {
    const bin = byId.get(id);
    if (!bin) throw err409(`Bin ${id} does not belong to this booking`);
    if (bin.status !== STATUS.RETRIEVAL_REQUESTED) {
      throw err409(
        `Bin ${bin.barcode} is not awaiting retrieval (status: ${bin.status ?? 'unassigned'})`
      );
    }
  }

  return sql.begin(async (tx) => {
    const advanced = [];
    for (const id of sortedBinIds) {
      const bin = byId.get(id);
      advanced.push(
        await transitionBinInTx(tx, id, STATUS.STORED, {
          actor,
          locationId: bin.location_id,
        })
      );
    }
    await reconcileDeliverBackJob(bookingId, sortedBinIds, tx);
    return { advanced };
  });
}

/**
 * Cancel a Booking that has no bins assigned yet. Deletes the Booking and its
 * Jobs (including the Scheduled Deliver empty), freeing delivery capacity.
 */
export async function cancelUnassignedBooking(bookingId) {
  return sql.begin(async (tx) => {
    const rows = await tx`SELECT * FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
    const booking = rows[0];
    if (!booking) throw err404('Booking not found');

    const bins = await tx`SELECT * FROM bins WHERE booking_id = ${bookingId} FOR UPDATE`;
    if (bins.length > 0) {
      throw err409(
        'Cannot cancel — bins are already assigned to this booking. Use full cancel to release them.'
      );
    }

    await deleteJobsForBooking(bookingId, tx);
    await deleteBooking(bookingId, tx);
    return { ok: true };
  });
}

/**
 * Mark an Out for filling bin as no-show: release to unassigned inventory and
 * reconcile any Scheduled Collect full Job.
 */
export async function markBinNoShow(binId, { actor = 'admin' } = {}) {
  return sql.begin(async (tx) => {
    const bin = await getBinForUpdate(binId, tx);
    if (!bin) throw err404('Bin not found');
    if (bin.status !== STATUS.OUT_FOR_FILLING) {
      throw err409(`Only bins "${STATUS.OUT_FOR_FILLING}" can be marked as no-show`);
    }

    const bookingId = bin.booking_id;

    await setBinFields(
      binId,
      { status: null, booking_id: null, customer_id: null, photo_ref: null, location_id: null },
      tx
    );
    await insertMovement(
      { binId, fromStatus: STATUS.OUT_FOR_FILLING, toStatus: null, actor },
      tx
    );

    if (bookingId) {
      await reconcileCollectFullJob(bookingId, [binId], tx);
    }

    return { bin: await getBin(binId, tx), bookingId };
  });
}

/** Recompute the Scheduled Deliver empty Job's bin list from Assigned bins. */
export async function syncDeliverEmptyBins(bookingId) {
  const job = (await listJobs()).find(
    (j) => j.booking_id === bookingId && j.type === 'deliver_empty' && j.status === 'Scheduled'
  );
  if (!job) return;

  const binIds = (await listBinsForBooking(bookingId))
    .filter((b) => b.status === STATUS.ASSIGNED)
    .map((b) => b.id);
  await setJobBinIds(job.id, binIds);
}

/**
 * Mark a Job Done and advance all its bins — all-or-nothing in one transaction.
 */
export async function completeJob(jobId, { actor = 'admin' } = {}) {
  const result = await sql.begin(async (tx) => {
    const job = await getJobInTx(jobId, tx);
    if (!job) throw err404('Job not found');
    if (job.status === 'Done') throw err409('Job is already Done');

    const target = JOB_DONE_TARGET[job.type];
    if (!target) throw new JobError(`Unknown job type: ${job.type}`, 400);

    const binIds = parseBinIds(job);
    if (binIds.length === 0) {
      throw err409('Job has no bins assigned yet — assign bins before marking done');
    }

    const bins = await Promise.all(binIds.map((id) => getBinForUpdate(id, tx)));
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      if (!bin) {
        throw err409('Job references a bin that no longer exists');
      }
      if (!isLegalTransition(bin.status, target)) {
        throw err409(
          `Bin ${bin.barcode} is "${bin.status ?? 'unassigned'}" and cannot move to "${target}" — job out of sync`
        );
      }
    }

    const advanced = [];
    for (const binId of binIds) {
      advanced.push(await transitionBinInTx(tx, binId, target, { actor, jobId: job.id }));
    }

    await setJobStatus(job.id, 'Done', tx);
    return { job: { ...job, status: 'Done' }, advanced, bookingId: job.booking_id };
  });

  void sendJobDoneNotifications({ job: result.job, bookingId: result.bookingId });
  return result;
}
