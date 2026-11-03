/**
 * The production adapters of the booking lifecycle seam (spec part 2,
 * section 10): thin shells around `BookingManager`, `AccessService`,
 * `AdmissionIssuanceService`, `document-issuance.js`, the payment
 * providers, the mail module (`compose` + `send`) and `WorkflowService`.
 */

module.exports = {
  store: require("./store"),
  access: require("./access"),
  admission: require("./admission"),
  documents: require("./documents"),
  payment: require("./payment"),
  mail: require("./mail"),
  workflow: require("./workflow"),
  clock: Date.now,
};
