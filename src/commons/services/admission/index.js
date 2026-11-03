/**
 * Admission management (Einlass- und Gültigkeitsmanagement): the passes a
 * booking issues, and their check at the entrance of a facility.
 *
 * - `terms`: what a tariff grants and what a pass keeps of it.
 * - `code`: the access identifier and the QR payload of a ticket.
 * - `state`: usage log, projection and state of a pass.
 * - `check`: the admission check in its six steps.
 * - `reasons`: the vocabulary and the German texts of the results.
 *
 * All five are pure; storage, devices and routes build on them.
 */
module.exports = {
  terms: require("./admission-terms"),
  code: require("./admission-code"),
  state: require("./admission-state"),
  check: require("./admission-check"),
  reasons: require("./admission-reasons"),
};
