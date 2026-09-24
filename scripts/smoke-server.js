const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-browser-"));
process.env.PORT = "4399";
process.env.DATA_DIR = path.join(temporaryRoot, "data");
process.env.ARTIFACTS_DIR = path.join(temporaryRoot, "artifacts");
for (const variable of ["LOGS_DIR", "EXPORTS_DIR", "SCRIPTS_DIR", "REPORTS_DIR", "TEMP_DIR", "CODEDIFF_DIR", "LOG_ARCHIVE_DIR"]) delete process.env[variable];
require("../src/services/scriptAutomationService").ensureSqlServerModule = async () => {};
process.once("exit", () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
require("../src/server");