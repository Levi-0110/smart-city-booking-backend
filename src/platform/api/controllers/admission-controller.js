const {
  AdmissionCheckService,
} = require("../../../commons/services/admission/admission-check-service");
const {
  MongoAdmissionStore,
} = require("../../../commons/services/admission/admission-store");
const {
  deviceAuth,
} = require("../../../commons/services/admission/admission-devices");

const store = new MongoAdmissionStore();
const checks = new AdmissionCheckService({ store });

/**
 * The routes of the devices at the entrances (Pos. 4.1 to 4.3). The device
 * authorizes itself with its key; the answer is the check's, for the device
 * to show and, later, for a turnstile to act on (Pos. 1.3).
 */
class AdmissionController {
  /** 401, 403 or 429 unless a device of this tenant may check. */
  static deviceAuth = deviceAuth({ store });

  static async check(request, response, next) {
    try {
      const { code, scanId, direction } = request.body ?? {};
      const answer = await checks.check({
        tenantId: request.params.tenant,
        device: request.admissionDevice,
        code,
        scanId,
        direction,
      });
      return response.status(200).json(answer);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = AdmissionController;
