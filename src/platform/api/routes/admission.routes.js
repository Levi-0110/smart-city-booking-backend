const express = require("express");
const router = express.Router({ mergeParams: true });
const { tokenAuthorized } = require("../../../commons/services/authorization");
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

module.exports = router;
