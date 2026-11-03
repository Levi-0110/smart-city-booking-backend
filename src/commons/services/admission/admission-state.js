const { DateTime } = require("luxon");
const { USAGE, DEFAULT_ZONE } = require("./admission-terms");
const { VOID_CAUSES } = require("./admission-reasons");

/**
 * The state model of a pass (Pos. 1.2). Three layers, each derived from the
 * one before:
 *
 * 1. The usage log (glossary "Nutzungsprotokoll") is the source of truth:
 *    entries, exits, resets and every correction, with time and account.
 * 2. The projection is what the log adds up to - presence, used days, quota,
 *    block and void - and is stored with the pass so a check reads one
 *    document. {@link replay} rebuilds it from the log at any time.
 * 3. The state is what the projection means at a given moment
 *    ({@link stateOf}). It is computed, never stored: time alone moves a pass
 *    from present to absent when its business day ends or its maximum stay
 *    is over, and from valid to expired. A daily reset that has not run yet,
 *    or a scheduler that is down, therefore never keeps a guest out
 *    (Pos. 4.3, 4.4); the reset only writes down in the log what time has
 *    already decided.
 *
 * A business day starts at the facility's reset time, not at midnight, so a
 * visit that runs past midnight counts as one day.
 */

/** The states of a pass; LV terms in brackets. */
const ADMISSION_STATES = Object.freeze({
  /** Issued, never entered (ausgestellt). */
  ISSUED: "issued",
  /** Checked in and not out, within the business day (derzeit anwesend). */
  PRESENT: "present",
  /** Entered before, usable, currently not inside (nicht anwesend). */
  ABSENT: "absent",
  /** Single entry used, or quota at zero after its last day (verbraucht). */
  CONSUMED: "consumed",
  /** The validity has ended (abgelaufen). */
  EXPIRED: "expired",
  /** Blocked by the administration (gesperrt). */
  BLOCKED: "blocked",
  /** Booking cancelled, rejected or withdrawn, or voided (ungültig). */
  VOID: "void",
});

const STATE_LABELS_DE = Object.freeze({
  [ADMISSION_STATES.ISSUED]: "Ausgestellt",
  [ADMISSION_STATES.PRESENT]: "Derzeit anwesend",
  [ADMISSION_STATES.ABSENT]: "Nicht anwesend",
  [ADMISSION_STATES.CONSUMED]: "Verbraucht",
  [ADMISSION_STATES.EXPIRED]: "Abgelaufen",
  [ADMISSION_STATES.BLOCKED]: "Gesperrt",
  [ADMISSION_STATES.VOID]: "Ungültig",
});

/** What the usage log records. */
const USAGE_EVENTS = Object.freeze({
  /** A granted entry; consumes the business day if it is the first. */
  ENTRY: "entry",
  /** An exit scan. */
  EXIT: "exit",
  /** The maximum stay of the facility was over (Pos. 4.3). */
  AUTO_EXIT: "auto_exit",
  /** The daily reset closed an open presence (Pos. 4.4). */
  DAY_RESET: "day_reset",
  /** Corrections by the administration (Pos. 6.2). */
  RESET_PRESENCE: "reset_presence",
  UNDO_ENTRY: "undo_entry",
  BLOCK: "block",
  UNBLOCK: "unblock",
  /** Booking cancelled, rejected or withdrawn, or voided by hand (Pos. 6.4). */
  VOID: "void",
  /** Booking reinstated, or a manual void taken back. */
  RESTORE: "restore",
  /** The pass got a new code; the old one stops working (Pos. 6.2). */
  REISSUE: "reissue",
});

/** Who wrote an event: `actor.source`, with `userId` or `deviceId`. */
const ACTOR_SOURCES = Object.freeze({
  DEVICE: "device",
  ADMINISTRATION: "administration",
  BOOKING: "booking",
  SCHEDULER: "scheduler",
});

/**
 * The events only a person triggers, in the administration. Each of them, and
 * every other event written there, needs the account and a reason (Pos. 6.2),
 * checked by {@link problemsOfEvent}.
 */
const CORRECTION_EVENTS = Object.freeze([
  USAGE_EVENTS.RESET_PRESENCE,
  USAGE_EVENTS.UNDO_ENTRY,
  USAGE_EVENTS.BLOCK,
  USAGE_EVENTS.UNBLOCK,
  USAGE_EVENTS.REISSUE,
]);

const MINUTE = 60 * 1000;

/**
 * The start of the business day `now` falls in: the latest reset time of the
 * facility at or before `now`, in its time zone.
 *
 * @param {number} now Epoch ms
 * @param {{ resetTime?: string, zone?: string }} facility `resetTime` as `HH:mm`
 * @returns {DateTime}
 */
function businessDayStart(now, facility = {}) {
  const zone = facility.zone || DEFAULT_ZONE;
  const [hour, minute] = (facility.resetTime || "03:00").split(":").map(Number);
  const local = DateTime.fromMillis(now, { zone });
  const today = local.set({ hour, minute, second: 0, millisecond: 0 });
  return today > local ? today.minus({ days: 1 }) : today;
}

