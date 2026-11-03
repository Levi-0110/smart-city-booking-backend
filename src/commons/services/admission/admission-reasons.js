/**
 * The answers of an admission check (glossary "Einlassprüfung"): the reason
 * a check refuses an entry and the notices it adds to a granted one.
 *
 * Each reason belongs to exactly one step of the fixed check order
 * (`ADMISSION_STEPS`), so the step that stopped a check is always the
 * step of its reason. The texts are what the staff at the entrance reads and
 * can repeat to the guest; they are user-facing copy and stay German, with
 * `{placeholders}` the check fills from its parameters.
 */

/** The six steps of the check, in the order they are evaluated. */
const ADMISSION_STEPS = Object.freeze({
  CODE: 1,
  VALIDITY: 2,
  USAGE: 3,
  PRESENCE: 4,
  LOCK_PERIOD: 5,
  CAPACITY: 6,
});

/** The outcome of a check. */
const ADMISSION_RESULT = Object.freeze({
  GRANTED: "granted",
  GRANTED_WITH_NOTICE: "granted_with_notice",
  DENIED: "denied",
  /** An exit scan: the presence was closed. */
  EXITED: "exited",
  /** An exit scan of a pass that was not checked in: nothing changed. */
  NOT_PRESENT: "not_present",
});

/** Why a check refuses an entry, by step. */
const DENIAL_REASONS = Object.freeze({
  CODE_UNREADABLE: "code_unreadable",
  NOT_A_TICKET: "not_a_ticket",
  CODE_NOT_GENUINE: "code_not_genuine",
  CODE_UNKNOWN: "code_unknown",
  CODE_REPLACED: "code_replaced",
  OTHER_FACILITY: "other_facility",
  BLOCKED: "blocked",
  VOIDED: "voided",
  NOT_YET_VALID: "not_yet_valid",
  EXPIRED: "expired",
  SINGLE_ENTRY_USED: "single_entry_used",
  QUOTA_EXHAUSTED: "quota_exhausted",
  ALREADY_PRESENT: "already_present",
  LOCK_PERIOD: "lock_period",
  CAPACITY_REACHED: "capacity_reached",
});

/** The step each denial reason belongs to. */
const STEP_OF_REASON = Object.freeze({
  [DENIAL_REASONS.CODE_UNREADABLE]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.NOT_A_TICKET]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.CODE_NOT_GENUINE]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.CODE_UNKNOWN]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.CODE_REPLACED]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.OTHER_FACILITY]: ADMISSION_STEPS.CODE,
  [DENIAL_REASONS.BLOCKED]: ADMISSION_STEPS.VALIDITY,
  [DENIAL_REASONS.VOIDED]: ADMISSION_STEPS.VALIDITY,
  [DENIAL_REASONS.NOT_YET_VALID]: ADMISSION_STEPS.VALIDITY,
  [DENIAL_REASONS.EXPIRED]: ADMISSION_STEPS.VALIDITY,
  [DENIAL_REASONS.SINGLE_ENTRY_USED]: ADMISSION_STEPS.USAGE,
  [DENIAL_REASONS.QUOTA_EXHAUSTED]: ADMISSION_STEPS.USAGE,
  [DENIAL_REASONS.ALREADY_PRESENT]: ADMISSION_STEPS.PRESENCE,
  [DENIAL_REASONS.LOCK_PERIOD]: ADMISSION_STEPS.LOCK_PERIOD,
  [DENIAL_REASONS.CAPACITY_REACHED]: ADMISSION_STEPS.CAPACITY,
});

/**
 * Why a pass became void (event `void`), as the check names it: the staff
 * can tell a guest whose booking was cancelled from one whose ticket was
 * replaced.
 */
const VOID_CAUSES = Object.freeze({
  BOOKING_CANCELLED: "booking_cancelled",
  BOOKING_REJECTED: "booking_rejected",
  BOOKING_WITHDRAWN: "booking_withdrawn",
  BY_ADMINISTRATION: "by_administration",
});

/** What a check adds for the staff, granted or not (Pos. 5.5). */
const ADMISSION_NOTICES = Object.freeze({
  /** Second entry of a business day already counted: no quota used. */
  REENTRY_NO_QUOTA: "reentry_no_quota",
  /** This entry used the last day of the quota. */
  LAST_QUOTA_DAY: "last_quota_day",
  /** The pass is bound to a person: compare name and photo. */
  CHECK_PERSON: "check_person",
  /** Several refused attempts within the lock period (Pos. 5.5). */
  REPEATED_ATTEMPTS: "repeated_attempts",
  /** Unusually many entries of this pass today (Pos. 5.5). */
  FREQUENT_USE: "frequent_use",
});

