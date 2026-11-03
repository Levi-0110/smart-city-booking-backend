const mongoose = require("mongoose");
const def = require("../../schemas/admissionCheckSchema");

const { Schema } = mongoose;

const AdmissionCheckSchema = new Schema(def, {
  versionKey: false,
  minimize: false,
});

AdmissionCheckSchema.index({ tenantId: 1, scanId: 1 }, { unique: true });
AdmissionCheckSchema.index({ tenantId: 1, passId: 1, at: 1 });

module.exports =
  mongoose.models.AdmissionCheck ||
  mongoose.model("AdmissionCheck", AdmissionCheckSchema);
