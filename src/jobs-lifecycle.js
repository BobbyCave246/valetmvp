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
  setJobScheduledDate,
  setJobSchedule,
  setJobStatus,
} from './db.js';
import { transitionBinInTx, isLegalTransition, STATUS } from './transitions.js';

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
export async function requestRetrieval(bookingId, { binIds, date }) {
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
      await setJobScheduledDate(existing.id, date, tx);
      await setJobBinIds(existing.id, retrievalBinIds, tx);
      return { ...existing, scheduled_date: date, bin_ids: JSON.stringify(retrievalBinIds) };
    }

    return createJob(
      {
        bookingId,
        type: 'deliver_back',
        scheduledDate: date,
        binIds: retrievalBinIds,
      },
      tx
    );
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
  return sql.begin(async (tx) => {
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
    return { job: { ...job, status: 'Done' }, advanced };
  });
}
