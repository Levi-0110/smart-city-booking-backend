const { DateTime } = require("luxon");
const { USAGE, CAPACITY_CHECK, DEFAULT_ZONE } = require("./admission-terms");
const {
  ADMISSION_STEPS,
  ADMISSION_RESULT,
  DENIAL_REASONS,
  STEP_OF_REASON,
  ADMISSION_NOTICES,
  messageOf,
} = require("./admission-reasons");
const {
  ADMISSION_STATES,
  STATE_LABELS_DE,
  USAGE_EVENTS,
  businessDayOf,
  isPresent,
  entriesToday,
  stateOf,
} = require("./admission-state");

/** The mode of the device that scanned. */
const DIRECTION = Object.freeze({
  ENTRY: "entry",
  EXIT: "exit",
});

/**
 * How the scanned code resolved before the check: read
 * (admission-code `readCode`), tag verified, pass looked up.
 */
const CODE_STATUS = Object.freeze({
  FOUND: "found",
  UNREADABLE: "unreadable",
  NOT_A_TICKET: "not_a_ticket",
  NOT_GENUINE: "not_genuine",
  UNKNOWN: "unknown",
  /** The code of a pass that has been reissued since. */
  REPLACED: "replaced",
});

const REASON_OF_CODE_STATUS = Object.freeze({
  [CODE_STATUS.UNREADABLE]: DENIAL_REASONS.CODE_UNREADABLE,
  [CODE_STATUS.NOT_A_TICKET]: DENIAL_REASONS.NOT_A_TICKET,
  [CODE_STATUS.NOT_GENUINE]: DENIAL_REASONS.CODE_NOT_GENUINE,
  [CODE_STATUS.UNKNOWN]: DENIAL_REASONS.CODE_UNKNOWN,
  [CODE_STATUS.REPLACED]: DENIAL_REASONS.CODE_REPLACED,
});

/**
 * When the check points the staff to a pattern (Pos. 5.5), per facility.
 * The check never acts on it: it shows what was recorded, the staff decides.
 */
const DEFAULT_WARNINGS = Object.freeze({
  /** Refused attempts since the last entry, this one included. */
  refusedAttempts: 2,
  /** Entries of one pass in one business day, this one included. */
  entriesPerDay: 3,
});

const MINUTE = 60 * 1000;

/**
 * The admission check (glossary "Einlassprüfung", Pos. 4.1): one scan, one
 * check, six steps in fixed order. The first step that refuses ends the check
 * and names the reason, so the staff can tell the guest why.
 *
 * 1. Code: readable, issued by this tenant, known, for this facility.
 * 2. Validity: not voided, not blocked, within its validity.
 * 3. Usage: the single entry unused, quota left - or today already counted.
 * 4. Presence: not checked in already without an exit.
 * 5. Lock period: over since the last entry.
 * 6. Capacity: the facility is not full, where the tariff checks at entry.
 *
 * The check is pure: the caller has resolved the code, loaded pass and
 * facility, and writes the effect - the one usage event of a granted entry
 * or of an exit - with a conditional update, so two devices scanning the
 * same pass at once cannot both enter it. A refused check changes nothing
 * (Pos. 4.1); the caller records it in the check log only.
 *
 * @param {Object} input
 * @param {string} [input.direction=entry] One of {@link DIRECTION}
 * @param {string} input.codeStatus One of {@link CODE_STATUS}
 * @param {Object|null} input.pass `{ id, facilityId, label, terms, projection,
 *   holder: { name } | null, replacedAt }`; null unless the code resolved
 * @param {Object} input.facility `{ id, capacity, presentCount, resetTime,
 *   maxStayMinutes, zone, warnings }`
 * @param {number} input.now Epoch ms
 * @param {{ refusedSinceEntry?: number }} [input.history] What the check log
 *   knows about the pass: refused attempts since its last entry
 * @returns {{ result: string, step: number|null, reason: string|null,
 *   message: string, notices: { code: string, message: string }[],
 *   pass: Object|null, effect: Object|null }}
 */
