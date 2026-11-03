const { DateTime } = require("luxon");

/**
 * The admission terms of a tariff (glossary "Berechtigungsangaben"): what a
 * pass issued from it allows. A tariff is a bookable of type `ticket` under
 * a facility; its definition lives at the bookable as `admission`:
 *
 * ```js
 * {
 *   validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
 *   //      or { type: "relative", months: 12 } | { type: "relative", days: 1 }
 *   //      or { type: "booking" }  (the booked period, e.g. a day ticket)
 *   usage: { type: "quota", quota: 10 }, // or { type: "single" } | { type: "unlimited" }
 *   //      { type: "single", sameDayReentry: true }: re-entry on the same
 *   //      business day after an exit (Pos. 3.4)
 *   lockMinutes: 180,                     // no new entry before this has passed
 *   personal: { required: true, photo: true },
 *   bundle: [{ label: "Erwachsene", count: 2 }, { label: "Kinder", count: 3 }],
 *   capacityCheck: "entry",               // or "booking" | "none"
 * }
 * ```
 *
 * At issuance the definition is copied into the pass ({@link snapshotTerms}),
 * never referenced: a pass keeps the terms of the moment it was bought, even
 * when the facility changes the tariff mid-season (Pos. 2.2). All functions
 * here are pure.
 */

const USAGE = Object.freeze({
  SINGLE: "single",
  UNLIMITED: "unlimited",
  QUOTA: "quota",
});

const VALIDITY = Object.freeze({
  FIXED: "fixed",
  RELATIVE: "relative",
  BOOKING: "booking",
});

const CAPACITY_CHECK = Object.freeze({
  BOOKING: "booking",
  ENTRY: "entry",
  NONE: "none",
});

const DEFAULT_ZONE = "Europe/Berlin";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What is wrong with a definition, before a tariff is saved or sold. An empty
 * list means the definition can issue passes.
 *
 * @param {Object} definition The `admission` of a tariff
 * @returns {{ field: string, code: string }[]}
 */
function problemsOf(definition) {
  const problems = [];
  const add = (field, code) => problems.push({ field, code });
  if (!definition || typeof definition !== "object") {
    return [{ field: "admission", code: "missing" }];
  }

  const validity = definition.validity || {};
  if (!Object.values(VALIDITY).includes(validity.type)) {
    add("validity.type", "unknown");
  } else if (validity.type === VALIDITY.FIXED) {
    if (!ISO_DATE.test(validity.from || "")) add("validity.from", "invalid");
    if (!ISO_DATE.test(validity.to || "")) add("validity.to", "invalid");
    if (
      ISO_DATE.test(validity.from || "") &&
      ISO_DATE.test(validity.to || "") &&
      validity.to < validity.from
    ) {
      add("validity.to", "before_from");
    }
  } else if (validity.type === VALIDITY.RELATIVE) {
    const months = validity.months ?? 0;
    const days = validity.days ?? 0;
    if (
      !Number.isInteger(months) ||
      !Number.isInteger(days) ||
      months < 0 ||
      days < 0 ||
      months + days === 0
    ) {
      add("validity", "no_duration");
    }
  }

  const usage = definition.usage || {};
  if (!Object.values(USAGE).includes(usage.type)) {
    add("usage.type", "unknown");
  } else if (
    usage.type === USAGE.QUOTA &&
    !(Number.isInteger(usage.quota) && usage.quota > 0)
  ) {
    add("usage.quota", "not_positive");
  }
  if (
    usage.sameDayReentry !== undefined &&
    typeof usage.sameDayReentry !== "boolean"
  ) {
    add("usage.sameDayReentry", "invalid");
  }

  const lock = definition.lockMinutes ?? 0;
  if (!(Number.isInteger(lock) && lock >= 0)) {
    add("lockMinutes", "invalid");
  }

  if (definition.personal?.photo && !definition.personal?.required) {
    add("personal.photo", "requires_personal_binding");
  }

  const capacity = definition.capacityCheck ?? CAPACITY_CHECK.BOOKING;
  if (!Object.values(CAPACITY_CHECK).includes(capacity)) {
    add("capacityCheck", "unknown");
  }

  if (definition.bundle !== undefined) {
    if (!Array.isArray(definition.bundle) || definition.bundle.length === 0) {
      add("bundle", "empty");
    } else if (
      definition.bundle.some(
        (part) => !(Number.isInteger(part?.count) && part.count > 0),
      )
    ) {
      add("bundle", "count_not_positive");
    }
  }
  return problems;
}

