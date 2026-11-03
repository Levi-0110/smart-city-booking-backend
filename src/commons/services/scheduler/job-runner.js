const crypto = require("crypto");
const bunyan = require("bunyan");

const defaultLogger = bunyan.createLogger({
  name: "job-runner.js",
  level: process.env.LOG_LEVEL,
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** How one look at a job ended. */
const RUN_OUTCOMES = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  /** Not due, or another instance holds it. */
  SKIPPED: "skipped",
});

/** The first retry after a failure; it doubles up to the interval. */
const FIRST_RETRY_MS = 30 * SECOND;

/**
 * The next slot on the job's grid after `now`. Missed slots are skipped: a
 * job that was due several times while no instance ran runs once, and its
 * run learns from `dueAt` since when it was due.
 */
function nextSlot(dueAt, everyMs, now) {
  const passed = Math.floor((now - dueAt) / everyMs) + 1;
  return dueAt + Math.max(passed, 1) * everyMs;
}

function retryDelay(failures, everyMs) {
  return Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), everyMs);
}

/**
 * Recurring background work (Pos. 4.4). The platform had none; the hourly
 * grant cleanup left with 4.4. A job is a name, an interval and an idempotent
 * run. Its state lives in a store that every instance of the API shares, so
 * the runner on each instance agrees on what is due:
 *
 * - One run at a time: a run takes a lease on the job. An instance that ticks
 *   meanwhile skips it; a lease of a crashed instance runs out on its own.
 * - Catch-up: due is due. A job whose time passed while no instance ran, runs
 *   at the next tick - once, with the time it was first due. What the gap
 *   means is the job's business: the daily reset closes every presence of an
 *   earlier business day, however many days were missed.
 * - Retry: a failed run is due again after 30 seconds, doubling up to the
 *   interval, and keeps the time it was first due.
 * - Monitoring: {@link JobRunner#status} names, per job, the last run, the
 *   last success, the last error and whether the job is overdue; every
 *   failure and every catch-up is logged.
 */
class JobRunner {
  /**
   * @param {Object} options
   * @param {Object} options.store A job store (memory-job-store, mongo-job-store)
   * @param {() => number} [options.now=Date.now] The clock, for tests
   * @param {string} [options.owner] Names this instance in leases
   * @param {Object} [options.logger] A bunyan logger
   */
  constructor({
    store,
    now = Date.now,
    owner = `${process.pid}-${crypto.randomUUID()}`,
    logger = defaultLogger,
  }) {
    this.store = store;
    this.now = now;
    this.owner = owner;
    this.logger = logger;
    this.jobs = new Map();
    this.timer = null;
    this.running = null;
  }

  /**
   * @param {Object} job
   * @param {string} job.name Unique within the instance
   * @param {number} job.everyMs Time between two runs
   * @param {(context: { dueAt: number, now: number,
   *   lastSuccessAt: number|null }) => Promise<Object|void>} job.run
   *   Idempotent: running it twice for the same moment changes nothing more
   * @param {number} [job.leaseMs] How long a run may hold the job; at least
   *   5 minutes
   * @param {number} [job.overdueAfterMs] Without a success for this long the
   *   job counts as overdue; three intervals by default
   * @returns {JobRunner} this
   */
  register({ name, everyMs, run, leaseMs, overdueAfterMs }) {
    if (!name || this.jobs.has(name)) {
      throw new Error(`job runner: a job needs a unique name (${name})`);
    }
    if (
      !(Number.isFinite(everyMs) && everyMs > 0) ||
      typeof run !== "function"
    ) {
      throw new Error(`job runner: ${name} needs an interval and a run`);
    }
    this.jobs.set(name, {
      name,
      everyMs,
      run,
      leaseMs: leaseMs ?? Math.max(5 * MINUTE, everyMs),
      overdueAfterMs: overdueAfterMs ?? 3 * everyMs,
    });
    return this;
  }

