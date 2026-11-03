const crypto = require("crypto");

const { planReset } = require("./admission-reset");
const { appendTo } = require("./admission-log");

/** The name of the job in the scheduler and in its job store. */
const RESET_JOB_NAME = "admission.reset";

const MINUTE = 60 * 1000;

/** How often the job runs by default. */
const DEFAULT_EVERY_MS = 5 * MINUTE;

/**
 * The event that closes the presence of a pass now, planned against the pass
 * as it stands, or null where the presence ended in between or still counts.
 *
 * @private
 */
function closingEventOf(facility, pass, now, newId) {
  const presentSince = pass.projection?.presentSince;
  if (presentSince === null || presentSince === undefined) {
    return null;
  }
  const [planned] = planReset({
    facility,
    presences: [{ passId: pass.id, presentSince }],
    now,
  }).events;
  return planned ? { id: newId(), ...planned.event } : null;
}

/**
 * The daily reset and the maximum stay as a job of the scheduler (glossary
 * "Tagesreset", Pos. 4.3, 4.4). Each run looks at every facility with
 * admission settings, of every tenant, and closes the presences
 * {@link planReset} names: each event goes into the usage log of its pass
 * behind any scan that came first, planned anew against the pass as it then
 * stands, so a guest who left in between keeps the exit. Then the facility's
 * reset mark moves to the start of its current business day.
 *
 * A second run closes nothing more, and a run after hours or days without
 * one catches up in one go. A pass that cannot be written - three attempts
 * lost to devices - holds up neither the other passes nor the other
 * facilities; the run then fails and names it, the scheduler retries it, and
 * the reset mark of that facility stays where it was. The check never waits
 * for the job: an expired presence no longer counts anyway.
 *
 * @param {Object} options
 * @param {Object} options.store An admission store (admission-store.js)
 * @param {() => number} [options.now=Date.now] Used where the run is given no time
 * @param {() => string} [options.newId] Ids of the events
 * @param {number} [options.everyMs] How often the job runs; 5 minutes
 * @returns {{ name: string, everyMs: number, run: Function }} A job for the
 *   `JobRunner`
 */
function createAdmissionResetJob({
  store,
  now = Date.now,
  newId = () => crypto.randomUUID(),
  everyMs = DEFAULT_EVERY_MS,
}) {
  async function run({ now: at = now() } = {}) {
    const summary = { facilities: 0, closed: 0, failed: 0 };
    const problems = [];
    for (const facility of await store.allFacilitySettings()) {
      const { tenantId, facilityId } = facility;
      summary.facilities += 1;
      const presences = await store.openPresences(tenantId, facilityId);
      const plan = planReset({ facility, presences, now: at });
      let failed = 0;
      for (const { passId } of plan.events) {
        try {
          const event = await appendTo(store, tenantId, passId, (pass) =>
            closingEventOf(facility, pass, at, newId),
          );
          if (event) {
            summary.closed += 1;
          }
        } catch (err) {
          failed += 1;
          problems.push(`${tenantId}/${facilityId}/${passId}: ${err.message}`);
        }
      }
      summary.failed += failed;
      if (plan.resetDue && failed === 0) {
        await store.markReset(tenantId, facilityId, plan.resetUpTo);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `admission reset: ${problems.length} presence(s) not closed: ${problems.slice(0, 5).join("; ")}`,
      );
    }
    return summary;
  }

  return { name: RESET_JOB_NAME, everyMs, run };
}

module.exports = { createAdmissionResetJob, RESET_JOB_NAME, DEFAULT_EVERY_MS };
