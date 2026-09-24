const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { inspectScripts } = require("./dacfxService");
const { writeSqlFileSync } = require("./sqlFileEncoding");
const { buildProfileOutputBasePath, buildRunRoot } = require("./scriptAutomationService");

function objectKey(item) {
  return [item.objectType, item.schemaName, item.objectName].join("|").toLowerCase();
}

async function loadFolderSource(folderPath) {
  if (typeof folderPath !== "string" || !folderPath.trim()) throw new Error("Choose a SQL source folder.");
  const root = path.resolve(folderPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("The source must be a regular folder, not a symbolic link.");
  const inputs = [];
  let totalBytes = 0;
  async function scan(directory, depth = 0) {
    if (depth > 12) throw new Error("The SQL folder exceeds the maximum nesting depth (12).");
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in SQL folders: ${entry.name}`);
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["deployment scripts", ".git", "node_modules"].includes(entry.name.toLowerCase())) continue;
        await scan(fullPath, depth + 1);
      } else if (entry.isFile() && /\.sql$/i.test(entry.name) && !/^AllStoredProcedures_/i.test(entry.name)) {
        const stat = await fs.promises.stat(fullPath);
        totalBytes += stat.size;
        if (stat.size > 5 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024 || inputs.length >= 5000) throw new Error("SQL folders are limited to 5000 files, 5 MB per file, and 32 MB total.");
        inputs.push({ fileName: path.relative(root, fullPath), sqlText: (await fs.promises.readFile(fullPath, "utf8")).replace(/^\uFEFF/, "") });
      }
    }
  }
  await scan(root);
  if (!inputs.length) throw new Error("No per-object SQL files were found in this folder.");
  const scripts = await inspectScripts(inputs);
  if (!Array.isArray(scripts) || scripts.length !== inputs.length) throw new Error("Folder inspection returned an incomplete object catalog.");
  const seen = new Set();
  for (const script of scripts) {
    if (!inputs.some((input) => input.fileName === script.fileName) || !script.objectType || !script.schemaName || !script.objectName) throw new Error("Folder inspection returned invalid metadata.");
    const key = objectKey(script);
    if (seen.has(key)) throw new Error(`Duplicate or case-ambiguous folder object: ${script.schemaName}.${script.objectName}. Choose a single database export folder.`);
    seen.add(key);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([root, inputs])).digest("hex");
  return {
    kind: "Folder", folderPath: root, folderFingerprint: fingerprint, folderScripts: scripts,
    id: `folder:${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    profileLabel: `Folder - ${path.basename(root)}`, serverName: "(folder)", databaseName: path.basename(root),
  };
}

function selectFolderScripts(profile, selectedObjects) {
  const catalog = new Map(profile.folderScripts.map((script) => [objectKey(script), script]));
  const seen = new Set();
  return selectedObjects.map((item) => {
    const key = objectKey(item);
    const script = catalog.get(key);
    if (!script) throw new Error(`Object not found in folder: ${item.objectType} ${item.schemaName}.${item.objectName}`);
    if (seen.has(key)) return null;
    seen.add(key);
    return script;
  }).filter(Boolean);
}

async function materializeFolderSource({ profile, selectedObjects, outputBasePath }) {
  const selected = selectFolderScripts(profile, selectedObjects);
  const runRoot = buildRunRoot(buildProfileOutputBasePath(outputBasePath, profile.profileLabel), profile.databaseName);
  const relativeOutput = path.relative(profile.folderPath, runRoot);
  if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) throw new Error("Folder-source output must be outside the source folder.");
  const scripts = [];
  for (const source of selected) {
    const scriptPath = path.resolve(runRoot, source.fileName);
    const relative = path.relative(runRoot, scriptPath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Invalid source artifact path.");
    await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
    writeSqlFileSync(scriptPath, source.definitionText);
    scripts.push({ ...source, scriptPath });
  }
  let combinedStoredProceduresPath = null;
  if (scripts.some((script) => script.objectType === "PROCEDURE")) {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("");
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((value) => String(value).padStart(2, "0")).join("");
    combinedStoredProceduresPath = path.join(runRoot, `AllStoredProcedures_${date}_${time}.sql`);
    writeSqlFileSync(combinedStoredProceduresPath, require("./scriptGenerationService").buildCombinedStoredProcedureText(scripts));
  }
  return { generated: { runRoot, latestBuildPathFile: null }, scripts, selectedObjects: selected,
    combinedStoredProceduresPath, formattingApplied: false, generationWarnings: [] };
}

module.exports = { loadFolderSource, selectFolderScripts, materializeFolderSource };