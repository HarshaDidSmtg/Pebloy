const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ARTIFACT_DIR = process.env.ARTIFACTS_DIR || path.resolve(ROOT_DIR, "artifacts");
const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(ARTIFACT_DIR, "exports");
const CODEDIFF_DIR = process.env.CODEDIFF_DIR || path.join(EXPORTS_DIR, "codediff");

module.exports = {
  ROOT_DIR,
  ARTIFACT_DIR,
  EXPORTS_DIR,
  CODEDIFF_DIR,
};
