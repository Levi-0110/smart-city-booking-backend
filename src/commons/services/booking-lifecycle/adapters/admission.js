/**
 * The admission adapter of the booking lifecycle seam (docs/admission.md,
 * "Issuance"): the passes of a booking's tickets, issued at `confirmed` and
 * voided with the booking, over `AdmissionIssuanceService` and the MongoDB
 * store. Both operations are recorded on failure, like the grant at an
 * access point: the booking stays confirmed, paid or cancelled, the failure
 * stands in the outcome and in the log, and a second run issues what is
 * missing. A booking without a tariff that issues passes, and without a
 * pass, answers the step as skipped.
 */

const {
  AdmissionIssuanceService,
} = require("../../admission/admission-issuance");
const { MongoAdmissionStore } = require("../../admission/admission-store");
const SecurityUtils = require("../../../utilities/security-utils");
const { SKIPPED } = require("../pipeline");

let service = null;

function issuance() {
  if (!service) {
    service = new AdmissionIssuanceService({
      store: new MongoAdmissionStore(),
      encrypt: (identifier) => SecurityUtils.encrypt(identifier),
    });
  }
  return service;
}

function assertTenant(tenantId, booking) {
  if (booking?.tenantId !== tenantId) {
    throw new Error(
      `admission: booking ${booking?.id} is not of tenant ${tenantId}`,
    );
  }
}

const admission = {
  /**
   * Makes the passes of the booking match what it books.
   *
   * @param {string} tenantId
   * @param {Object} booking The booking as the transition holds it
   * @returns {Promise<Object|symbol>} The passes changed, or `SKIPPED`
   */
  async issue(tenantId, booking) {
    assertTenant(tenantId, booking);
    return (await issuance().issue(booking)) ?? SKIPPED;
  },

  /**
   * Voids the passes of the booking with the booking's cause.
   *
   * @param {string} tenantId
   * @param {Object} booking
   * @param {string} cause One of the booking's `VOID_CAUSES`
   * @returns {Promise<Object|symbol>} The passes voided, or `SKIPPED`
   */
  async void(tenantId, booking, cause) {
    assertTenant(tenantId, booking);
    return (await issuance().void(booking, cause)) ?? SKIPPED;
  },
};

module.exports = admission;
