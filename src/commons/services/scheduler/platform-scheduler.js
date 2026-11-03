const { JobRunner } = require("./job-runner");
const { MongoJobStore } = require("./job-stores");

const MINUTE = 60 * 1000;

/**
 * The minutes between two runs of the daily reset of admission
 * (`ADMISSION_RESET_INTERVAL_MINUTES`, 1 to 60, default 5).
 */
function admissionResetEveryMs(env = process.env) {
  const minutes = Number(env.ADMISSION_RESET_INTERVAL_MINUTES);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
    ? minutes * MINUTE
    : 5 * MINUTE;
}

/** The jobs of the platform, each over the stores of the API. */
function platformJobs(env = process.env) {
  const { MongoAdmissionStore } = require("../admission/admission-store");
  const {
    createAdmissionResetJob,
  } = require("../admission/admission-reset-job");
  return [
    createAdmissionResetJob({
      store: new MongoAdmissionStore(),
      everyMs: admissionResetEveryMs(env),
    }),
  ];
}

/**
 * Starts the scheduler of this instance (docs/admission.md, "Scheduler"):
 * one `JobRunner` over the job store all instances share, with the jobs of
 * the platform. Called once the migrations have run. Every instance may run
 * it; a lease keeps a job to one instance at a time. `SCHEDULER_ENABLED=false`
 * keeps an instance out - the jobs then run on the others, and the check at
 * the entrance never waits for them.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env]
 * @param {Object} [options.store] The job store; MongoDB by default
 * @param {Object[]} [options.jobs] The jobs; the platform's by default
 * @param {number} [options.tickMs] How often the runner looks for due jobs
 * @param {Object} [options.logger] A bunyan logger
 * @returns {JobRunner|null} The running scheduler, null where it is switched off
 */
function startPlatformScheduler({
  env = process.env,
  store,
  jobs,
  tickMs,
  logger,
} = {}) {
  if (String(env.SCHEDULER_ENABLED ?? "true").toLowerCase() === "false") {
    return null;
  }
  const runner = new JobRunner({
    store: store ?? new MongoJobStore(),
    ...(logger ? { logger } : {}),
  });
  for (const job of jobs ?? platformJobs(env)) {
    runner.register(job);
  }
  runner.start(tickMs ? { tickMs } : {});
  return runner;
}

module.exports = {
  startPlatformScheduler,
  platformJobs,
  admissionResetEveryMs,
};
