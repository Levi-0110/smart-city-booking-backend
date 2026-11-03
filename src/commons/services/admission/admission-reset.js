const {
  USAGE_EVENTS,
  ACTOR_SOURCES,
  businessDayStart,
} = require("./admission-state");

const MINUTE = 60 * 1000;

/**
 * The daily reset of a facility (glossary "Tagesreset", Pos. 4.3, 4.4) as a
 * plan: which open presences a run closes, and with which event. Pure; the
 * scheduled job loads the open presences, appends the events and moves the
 * facility's reset mark.
 *
 * - The reset closes every presence that began before the current business
 *   day with a `day_reset` event. It cannot be switched off and does not
 *   depend on exit scans.
 * - The maximum stay closes every presence that has lasted longer with an
 *   `auto_exit` event, whenever the job runs, not only at the reset time;
 *   whichever of the two ended a presence first names its event.
 *
 * Each event is written at the time of the run and names in `closedAt` when
 * the presence ended in fact, so the log stays in order even when a run
 * comes late. A second run finds nothing left to close, and a run after days
 * without one catches up in one go. The check never waits for either: an
 * expired presence no longer counts from the moment it ends
 * (admission-state `isPresent`).
 *
 * @param {Object} input
 * @param {{ resetTime?: string, zone?: string, maxStayMinutes?: number,
 *   lastResetAt?: number|null }} input.facility `lastResetAt`: the business
 *   day start up to which the last run reset
 * @param {{ passId: string, presentSince: number }[]} input.presences The
 *   open presences of the facility, as stored
 * @param {number} input.now Epoch ms
 * @returns {{ resetDue: boolean, resetUpTo: number,
 *   events: { passId: string, event: Object }[] }}
 */
function planReset({ facility, presences, now }) {
  const dayStart = businessDayStart(now, facility).toMillis();
  const maxStay =
    facility.maxStayMinutes > 0 ? facility.maxStayMinutes * MINUTE : null;
  const actor = { source: ACTOR_SOURCES.SCHEDULER };
  const events = [];

  for (const { passId, presentSince } of presences) {
    if (presentSince === null || presentSince === undefined) continue;
    const stayEnds = maxStay === null ? Infinity : presentSince + maxStay;
    const dayEnds = presentSince < dayStart ? dayStart : Infinity;
    const closedAt = Math.min(stayEnds, dayEnds);
    if (closedAt > now) continue;
    events.push({
      passId,
      event: {
        type:
          closedAt === stayEnds
            ? USAGE_EVENTS.AUTO_EXIT
            : USAGE_EVENTS.DAY_RESET,
        at: now,
        closedAt,
        actor,
      },
    });
  }

  return {
    resetDue: !(facility.lastResetAt >= dayStart),
    resetUpTo: dayStart,
    events,
  };
}

module.exports = { planReset };
