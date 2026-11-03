const mongoose = require("mongoose");
const def = require("../../schemas/jobStateSchema");

const { Schema } = mongoose;

const JobStateSchema = new Schema(def, { versionKey: false, minimize: false });

module.exports =
  mongoose.models.JobState || mongoose.model("JobState", JobStateSchema);