/**
 * The business day `now` falls in, as the usage log names it.
 *
 * @param {number} now Epoch ms
 * @param {Object} facility See {@link businessDayStart}
 * @returns {string} `YYYY-MM-DD`
 */
function businessDayOf(now, facility) {
  return businessDayStart(now, facility).toISODate();
}

/**
 * The projection of a pass without any event.
 *
 * @param {Object} terms The terms of the pass (admission-terms `snapshotTerms`)
 * @returns {Object}
 */
function emptyProjection(terms) {
  return {
    presentSince: null,
    presentEntryId: null,
    lastEntryAt: null,
    lastExitAt: null,
    entryCount: 0,
    usedDays: [],
    quotaLeft: terms.usage === USAGE.QUOTA ? terms.quota : null,
    dayEntries: null,
    blocked: null,
    voided: null,
    reissuedAt: null,
  };
}

function closePresence(projection) {
  return { ...projection, presentSince: null, presentEntryId: null };
}

/**
 * The projection after one more event. Immutable: returns a new object.
 * An undone entry changes history, so {@link USAGE_EVENTS.UNDO_ENTRY} is
 * only handled by {@link replay}.
 *
 * @param {Object} projection
 * @param {Object} event `{ id, type, at, ... }`
 * @param {Object} terms
 * @returns {Object}
 */
function applyEvent(projection, event, terms) {
  const p = projection;
  switch (event.type) {
    case USAGE_EVENTS.ENTRY: {
      const usedDays = p.usedDays.includes(event.day)
        ? p.usedDays
        : [...p.usedDays, event.day];
      const sameDay = p.dayEntries?.day === event.day;
      return {
        ...p,
        presentSince: event.at,
        presentEntryId: event.id,
        lastEntryAt: event.at,
        entryCount: p.entryCount + 1,
        usedDays,
        quotaLeft:
          terms.usage === USAGE.QUOTA
            ? Math.max(terms.quota - usedDays.length, 0)
            : null,
        dayEntries: {
          day: event.day,
          count: sameDay ? p.dayEntries.count + 1 : 1,
        },
      };
    }
    case USAGE_EVENTS.EXIT:
    case USAGE_EVENTS.AUTO_EXIT:
      return p.presentSince === null
        ? p
        : { ...closePresence(p), lastExitAt: event.at };
    case USAGE_EVENTS.DAY_RESET:
    case USAGE_EVENTS.RESET_PRESENCE:
      return closePresence(p);
    case USAGE_EVENTS.BLOCK:
      return {
        ...p,
        blocked: { at: event.at, note: event.note, by: event.actor },
      };
    case USAGE_EVENTS.UNBLOCK:
      return { ...p, blocked: null };
    case USAGE_EVENTS.VOID:
      return {
        ...p,
        voided: { at: event.at, cause: event.cause, by: event.actor ?? null },
      };
    case USAGE_EVENTS.RESTORE:
      return { ...p, voided: null };
    case USAGE_EVENTS.REISSUE:
      return { ...p, reissuedAt: event.at };
    case USAGE_EVENTS.UNDO_ENTRY:
      throw new Error("admission state: an undone entry needs a replay");
    default:
      throw new Error(`admission state: unknown event ${event.type}`);
  }
}

/**
 * The projection a usage log adds up to, in log order. An undone entry is
 * left out as if it never happened, so its day, its presence and its lock
 * period are given back; the entry and the undo both stay in the log.
 *
 * @param {Object[]} events The usage log of one pass, oldest first
 * @param {Object} terms
 * @returns {Object}
 */
function replay(events, terms) {
  const undone = new Set(
    events
      .filter((event) => event.type === USAGE_EVENTS.UNDO_ENTRY)
      .map((event) => event.entryId),
  );
  return events
    .filter(
      (event) =>
        event.type !== USAGE_EVENTS.UNDO_ENTRY && !undone.has(event.id),
    )
    .reduce(
      (projection, event) => applyEvent(projection, event, terms),
      emptyProjection(terms),
    );
}

/**
 * Whether the pass counts as checked in at `now`: an open presence that
 * started in the current business day and is within the maximum stay.
 *
 * @param {Object} projection
 * @param {{ resetTime?: string, zone?: string, maxStayMinutes?: number }} facility
 * @param {number} now Epoch ms
 * @returns {boolean}
 */
function isPresent(projection, facility, now) {
  const since = projection.presentSince;
  if (since === null || since === undefined) {
    return false;
  }
  if (since < businessDayStart(now, facility).toMillis()) {
    return false;
  }
  const maxStay = facility.maxStayMinutes;
  return !(maxStay > 0 && now >= since + maxStay * MINUTE);
}

/**
 * The entries of the business day `now` falls in.
 *
 * @param {Object} projection
 * @param {Object} facility
 * @param {number} now
 * @returns {number}
 */
