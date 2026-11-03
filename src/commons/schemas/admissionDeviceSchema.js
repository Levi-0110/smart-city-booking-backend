/**
 * A device at an entrance (glossary "Einlassgerät"): bound to one facility,
 * authorized by a key that is shown once and kept only as its hash (Pos.
 * 4.2). Blocking one device leaves every other one working.
 */
const admissionDeviceSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true },
  facilityId: { type: String, required: true },
  name: { type: String, required: true },
  /** `sha256` of the device key, hex. */
  keyHash: { type: String, required: true },
  /** `active` or `blocked`. */
  status: { type: String, default: "active" },
  createdAt: { type: Number, required: true },
  createdBy: { type: String, default: null },
  /** When and by whom the device was blocked; null while it is active. */
  blockedAt: { type: Number, default: null },
  blockedBy: { type: String, default: null },
  renewedAt: { type: Number, default: null },
  renewedBy: { type: String, default: null },
  lastSeenAt: { type: Number, default: null },
};

module.exports = admissionDeviceSchemaDefinition;
