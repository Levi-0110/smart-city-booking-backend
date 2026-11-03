/**
 * The admission settings of a facility (glossary "Einrichtung"), next to its
 * bookable, whose `amount` stays its capacity: when its business day starts,
 * how long a stay may last, whether exits are scanned, the thresholds of the
 * notices, and how far the daily reset has run.
 */
const admissionFacilitySchemaDefinition = {
  tenantId: { type: String, required: true },
  /** The id of the facility's bookable. */
  facilityId: { type: String, required: true },
  /** Start of the business day, `HH:mm`, in `zone`. */
  resetTime: { type: String, default: "03:00" },
  zone: { type: String, default: "Europe/Berlin" },
  /** Longest stay; a presence beyond it no longer counts. */
  maxStayMinutes: { type: Number, default: null },
  exitScan: { type: Boolean, default: false },
  /** `{ refusedAttempts, entriesPerDay }` (admission-check `DEFAULT_WARNINGS`). */
  warnings: { type: Object, default: null },
  /** The business day start up to which the daily reset has closed presences. */
  lastResetAt: { type: Number, default: null },
};

module.exports = admissionFacilitySchemaDefinition;
