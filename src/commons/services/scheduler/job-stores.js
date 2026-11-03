/**
 * Where the job runner keeps the state of each job. Both stores implement the
 * same four calls; `acquire` and `release` are conditional, so that of all
 * instances only the one holding the lease writes the result of a run.
 *
 * - `ensure(name, now)`: creates the job, due now, unless it exists.
 * - `acquire(name, { now, owner, leaseMs })`: the job's state if it is due
 *   and free, and leased to `owner` from now on; null otherwise.
 * - `release(name, owner, fields)`: writes the fields and frees the job, if
 *   `owner` still holds it; tells whether it did.
 * - `list()`: the state of all jobs.
 */

function freshState(name, now) {
  return {
    name,
    nextRunAt: now,
    createdAt: now,
    pendingSince: null,
    leaseOwner: null,
    leaseUntil: null,
    failures: 0,
  };
}

/** One process, no persistence: for tests and a single local instance. */
class MemoryJobStore {
  constructor() {
    this.jobs = new Map();
  }

  async ensure(name, now) {
    if (!this.jobs.has(name)) {
      this.jobs.set(name, freshState(name, now));
    }
  }

  async acquire(name, { now, owner, leaseMs }) {
    const job = this.jobs.get(name);
    if (!job || job.nextRunAt > now) return null;
    if (job.leaseUntil !== null && job.leaseUntil > now) return null;
    job.leaseOwner = owner;
    job.leaseUntil = now + leaseMs;
    return { ...job };
  }

  async release(name, owner, fields) {
    const job = this.jobs.get(name);
    if (!job || job.leaseOwner !== owner) return false;
    Object.assign(job, fields, { leaseOwner: null, leaseUntil: null });
    return true;
  }

  async list() {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }
}

const DUPLICATE_KEY = 11000;

/**
 * Shared by all instances through MongoDB. Lease and release are single
 * conditional updates, so two instances can never both hold a job.
 */
class MongoJobStore {
  /**
   * @param {import("mongoose").Model} [model] The job state model
   */
  constructor(model = require("../../data-managers/models/jobStateModel")) {
    this.model = model;
  }

  async ensure(name, now) {
    try {
      await this.model.updateOne(
        { name },
        { $setOnInsert: freshState(name, now) },
        { upsert: true },
      );
    } catch (err) {
      // Two instances starting at once: the other one created it.
      if (err?.code !== DUPLICATE_KEY) throw err;
    }
  }

  async acquire(name, { now, owner, leaseMs }) {
    return this.model
      .findOneAndUpdate(
        {
          name,
          nextRunAt: { $lte: now },
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
        },
        { $set: { leaseOwner: owner, leaseUntil: now + leaseMs } },
        { new: true },
      )
      .lean();
  }

  async release(name, owner, fields) {
    const result = await this.model.updateOne(
      { name, leaseOwner: owner },
      { $set: { ...fields, leaseOwner: null, leaseUntil: null } },
    );
    return result.matchedCount === 1;
  }

  async list() {
    return this.model.find({}).lean();
  }
}

module.exports = { MemoryJobStore, MongoJobStore };
