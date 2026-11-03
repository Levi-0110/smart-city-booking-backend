const mongoose = require("mongoose");
const def = require("../../schemas/admissionEventSchema");

const { Schema } = mongoose;

const AdmissionEventSchema = new Schema(def, {
  versionKey: false,
  minimize: false,
});

// The optimistic lock of a pass: one event per position of its log.
AdmissionEventSchema.index(
  { tenantId: 1, passId: 1, seq: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.AdmissionEvent ||
  mongoose.model("AdmissionEvent", AdmissionEventSchema);