  /**
   * Looks at every job once and runs the due ones, one after the other.
   *
   * @returns {Promise<{ name: string, outcome: string, dueAt?: number,
   *   result?: Object, error?: string }[]>}
   */
  async tick() {
    const outcomes = [];
    for (const job of this.jobs.values()) {
      outcomes.push(await this._runIfDue(job));
    }
    return outcomes;
  }

  /** @private */
  async _runIfDue(job) {
    const now = this.now();
    await this.store.ensure(job.name, now);
    const state = await this.store.acquire(job.name, {
      now,
      owner: this.owner,
      leaseMs: job.leaseMs,
    });
    if (!state) {
      return { name: job.name, outcome: RUN_OUTCOMES.SKIPPED };
    }

    const dueAt = state.pendingSince ?? state.nextRunAt;
    const startedAt = this.now();
    if (startedAt - dueAt > job.everyMs) {
      this.logger.warn(
        `${job.name} catches up: due since ${new Date(dueAt).toISOString()}`,
      );
    }
    try {
      const result = await job.run({
        dueAt,
        now: startedAt,
        lastSuccessAt: state.lastSuccessAt ?? null,
      });
      const finishedAt = this.now();
      await this._release(job, {
        nextRunAt: nextSlot(state.nextRunAt, job.everyMs, finishedAt),
        pendingSince: null,
        lastRunAt: startedAt,
        lastSuccessAt: finishedAt,
        lastDurationMs: finishedAt - startedAt,
        lastError: null,
        lastResult: result ?? null,
        failures: 0,
      });
      return { name: job.name, outcome: RUN_OUTCOMES.SUCCEEDED, dueAt, result };
    } catch (err) {
      const finishedAt = this.now();
      const failures = (state.failures || 0) + 1;
      this.logger.error(
        `${job.name} failed (${failures} in a row): ${err.message}`,
      );
      await this._release(job, {
        nextRunAt: finishedAt + retryDelay(failures, job.everyMs),
        pendingSince: dueAt,
        lastRunAt: startedAt,
        lastDurationMs: finishedAt - startedAt,
        lastError: { message: err.message, at: finishedAt },
        failures,
      });
      return {
        name: job.name,
        outcome: RUN_OUTCOMES.FAILED,
        dueAt,
        error: err.message,
      };
    }
  }

  /** @private */
  async _release(job, fields) {
    const released = await this.store.release(job.name, this.owner, fields);
    if (!released) {
      this.logger.warn(
        `${job.name} outlived its lease; another instance may have run it`,
      );
    }
  }

  /**
   * The state of every registered job, for the health check and the
   * administration.
   *
   * @returns {Promise<Object[]>}
   */
  async status() {
    const now = this.now();
    const states = new Map(
      (await this.store.list()).map((state) => [state.name, state]),
    );
    return [...this.jobs.values()].map((job) => {
      const state = states.get(job.name) || {};
      const since = state.lastSuccessAt ?? state.createdAt ?? null;
      const overdue = since !== null && now - since > job.overdueAfterMs;
      return {
        name: job.name,
        everyMs: job.everyMs,
        nextRunAt: state.nextRunAt ?? null,
        lastRunAt: state.lastRunAt ?? null,
        lastSuccessAt: state.lastSuccessAt ?? null,
        lastDurationMs: state.lastDurationMs ?? null,
        lastError: state.lastError ?? null,
        failures: state.failures ?? 0,
        running: Boolean(state.leaseUntil && state.leaseUntil > now),
        overdue,
        healthy: !overdue && !(state.failures > 0),
      };
    });
  }

  /**
   * Ticks every `tickMs` until {@link JobRunner#stop}. A tick that is still
   * running is not started a second time. The timer does not keep the
   * process alive.
   *
   * @param {{ tickMs?: number }} [options]
   */
  start({ tickMs = 30 * SECOND } = {}) {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.tick()
        .catch((err) => this.logger.error(`tick failed: ${err.message}`))
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(tick, tickMs);
    this.timer.unref?.();
    tick();
  }

  /** Stops ticking and waits for a running tick to end. */
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

module.exports = { JobRunner, RUN_OUTCOMES, nextSlot, retryDelay };
