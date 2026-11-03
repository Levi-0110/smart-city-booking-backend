/**
 * The state of one recurring job of the scheduler (services/scheduler): when
 * it is due, who holds it and how its last run went. One row per job name,
 * shared by all instances of the API. Times are epoch milliseconds, as the
 * runner computes with them.
 */
const jobStateSchemaDefinition = {
  name: { type: String, required: true, unique: true },
  nextRunAt: { type: Number, required: true },
  createdAt: { type: Number, required: true },
  /** First due time of a run that has not succeeded yet (catch-up, retry). */
  pendingSince: { type: Number, default: null },
  leaseOwner: { type: String, default: null },
  leaseUntil: { type: Number, default: null },
  lastRunAt: { type: Number, default: null },
  lastSuccessAt: { type: Number, default: null },
  lastDurationMs: { type: Number, default: null },
  /** `{ message, at }` of the last failed run, null after a success. */
  lastError: { type: Object, default: null },
  /** What the last successful run reported, e.g. how many passes it reset. */
  lastResult: { type: Object, default: null },
  failures: { type: Number, default: 0 },
};

module.exports = jobStateSchemaDefinition;