function decide({
  direction = DIRECTION.ENTRY,
  codeStatus,
  pass,
  facility,
  now,
  history = {},
}) {
  const zone = facility.zone || DEFAULT_ZONE;
  const at = (ms, format) => DateTime.fromMillis(ms, { zone }).toFormat(format);
  const date = (ms) => at(ms, "dd.MM.yyyy");
  const time = (ms) => at(ms, "HH:mm");
  const warnings = { ...DEFAULT_WARNINGS, ...(facility.warnings || {}) };

  const view = () =>
    pass && {
      id: pass.id,
      label: pass.label ?? null,
      holder: pass.terms.personal ? pass.holder?.name ?? null : null,
      state: stateOf(pass.projection, pass.terms, facility, now),
      validUntil: pass.terms.validUntil,
      quotaLeft: pass.projection.quotaLeft,
    };

  const refused = (reason, params = {}, notices = []) => ({
    result: ADMISSION_RESULT.DENIED,
    step: STEP_OF_REASON[reason],
    reason,
    message: messageOf(reason, params),
    notices,
    pass: codeStatus === CODE_STATUS.FOUND ? view() : null,
    effect: null,
  });

  // Step 1: code.
  if (codeStatus !== CODE_STATUS.FOUND) {
    const reason =
      REASON_OF_CODE_STATUS[codeStatus] || DENIAL_REASONS.CODE_UNREADABLE;
    return refused(reason);
  }
  if (pass.facilityId !== facility.id) {
    return refused(DENIAL_REASONS.OTHER_FACILITY);
  }

  const { terms, projection: p } = pass;

  if (direction === DIRECTION.EXIT) {
    if (!isPresent(p, facility, now)) {
      return {
        result: ADMISSION_RESULT.NOT_PRESENT,
        step: null,
        reason: null,
        message: messageOf(ADMISSION_RESULT.NOT_PRESENT),
        notices: [],
        pass: view(),
        effect: null,
      };
    }
    return {
      result: ADMISSION_RESULT.EXITED,
      step: null,
      reason: null,
      message: messageOf(ADMISSION_RESULT.EXITED),
      notices: [],
      pass: { ...view(), state: ADMISSION_STATES.ABSENT },
      effect: { type: USAGE_EVENTS.EXIT, at: now },
    };
  }

  // Step 2: validity.
  if (p.voided) {
    return refused(DENIAL_REASONS.VOIDED, { cause: messageOf(p.voided.cause) });
  }
  if (p.blocked) {
    return refused(DENIAL_REASONS.BLOCKED, {
      note: p.blocked.note || "ohne Angabe",
    });
  }
  if (now < terms.validFrom) {
    return refused(DENIAL_REASONS.NOT_YET_VALID, {
      validFrom: date(terms.validFrom),
    });
  }
  if (now >= terms.validUntil) {
    return refused(DENIAL_REASONS.EXPIRED, {
      validUntil: date(terms.validUntil - 1),
    });
  }

  // Step 3: usage.
  const today = businessDayOf(now, facility);
  const dayCounted = p.usedDays.includes(today);
  if (terms.usage === USAGE.SINGLE && p.entryCount > 0) {
    return refused(DENIAL_REASONS.SINGLE_ENTRY_USED, {
      at: `${date(p.lastEntryAt)} ${time(p.lastEntryAt)}`,
    });
  }
  if (terms.usage === USAGE.QUOTA && p.quotaLeft === 0 && !dayCounted) {
    return refused(DENIAL_REASONS.QUOTA_EXHAUSTED, {
      used: terms.quota,
      quota: terms.quota,
    });
  }

  // Steps 4 and 5 refuse the patterns of a passed-on card; repeated, they
  // are pointed out (Pos. 5.5).
  const attempts = (history.refusedSinceEntry || 0) + 1;
  const attemptNotices =
    attempts >= warnings.refusedAttempts
      ? [notice(ADMISSION_NOTICES.REPEATED_ATTEMPTS, { count: attempts })]
      : [];

  // Step 4: presence.
  if (isPresent(p, facility, now)) {
    return refused(
      DENIAL_REASONS.ALREADY_PRESENT,
      { since: time(p.presentSince) },
      attemptNotices,
    );
  }

  // Step 5: lock period.
  if (terms.lockMinutes > 0 && p.lastEntryAt !== null) {
    const until = p.lastEntryAt + terms.lockMinutes * MINUTE;
    if (now < until) {
      return refused(
        DENIAL_REASONS.LOCK_PERIOD,
        { until: time(until) },
        attemptNotices,
      );
    }
  }

  // Step 6: capacity.
  if (
    terms.capacityCheck === CAPACITY_CHECK.ENTRY &&
    Number.isInteger(facility.capacity) &&
    (facility.presentCount || 0) >= facility.capacity
  ) {
    return refused(DENIAL_REASONS.CAPACITY_REACHED, {
      present: facility.presentCount,
      capacity: facility.capacity,
    });
  }

  // Granted: the entry is the effect, notices make it a granted with notice.
  const consumesDay = terms.usage === USAGE.QUOTA && !dayCounted;
  const quotaLeft = consumesDay ? p.quotaLeft - 1 : p.quotaLeft;
  const notices = [];
  if (terms.usage === USAGE.QUOTA && dayCounted) {
    notices.push(notice(ADMISSION_NOTICES.REENTRY_NO_QUOTA));
  }
  if (consumesDay && quotaLeft === 0) {
    notices.push(notice(ADMISSION_NOTICES.LAST_QUOTA_DAY));
  }
  if (terms.personal) {
    notices.push(
      notice(ADMISSION_NOTICES.CHECK_PERSON, {
        holder: pass.holder?.name || "Name fehlt",
      }),
    );
  }
  const todayCount = entriesToday(p, facility, now) + 1;
  if (todayCount >= warnings.entriesPerDay) {
    notices.push(notice(ADMISSION_NOTICES.FREQUENT_USE, { count: todayCount }));
  }

  const result =
    notices.length > 0
      ? ADMISSION_RESULT.GRANTED_WITH_NOTICE
      : ADMISSION_RESULT.GRANTED;
  return {
    result,
    step: null,
    reason: null,
    message: messageOf(result),
    notices,
    pass: { ...view(), state: ADMISSION_STATES.PRESENT, quotaLeft },
    effect: {
      type: USAGE_EVENTS.ENTRY,
      at: now,
      day: today,
      consumesDay,
    },
  };
}

function notice(code, params) {
  return { code, message: messageOf(code, params) };
}

/**
 * The German label of a state, for the views that show a decision.
 *
 * @param {string} state One of admission-state `ADMISSION_STATES`
 * @returns {string}
 */
function stateLabel(state) {
  return STATE_LABELS_DE[state] || state;
}

module.exports = {
  DIRECTION,
  CODE_STATUS,
  DEFAULT_WARNINGS,
  ADMISSION_STEPS,
  decide,
  stateLabel,
};
