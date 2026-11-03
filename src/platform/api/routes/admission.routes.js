const express = require("express");
const router = express.Router({ mergeParams: true });
const {
  authorize,
  tokenAuthorized,
} = require("../../../commons/services/authorization");
const AdmissionController = require("../controllers/admission-controller");

// A device at the entrance authorizes itself with the key it was registered
// with (`Authorization: Device <key>`), not with a session: the route is
// token-authorized, the device middleware decides (Pos. 4.2).
router.post(
  "/checks",
  tokenAuthorized(),
  AdmissionController.deviceAuth,
  AdmissionController.check,
);

// The devices at the entrances: read by whoever may read bookables, as the
// access points are; registered, blocked and renewed by the tenant owner. A
// registration and a renewal answer the device's key, once.
router.get(
  "/devices",
  authorize("admission", "read"),
  AdmissionController.getDevices,
);

router.post(
  "/devices",
  authorize("admission", "write"),
  AdmissionController.registerDevice,
);

router.post(
  "/devices/:deviceId/block",
  authorize("admission", "write"),
  AdmissionController.blockDevice,
);

router.post(
  "/devices/:deviceId/unblock",
  authorize("admission", "write"),
  AdmissionController.unblockDevice,
);

router.post(
  "/devices/:deviceId/renew",
  authorize("admission", "write"),
  AdmissionController.renewDeviceKey,
);

// The admission settings of the facilities: business day, time zone, maximum
// stay, exit scan and the thresholds of the notices.
router.get(
  "/facilities",
  authorize("admission", "read"),
  AdmissionController.getFacilities,
);

router.get(
  "/facilities/:facilityId",
  authorize("admission", "read"),
  AdmissionController.getFacility,
);

router.put(
  "/facilities/:facilityId",
  authorize("admission", "write"),
  AdmissionController.putFacility,
);

module.exports = router;
