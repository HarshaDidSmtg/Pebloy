const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectJavaScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const files = ["src", "public", "scripts"]
  .flatMap((directory) => collectJavaScriptFiles(path.join(projectRoot, directory)))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error) {
    console.error(`Unable to syntax-check ${path.relative(projectRoot, file)}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Syntax checked ${files.length} JavaScript files.`);