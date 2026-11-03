/**
 * A pass (glossary "Zugangsberechtigung"): the right of one person to enter
 * one facility, issued from a booking. It keeps the terms of its purchase,
 * the hash of its access identifier and the projection of its usage log;
 * the state is computed from the projection at the moment of a check
 * (services/admission/admission-state.js). Times are epoch milliseconds.
 */
const admissionPassSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true },
  /** The facility (an existing bookable) the pass admits to. */
  facilityId: { type: String, required: true },
  /** The tariff (a bookable of type `ticket`) it was bought as. */
  tariffId: { type: String, default: null },
  bookingId: { type: String, default: null },
  /**
   * The ticket of the booking the pass belongs to (glossary "Ticket"): the
   * booked units of its tariff, numbered from 1 within the booking.
   */
  ticket: { type: Number, default: 1 },
  /** Position within the bundle of its ticket, from 1. */
  position: { type: Number, default: 1 },
  /** What the staff reads: the tariff and the person of the bundle. */
  label: { type: String, default: null },
  /** `{ name }` of a personal pass, null otherwise. */
  holder: { type: Object, default: null },
  /** `sha256(tenantId:identifier)`, the lookup key of a scan. */
  codeHash: { type: String, required: true },
  /** The hashes of identifiers a reissue replaced, answered as replaced. */
  retiredCodeHashes: { type: [String], default: [] },
  /** The identifier itself, encrypted, for the re-delivery of the ticket. */
  codeCipher: { type: Object, default: null },
  /** The terms snapshot of the purchase (admission-terms `snapshotTerms`). */
  terms: { type: Object, required: true },
  /** What the usage log adds up to (admission-state `applyEvent`). */
  projection: { type: Object, required: true },
  /** Events applied to the projection; the next event is `version + 1`. */
  version: { type: Number, default: 0 },
  issuedAt: { type: Number, required: true },
};

module.exports = admissionPassSchemaDefinition;
