const {
  AdmissionCheckService,
} = require("../../../commons/services/admission/admission-check-service");
const {
  MongoAdmissionStore,
} = require("../../../commons/services/admission/admission-store");
const {
  deviceAuth,
} = require("../../../commons/services/admission/admission-devices");
const {
  AdmissionAdministrationService,
} = require("../../../commons/services/admission/admission-administration");

const store = new MongoAdmissionStore();
const checks = new AdmissionCheckService({ store });
const administration = new AdmissionAdministrationService({ store });

/** Who acts in the administration, for the device's record. */
const byUser = (request) => ({ userId: request.user?.id ?? null });

/**
 * Sends an answer that carries a device key: shown once, never cached.
 */
function sendWithKey(response, status, body) {
  response.set("Cache-Control", "no-store");
  return response.status(status).json(body);
}

/**
 * The routes of admission. The devices at the entrances (Pos. 4.1 to 4.3)
 * authorize themselves with their key; the answer is the check's, for the
 * device to show and, later, for a turnstile to act on (Pos. 1.3). The
 * administration registers, blocks and renews the devices and keeps the
 * admission settings of the facilities (Pos. 4.2 to 4.4); who may do what is
 * the routes' (`admission.read`, `admission.write`).
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

  static async getDevices(request, response, next) {
    try {
      const devices = await administration.devices(request.params.tenant, {
        facilityId: request.query?.facilityId,
      });
      return response.status(200).json(devices);
    } catch (err) {
      return next(err);
    }
  }

  /** 201 with the device and its key, which no later answer shows again. */
  static async registerDevice(request, response, next) {
    try {
      const registered = await administration.registerDevice(
        request.params.tenant,
        request.body ?? {},
        byUser(request),
      );
      return sendWithKey(response, 201, registered);
    } catch (err) {
      return next(err);
    }
  }

  static async blockDevice(request, response, next) {
    try {
      const device = await administration.blockDevice(
        request.params.tenant,
        request.params.deviceId,
        byUser(request),
      );
      return response.status(200).json(device);
    } catch (err) {
      return next(err);
    }
  }

  static async unblockDevice(request, response, next) {
    try {
      const device = await administration.unblockDevice(
        request.params.tenant,
        request.params.deviceId,
      );
      return response.status(200).json(device);
    } catch (err) {
      return next(err);
    }
  }

  /** 200 with the device and its new key; the old key no longer works. */
  static async renewDeviceKey(request, response, next) {
    try {
      const renewed = await administration.renewDeviceKey(
        request.params.tenant,
        request.params.deviceId,
        byUser(request),
      );
      return sendWithKey(response, 200, renewed);
    } catch (err) {
      return next(err);
    }
  }

  static async getFacilities(request, response, next) {
    try {
      const facilities = await administration.facilities(request.params.tenant);
      return response.status(200).json(facilities);
    } catch (err) {
      return next(err);
    }
  }

  static async getFacility(request, response, next) {
    try {
      const settings = await administration.facilitySettings(
        request.params.tenant,
        request.params.facilityId,
      );
      return response.status(200).json(settings);
    } catch (err) {
      return next(err);
    }
  }

  static async putFacility(request, response, next) {
    try {
      const settings = await administration.saveFacilitySettings(
        request.params.tenant,
        request.params.facilityId,
        request.body ?? {},
      );
      return response.status(200).json(settings);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = AdmissionController;
