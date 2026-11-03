const AccessProvider = require("./access-provider");
const { ADMISSION_PROVIDER } = require("../../admission/admission-app");

/**
 * The devices at the entrances (glossary "Einlassgerät") as access points of
 * the provider `admission`. The platform never opens, closes or grants
 * anything at them: a device asks the platform whether a scanned pass may
 * enter, through the machine access of the tenant's access application
 * `admission` (docs/admission.md). So the provider declares no capability;
 * it is registered so that the access point of a device is stored and
 * validated like every other one and shows in the access log under its own
 * name.
 */
class AdmissionAccessProvider extends AccessProvider {
  static get capabilities() {
    return [];
  }
}

module.exports = AdmissionAccessProvider;
module.exports.PROVIDER_ID = ADMISSION_PROVIDER;