/**
 * The passes one booked unit of a tariff issues: one per person of the
 * bundle, so that at the entrance one pass always stands for one person and
 * the state model needs no special case (Pos. 2.4). Without a bundle a unit
 * issues one pass.
 *
 * @param {Object} definition The `admission` of a tariff
 * @returns {{ label: string|null, position: number }[]}
 */
function passesOf(definition) {
  const bundle = definition?.bundle;
  if (!Array.isArray(bundle) || bundle.length === 0) {
    return [{ label: null, position: 1 }];
  }
  const passes = [];
  for (const part of bundle) {
    for (let i = 0; i < part.count; i++) {
      passes.push({ label: part.label ?? null, position: passes.length + 1 });
    }
  }
  return passes;
}

/**
 * The validity window of a pass in epoch ms: `validFrom` inclusive,
 * `validUntil` exclusive. A fixed window covers its last day completely in
 * the facility's time zone.
 *
 * @param {Object} validity `admission.validity`
 * @param {Object} context
 * @param {number} context.issuedAt Epoch ms of the issuance
 * @param {{ begin: number, end: number }} [context.bookingPeriod] The booked period
 * @param {string} [context.zone] IANA time zone of the facility
 * @returns {{ validFrom: number, validUntil: number }}
 */
function windowOf(validity, { issuedAt, bookingPeriod, zone = DEFAULT_ZONE }) {
  if (validity.type === VALIDITY.FIXED) {
    return {
      validFrom: DateTime.fromISO(validity.from, { zone })
        .startOf("day")
        .toMillis(),
      validUntil: DateTime.fromISO(validity.to, { zone })
        .plus({ days: 1 })
        .startOf("day")
        .toMillis(),
    };
  }
  if (validity.type === VALIDITY.RELATIVE) {
    return {
      validFrom: issuedAt,
      validUntil: DateTime.fromMillis(issuedAt, { zone })
        .plus({ months: validity.months ?? 0, days: validity.days ?? 0 })
        .toMillis(),
    };
  }
  if (!bookingPeriod) {
    throw new Error(
      "admission terms: a booking validity needs the booked period",
    );
  }
  return { validFrom: bookingPeriod.begin, validUntil: bookingPeriod.end };
}

/**
 * Copies the definition into the terms of one pass at the moment of issuance.
 *
 * @param {Object} definition The `admission` of the tariff
 * @param {Object} context See {@link windowOf}
 * @returns {Readonly<Object>} The terms the pass keeps for its whole life
 */
function snapshotTerms(definition, context) {
  const problems = problemsOf(definition);
  if (problems.length > 0) {
    throw new Error(
      `admission terms: invalid definition (${problems
        .map((p) => `${p.field} ${p.code}`)
        .join(", ")})`,
    );
  }
  const { validFrom, validUntil } = windowOf(definition.validity, context);
  return Object.freeze({
    validFrom,
    validUntil,
    usage: definition.usage.type,
    quota:
      definition.usage.type === USAGE.QUOTA ? definition.usage.quota : null,
    sameDayReentry:
      definition.usage.type === USAGE.SINGLE &&
      definition.usage.sameDayReentry === true,
    lockMinutes: definition.lockMinutes ?? 0,
    personal: Boolean(definition.personal?.required),
    photo: Boolean(definition.personal?.photo),
    capacityCheck: definition.capacityCheck ?? CAPACITY_CHECK.BOOKING,
    zone: context.zone ?? DEFAULT_ZONE,
  });
}

/**
 * The rule preview of a tariff (Pos. 3.6): what it issues and what follows at
 * the entrance, in whole German sentences for the administration, so that a
 * misconfiguration shows before the first ticket is sold.
 *
 * @param {Object} definition The `admission` of a tariff
 * @returns {string[]} One sentence per aspect; the problems first, if any
 */
