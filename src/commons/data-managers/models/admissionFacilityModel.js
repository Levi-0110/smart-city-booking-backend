const mongoose = require("mongoose");
const def = require("../../schemas/admissionFacilitySchema");

const { Schema } = mongoose;

const AdmissionFacilitySchema = new Schema(def, {
  versionKey: false,
  minimize: false,
});

AdmissionFacilitySchema.index({ tenantId: 1, facilityId: 1 }, { unique: true });

module.exports =
  mongoose.models.AdmissionFacility ||
  mongoose.model("AdmissionFacility", AdmissionFacilitySchema);