const MESSAGES_DE = Object.freeze({
  [ADMISSION_RESULT.GRANTED]: "Eintritt gewährt",
  [ADMISSION_RESULT.GRANTED_WITH_NOTICE]: "Eintritt gewährt, Hinweis beachten",
  [ADMISSION_RESULT.DENIED]: "Kein Eintritt",
  [ADMISSION_RESULT.EXITED]: "Austritt erfasst",
  [ADMISSION_RESULT.NOT_PRESENT]: "War nicht eingecheckt, nichts geändert",
  [DENIAL_REASONS.CODE_UNREADABLE]: "Code nicht lesbar",
  [DENIAL_REASONS.NOT_A_TICKET]:
    "Kein Ticket: Buchungsbestätigung oder Buchungsnummer",
  [DENIAL_REASONS.CODE_NOT_GENUINE]:
    "Code nicht von diesem Betrieb ausgestellt",
  [DENIAL_REASONS.CODE_UNKNOWN]: "Code unbekannt",
  [DENIAL_REASONS.CODE_REPLACED]: "Code ersetzt: neues Ticket vorzeigen",
  [DENIAL_REASONS.OTHER_FACILITY]: "Gilt für eine andere Einrichtung",
  [DENIAL_REASONS.BLOCKED]: "Gesperrt: {note}",
  [DENIAL_REASONS.VOIDED]: "Ungültig: {cause}",
  [DENIAL_REASONS.NOT_YET_VALID]: "Gültig ab {validFrom}",
  [DENIAL_REASONS.EXPIRED]: "Abgelaufen am {validUntil}",
  [DENIAL_REASONS.SINGLE_ENTRY_USED]: "Einmaleintritt bereits genutzt um {at}",
  [DENIAL_REASONS.QUOTA_EXHAUSTED]:
    "Kontingent aufgebraucht ({used} von {quota})",
  [DENIAL_REASONS.ALREADY_PRESENT]:
    "Bereits eingecheckt seit {since}, kein Austritt erfasst",
  [DENIAL_REASONS.LOCK_PERIOD]: "Erneuter Eintritt ab {until} möglich",
  [DENIAL_REASONS.CAPACITY_REACHED]:
    "Einrichtung voll: {present} von {capacity} eingecheckt",
  [ADMISSION_NOTICES.REENTRY_NO_QUOTA]:
    "Wiedereintritt heute, kein Kontingent verbraucht",
  [ADMISSION_NOTICES.LAST_QUOTA_DAY]: "Letzter Tag des Kontingents",
  [ADMISSION_NOTICES.CHECK_PERSON]: "Person prüfen: {holder}",
  [ADMISSION_NOTICES.REPEATED_ATTEMPTS]:
    "Hinweis: {count} abgewiesene Versuche in der Sperrzeit",
  [ADMISSION_NOTICES.FREQUENT_USE]: "Hinweis: heute schon {count} Eintritte",
  [VOID_CAUSES.BOOKING_CANCELLED]: "Buchung storniert",
  [VOID_CAUSES.BOOKING_REJECTED]: "Buchung abgelehnt",
  [VOID_CAUSES.BOOKING_WITHDRAWN]: "Buchung widerrufen",
  [VOID_CAUSES.BY_ADMINISTRATION]: "durch die Verwaltung",
});

/**
 * The German text of a reason or notice with its parameters filled in.
 * Unknown placeholders stay visible rather than vanish, so a missing
 * parameter shows in a test instead of producing a half sentence.
 *
 * @param {string} code A value of {@link ADMISSION_RESULT}, {@link DENIAL_REASONS},
 *   {@link ADMISSION_NOTICES} or {@link VOID_CAUSES}
 * @param {Object<string, string|number>} [params]
 * @returns {string}
 */
function messageOf(code, params = {}) {
  const template = MESSAGES_DE[code];
  if (!template) {
    return code;
  }
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null
      ? match
      : String(params[key]),
  );
}

module.exports = {
  ADMISSION_STEPS,
  ADMISSION_RESULT,
  DENIAL_REASONS,
  STEP_OF_REASON,
  ADMISSION_NOTICES,
  VOID_CAUSES,
  messageOf,
};
