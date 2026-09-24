const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ROOT_DIR } = require("./paths");

const DACFX_RESOURCE_DIR = "dacfx-worker";
const DACFX_EXE_NAME = "Pebloy.DacFx.Worker.exe";
const DACFX_DLL_NAME = "Pebloy.DacFx.Worker.dll";
const DACFX_PROJECT_PATH = path.join(ROOT_DIR, "src", "dacfx-worker", "Pebloy.DacFx.Worker.csproj");
const DACFX_DEV_PUBLISH_DIR = path.join(ROOT_DIR, "build", "dacfx-worker", "win-x64");
const DACFX_DIST_RESOURCE_DIR = path.join(ROOT_DIR, "dist", "win-unpacked", "resources", DACFX_RESOURCE_DIR);

function normalizeEngine(value, fallback = "DacFx") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (normalized === "legacy") return "Legacy";
  return "DacFx";
}

function isDacFxEngine(value) {
  return normalizeEngine(value) === "DacFx";
}

function quoteConnectionValue(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function buildConnectionString(profile) {
  const authType = String(profile.authenticationType || "Windows").trim().toLowerCase();
  const parts = [
    `Data Source=${quoteConnectionValue(`tcp:${profile.serverName || ""}`)}`,
    `Initial Catalog=${quoteConnectionValue(profile.databaseName)}`,
    "TrustServerCertificate=True",
    "Encrypt=False",
    "Connect Timeout=30",
    "Application Name=Pebloy",
  ];

  if (authType === "sql") {
    parts.push(`User ID=${quoteConnectionValue(profile.username)}`);
    parts.push(`Password=${quoteConnectionValue(profile.password)}`);
    parts.push("Integrated Security=False");
  } else {
    parts.push("Integrated Security=True");
  }

  return parts.join(";");
}

function buildWorkerLaunch() {
  const resourcesPath = process.env.PEBLOY_RESOURCES_PATH || process.resourcesPath;
  const resourceBase = resourcesPath ? path.join(resourcesPath, DACFX_RESOURCE_DIR) : null;
  const packagedExe = resourceBase ? path.join(resourceBase, DACFX_EXE_NAME) : null;
  const packagedDll = resourceBase ? path.join(resourceBase, DACFX_DLL_NAME) : null;
  if (packagedExe && fs.existsSync(packagedExe)) {
    return { command: packagedExe, args: [] };
  }
  if (packagedDll && fs.existsSync(packagedDll)) {
    return { command: "dotnet", args: [packagedDll] };
  }
  if (process.env.PEBLOY_RESOURCES_PATH) throw new Error("The packaged DacFx worker is missing. Repair the Pebloy installation.");

  const devExe = path.join(DACFX_DEV_PUBLISH_DIR, DACFX_EXE_NAME);
  const devDll = path.join(DACFX_DEV_PUBLISH_DIR, DACFX_DLL_NAME);
  if (fs.existsSync(devExe)) {
    return { command: devExe, args: [] };
  }
  if (fs.existsSync(devDll)) {
    return { command: "dotnet", args: [devDll] };
  }

  if (fs.existsSync(DACFX_PROJECT_PATH)) {
    return {
      command: "dotnet",
      args: ["run", "--project", DACFX_PROJECT_PATH, "--configuration", "Release", "--no-launch-profile", "--"],
    };
  }

  const distExe = path.join(DACFX_DIST_RESOURCE_DIR, DACFX_EXE_NAME);
  const distDll = path.join(DACFX_DIST_RESOURCE_DIR, DACFX_DLL_NAME);
  if (fs.existsSync(distExe)) {
    return { command: distExe, args: [] };
  }
  if (fs.existsSync(distDll)) {
    return { command: "dotnet", args: [distDll] };
  }

  throw new Error("The DacFx worker project is not available in this build.");
}

function buildWorkerError(commandName, exitCode, stdout, stderr, parsedBody) {
  const workerMessage = parsedBody?.error?.message || parsedBody?.error?.detail;
  const terminalMessage = [String(stderr || "").trim(), String(stdout || "").trim()].filter(Boolean).join("\n");
  const detail = workerMessage || terminalMessage || `DacFx worker command '${commandName}' failed.`;
  const suffix = exitCode == null ? "" : ` (exit ${exitCode})`;
  return new Error(`DacFx ${commandName} failed${suffix}: ${detail}`);
}

function runWorker(commandName, payload) {
  const launch = buildWorkerLaunch();
  const requestBody = JSON.stringify({ command: commandName, payload });

  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      cwd: process.env.PEBLOY_RESOURCES_PATH || ROOT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure = null;
    const timeoutMs = commandName === "compare" ? 30000 : 120000;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill();
    };
    const timeout = setTimeout(() => stop(new Error(`DacFx ${commandName} timed out after ${timeoutMs} ms.`)), timeoutMs);

    const acceptChunk = (chunk) => {
      if (failure) return false;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 20 * 1024 * 1024) {
        stop(new Error(`DacFx ${commandName} output exceeded 20 MB.`));
        return false;
      }
      return true;
    };

    child.stdout.on("data", (chunk) => {
      if (acceptChunk(chunk)) stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      if (acceptChunk(chunk)) stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start DacFx worker: ${error.message}`));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (failure) { reject(failure); return; }
      let parsedBody = null;
      if (stdout.trim()) {
        try {
          parsedBody = JSON.parse(stdout);
        } catch (_error) {
          if (exitCode === 0) {
            reject(new Error(`DacFx ${commandName} returned non-JSON output: ${stdout.slice(0, 500)}`));
            return;
          }
        }
      }

      if (exitCode !== 0 || parsedBody?.success === false) {
        reject(buildWorkerError(commandName, exitCode, stdout, stderr, parsedBody));
        return;
      }

      if (!parsedBody || parsedBody.success !== true) {
        reject(new Error(`DacFx ${commandName} returned an empty response.`));
        return;
      }

      resolve(parsedBody.result);
    });

    child.stdin.on("error", (error) => stop(new Error(`Cannot send request to DacFx worker: ${error.message}`)));
    child.stdin.write(requestBody);
    child.stdin.end();
  });
}

function buildScriptPayload(scripts = []) {
  return (scripts || [])
    .map((script) => ({
      objectType: String(script.objectType || "").toUpperCase(),
      schemaName: String(script.schemaName || ""),
      objectName: String(script.objectName || ""),
      scriptPath: String(script.scriptPath || ""),
    }))
    .filter((script) => script.objectType && script.schemaName && script.objectName && script.scriptPath);
}

function buildPackageName(prefix, taskId) {
  const safeTaskId = String(taskId || "task").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}_${safeTaskId}`;
}

function buildTargetPayload(profile) {
  return {
    connectionString: buildConnectionString(profile),
    databaseName: String(profile.databaseName || ""),
  };
}

async function validateGeneratedArtifacts({ taskId, scripts }) {
  return runWorker("validate", {
    packageName: buildPackageName("PebloyValidate", taskId),
    scripts: buildScriptPayload(scripts),
  });
}

async function compareGeneratedArtifacts({ taskId, sourceScripts, destinationProfile }) {
  return runWorker("compare", {
    packageName: buildPackageName("PebloyCompare", taskId),
    scripts: buildScriptPayload(sourceScripts),
    target: buildTargetPayload(destinationProfile),
    options: {
      blockOnPossibleDataLoss: true,
      dropObjectsNotInSource: false,
      generateSmartDefaults: false,
    },
  });
}

async function deployGeneratedArtifacts({ taskId, sourceScripts, destinationProfile, mode }) {
  return runWorker("deploy", {
    packageName: buildPackageName("PebloyDeploy", taskId),
    scripts: buildScriptPayload(sourceScripts),
    target: buildTargetPayload(destinationProfile),
    options: {
      blockOnPossibleDataLoss: true,
      dropObjectsNotInSource: false,
      generateSmartDefaults: false,
    },
    mode,
  });
}

module.exports = {
  inspectScripts: (scripts) => runWorker("inspect", { scripts }),
  normalizeEngine,
  isDacFxEngine,
  buildConnectionString,
  validateGeneratedArtifacts,
  compareGeneratedArtifacts,
  deployGeneratedArtifacts,
};