function entriesToday(projection, facility, now) {
  const today = businessDayOf(now, facility);
  return projection.dayEntries?.day === today ? projection.dayEntries.count : 0;
}

/**
 * The state of a pass at `now`, most binding first: a void or blocked pass
 * is that whatever else holds, an expired one cannot be present.
 *
 * A quota pass at zero is consumed from the business day after its last
 * one: on that day a re-entry stays possible without using quota (Pos. 3.3),
 * so it is not yet consumed.
 *
 * @param {Object} projection
 * @param {Object} terms
 * @param {Object} facility
 * @param {number} now Epoch ms
 * @returns {string} One of {@link ADMISSION_STATES}
 */
function stateOf(projection, terms, facility, now) {
  const p = projection;
  if (p.voided) return ADMISSION_STATES.VOID;
  if (p.blocked) return ADMISSION_STATES.BLOCKED;
  if (now >= terms.validUntil) return ADMISSION_STATES.EXPIRED;
  if (isPresent(p, facility, now)) return ADMISSION_STATES.PRESENT;
  if (terms.usage === USAGE.SINGLE && p.entryCount > 0) {
    return ADMISSION_STATES.CONSUMED;
  }
  if (
    terms.usage === USAGE.QUOTA &&
    p.quotaLeft === 0 &&
    !p.usedDays.includes(businessDayOf(now, facility))
  ) {
    return ADMISSION_STATES.CONSUMED;
  }
  return p.entryCount > 0 ? ADMISSION_STATES.ABSENT : ADMISSION_STATES.ISSUED;
}

/**
 * The corrections the administration may apply now (Pos. 1.2, 6.2). A void
 * that follows the booking is undone through the booking, never by hand.
 *
 * @param {Object} projection
 * @param {Object} terms
 * @param {Object} facility
 * @param {number} now
 * @returns {string[]} Event types of {@link USAGE_EVENTS}
 */
function correctionsOf(projection, terms, facility, now) {
  const p = projection;
  const state = stateOf(p, terms, facility, now);
  const corrections = [];
  if (state === ADMISSION_STATES.PRESENT) {
    corrections.push(USAGE_EVENTS.RESET_PRESENCE);
  }
  if (p.entryCount > 0) {
    corrections.push(USAGE_EVENTS.UNDO_ENTRY);
  }
  if (!p.voided) {
    corrections.push(p.blocked ? USAGE_EVENTS.UNBLOCK : USAGE_EVENTS.BLOCK);
    corrections.push(USAGE_EVENTS.VOID);
    if (state !== ADMISSION_STATES.EXPIRED) {
      corrections.push(USAGE_EVENTS.REISSUE);
    }
  } else if (p.voided.cause === VOID_CAUSES.BY_ADMINISTRATION) {
    corrections.push(USAGE_EVENTS.RESTORE);
  }
  return corrections;
}

/**
 * What is wrong with an event before it is appended to the log.
 *
 * @param {Object} event
 * @param {Object[]} [log] The usage log so far, to check an undo
 * @returns {string[]} Problem codes; empty when the event may be written
 */
function problemsOfEvent(event, log = []) {
  const problems = [];
  if (!Object.values(USAGE_EVENTS).includes(event?.type)) {
    return ["unknown_type"];
  }
  if (!Number.isFinite(event.at)) {
    problems.push("time_missing");
  }
  const byHand =
    CORRECTION_EVENTS.includes(event.type) ||
    event.actor?.source === ACTOR_SOURCES.ADMINISTRATION;
  if (
    byHand &&
    !(
      event.actor?.source === ACTOR_SOURCES.ADMINISTRATION && event.actor.userId
    )
  ) {
    problems.push("account_missing");
  }
  if (byHand && !String(event.note ?? "").trim()) {
    problems.push("reason_missing");
  }
  if (
    event.type === USAGE_EVENTS.ENTRY &&
    !/^\d{4}-\d{2}-\d{2}$/.test(event.day)
  ) {
    problems.push("day_missing");
  }
  if (
    event.type === USAGE_EVENTS.VOID &&
    !Object.values(VOID_CAUSES).includes(event.cause)
  ) {
    problems.push("cause_unknown");
  }
  if (event.type === USAGE_EVENTS.UNDO_ENTRY) {
    const target = log.find((entry) => entry.id === event.entryId);
    if (!target || target.type !== USAGE_EVENTS.ENTRY) {
      problems.push("entry_unknown");
    } else if (
      log.some(
        (entry) =>
          entry.type === USAGE_EVENTS.UNDO_ENTRY &&
          entry.entryId === event.entryId,
      )
    ) {
      problems.push("entry_already_undone");
    }
  }
  return problems;
}

module.exports = {
  ADMISSION_STATES,
  STATE_LABELS_DE,
  USAGE_EVENTS,
  ACTOR_SOURCES,
  CORRECTION_EVENTS,
  businessDayStart,
  businessDayOf,
  emptyProjection,
  applyEvent,
  replay,
  isPresent,
  entriesToday,
  stateOf,
  correctionsOf,
  problemsOfEvent,
};
