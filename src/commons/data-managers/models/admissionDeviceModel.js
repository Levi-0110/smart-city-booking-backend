const mongoose = require("mongoose");
const def = require("../../schemas/admissionDeviceSchema");

const { Schema } = mongoose;

const AdmissionDeviceSchema = new Schema(def, { versionKey: false });

AdmissionDeviceSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AdmissionDeviceSchema.index({ keyHash: 1 }, { unique: true });

module.exports =
  mongoose.models.AdmissionDevice ||
  mongoose.model("AdmissionDevice", AdmissionDeviceSchema);
