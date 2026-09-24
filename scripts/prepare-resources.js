const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { ensureSqlServerModule } = require("../src/services/scriptAutomationService");

async function ensureAppIcon(root) {
  const sourcePath = path.join(root, "public", "logo.svg");
  fs.accessSync(sourcePath, fs.constants.R_OK);
  const { runIconsTool } = require("app-builder-lib/out/toolsets/icons");
  const { convertIcon } = require("app-builder-lib/out/util/iconConverter");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-icons-"));
  try {
    await runIconsTool({ inputFile: sourcePath, outputFormat: "set", outDir: output });
    const result = await convertIcon({
      sources: [sourcePath], fallbackSources: [],
      roots: [root], format: "ico", outDir: output,
    });
    const pngPath = path.join(output, "512x512.png");
    const iconPath = path.join(output, "icon.ico");
    if (!result.icons.length || !fs.existsSync(pngPath) || !fs.existsSync(iconPath)) {
      throw new Error("Could not generate the PNG and Windows icon from public/logo.svg.");
    }
    fs.mkdirSync(path.join(root, "build"), { recursive: true });
    fs.copyFileSync(pngPath, path.join(root, "public", "logo.png"));
    fs.copyFileSync(iconPath, path.join(root, "build", "icon.ico"));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

async function prepareResources() {
  const root = path.resolve(__dirname, "..");
  await ensureAppIcon(root);
  if (!fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe"))) {
    throw new Error("The Electron runtime used for packaging is missing. Run npm ci before building.");
  }
  await ensureSqlServerModule();
  const output = path.join(root, "build", "dacfx-worker", "win-x64");
  execFileSync("dotnet", ["publish", path.join(root, "src", "dacfx-worker", "Pebloy.DacFx.Worker.csproj"),
    "--configuration", "Release", "--runtime", "win-x64", "--self-contained", "true", "--output", output,
  ], { stdio: "inherit", timeout: 300000 });
  if (!fs.existsSync(path.join(output, "Pebloy.DacFx.Worker.exe"))) throw new Error("Published DacFx executable is missing.");
  console.log("Self-contained DacFx worker and pinned SqlServer module are ready for packaging.");
}

if (require.main === module) {
  prepareResources().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { ensureAppIcon };