function describe(definition) {
  const problems = problemsOf(definition);
  if (problems.length > 0) {
    return problems.map(
      (p) =>
        `Bitte prüfen: ${p.field} (${PROBLEM_TEXTS_DE[p.code] || p.code}).`,
    );
  }
  const sentences = [];
  const passes = passesOf(definition);
  if (passes.length === 1) {
    sentences.push("Erzeugt je Buchung eine Zugangsberechtigung.");
  } else {
    const parts = definition.bundle
      .map((part) => `${part.count} × ${part.label || "Person"}`)
      .join(", ");
    sentences.push(
      `Erzeugt je Buchung ${passes.length} Zugangsberechtigungen unter einem Ticket (${parts}).`,
    );
  }

  const validity = definition.validity;
  if (validity.type === VALIDITY.FIXED) {
    sentences.push(
      `Gültig vom ${germanDate(validity.from)} bis ${germanDate(validity.to)}.`,
    );
  } else if (validity.type === VALIDITY.RELATIVE) {
    const span = [
      validity.months
        ? `${validity.months} Monat${validity.months === 1 ? "" : "e"}`
        : null,
      validity.days
        ? `${validity.days} Tag${validity.days === 1 ? "" : "e"}`
        : null,
    ]
      .filter(Boolean)
      .join(" und ");
    sentences.push(`Gültig ab dem Kauf für ${span}.`);
  } else {
    sentences.push("Gültig im gebuchten Zeitraum.");
  }

  const usage = definition.usage;
  if (usage.type === USAGE.SINGLE) {
    sentences.push(
      usage.sameDayReentry
        ? "Erlaubt einen Eintritt; ein Wiedereintritt am selben Tag nach einem Austritt ist möglich."
        : "Erlaubt genau einen Eintritt.",
    );
  } else if (usage.type === USAGE.UNLIMITED) {
    sentences.push("Erlaubt beliebig viele Eintritte in der Gültigkeit.");
  } else {
    sentences.push(
      `Erlaubt Eintritte an ${usage.quota} Tagen; ein Wiedereintritt am selben Tag zählt nicht erneut.`,
    );
  }

  if (definition.lockMinutes > 0) {
    sentences.push(
      `Nach einem Eintritt ist ${durationDe(definition.lockMinutes)} lang kein erneuter Eintritt möglich.`,
    );
  }
  if (definition.personal?.required) {
    sentences.push(
      definition.personal.photo
        ? "Personengebunden: Name und Lichtbild werden am Einlass angezeigt."
        : "Personengebunden: Der Name wird am Einlass angezeigt.",
    );
  }
  const capacity = definition.capacityCheck ?? CAPACITY_CHECK.BOOKING;
  sentences.push(
    {
      [CAPACITY_CHECK.BOOKING]: "Die Kapazität wird bei der Buchung geprüft.",
      [CAPACITY_CHECK.ENTRY]:
        "Die Kapazität der Einrichtung wird am Einlass geprüft.",
      [CAPACITY_CHECK.NONE]: "Die Kapazität wird nicht geprüft.",
    }[capacity],
  );
  return sentences;
}

const PROBLEM_TEXTS_DE = Object.freeze({
  missing: "keine Angaben",
  unknown: "unbekannter Wert",
  invalid: "ungültiger Wert",
  before_from: "Ende liegt vor dem Beginn",
  no_duration: "keine Laufzeit angegeben",
  not_positive: "muss größer als null sein",
  requires_personal_binding: "Lichtbild nur bei Personenbindung",
  empty: "keine Personen angegeben",
  count_not_positive: "Anzahl muss größer als null sein",
});

function germanDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

function durationDe(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} Stunde${hours === 1 ? "" : "n"}`;
  }
  return `${minutes} Minuten`;
}

module.exports = {
  USAGE,
  VALIDITY,
  CAPACITY_CHECK,
  DEFAULT_ZONE,
  problemsOf,
  passesOf,
  windowOf,
  snapshotTerms,
  describe,
};
