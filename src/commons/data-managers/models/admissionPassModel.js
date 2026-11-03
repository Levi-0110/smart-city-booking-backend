const mongoose = require("mongoose");
const def = require("../../schemas/admissionPassSchema");

const { Schema } = mongoose;

const AdmissionPassSchema = new Schema(def, {
  versionKey: false,
  minimize: false,
});

AdmissionPassSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AdmissionPassSchema.index({ tenantId: 1, codeHash: 1 }, { unique: true });
AdmissionPassSchema.index({ tenantId: 1, retiredCodeHashes: 1 });
AdmissionPassSchema.index({ tenantId: 1, bookingId: 1 });
AdmissionPassSchema.index({
  tenantId: 1,
  facilityId: 1,
  "projection.presentSince": 1,
});

module.exports =
  mongoose.models.AdmissionPass ||
  mongoose.model("AdmissionPass", AdmissionPassSchema);
