/**
 * One scan at an entrance (the check log, glossary "Einlassprüfung"):
 * granted and refused alike, with the answer the device was given. A scan
 * carries the `scanId` of its device, unique per tenant, so a scan sent twice
 * is answered once (Pos. 1.3). A row without `answer` is a check under way.
 */
const admissionCheckSchemaDefinition = {
  tenantId: { type: String, required: true },
  scanId: { type: String, required: true },
  deviceId: { type: String, default: null },
  facilityId: { type: String, default: null },
  passId: { type: String, default: null },
  direction: { type: String, default: null },
  /** When the check began; epoch ms. */
  at: { type: Number, required: true },
  result: { type: String, default: null },
  step: { type: Number, default: null },
  reason: { type: String, default: null },
  answer: { type: Object, default: null },
};

module.exports = admissionCheckSchemaDefinition;
