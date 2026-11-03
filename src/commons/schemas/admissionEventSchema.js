/**
 * One entry of the usage log of a pass (glossary "Nutzungsprotokoll"): an
 * entry, an exit, an automatic exit, a daily reset or a correction with its
 * account and reason. The log is the source of truth of a pass; `seq` numbers
 * the events of one pass from 1 and is unique per pass, so two writers can
 * never both append the same next event.
 */
const admissionEventSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true },
  passId: { type: String, required: true },
  seq: { type: Number, required: true },
  /** One of admission-state `USAGE_EVENTS`. */
  type: { type: String, required: true },
  at: { type: Number, required: true },
  /** Business day of an entry, `YYYY-MM-DD`. */
  day: { type: String, default: null },
  consumesDay: { type: Boolean, default: null },
  /** When a presence ended, for an automatic exit or a daily reset. */
  closedAt: { type: Number, default: null },
  /** The entry an `undo_entry` takes back. */
  entryId: { type: String, default: null },
  /** Cause of a `void`, one of admission-reasons `VOID_CAUSES`. */
  cause: { type: String, default: null },
  /** Reason of a correction, note of a block. */
  reason: { type: String, default: null },
  note: { type: String, default: null },
  /** `{ source, userId?, deviceId? }`, source one of `ACTOR_SOURCES`. */
  actor: { type: Object, default: null },
};

module.exports = admissionEventSchemaDefinition;
