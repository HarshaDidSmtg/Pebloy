#!/usr/bin/env node
"use strict";

// Workaround for electron-builder's winCodeSign symlink extraction failure on
// Windows without Developer Mode. The archive contains two macOS .dylib
// symlinks that fail with exit code 2. electron-builder treats any non-zero
// exit as fatal and retries 4 times before giving up.
//
// Strategy: pre-extract the archive ourselves (accepting exit 2), then place
// the result in the path electron-builder expects so it skips the download.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const WIN_CODE_SIGN_VERSION = "2.6.0";
const cacheDir = path.join(
  process.env.LOCALAPPDATA || path.join(require("os").homedir(), "AppData", "Local"),
  "electron-builder",
  "Cache",
  "winCodeSign"
);
const targetDir = path.join(cacheDir, `winCodeSign-${WIN_CODE_SIGN_VERSION}`);

if (fs.existsSync(targetDir)) {
  const hasSignTool = fs.existsSync(path.join(targetDir, "windows-10", "x64", "signtool.exe"));
  if (hasSignTool) {
    console.log(`[prebuild] winCodeSign cache already present at: ${targetDir}`);
    process.exit(0);
  }
}

const sevenZa = path.join(__dirname, "..", "node_modules", "7zip-bin", "win", "x64", "7za.exe");
if (!fs.existsSync(sevenZa)) {
  console.warn(`[prebuild] 7za.exe not found at ${sevenZa}; skipping winCodeSign pre-extraction.`);
  process.exit(0);
}

// Check for an already-downloaded archive in the cache dir (any filename).
let archivePath = null;
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    if (f.endsWith(".7z")) {
      archivePath = path.join(cacheDir, f);
      break;
    }
  }
}

if (!archivePath) {
  console.log("[prebuild] winCodeSign archive not yet downloaded; electron-builder will handle it.");
  console.log("[prebuild] If the build fails with symlink errors, run: npm run build (it retries).");
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });

console.log(`[prebuild] Extracting ${archivePath} → ${targetDir} (ignoring symlink errors)`);
try {
  execFileSync(sevenZa, ["x", "-bd", "-y", archivePath, `-o${targetDir}`], { stdio: "inherit" });
} catch (err) {
  if (err.status === 2) {
    // Only macOS dylib symlinks fail; Windows tools extract fine.
    console.log("[prebuild] Extraction completed with exit 2 (macOS symlink skips — safe to ignore).");
  } else {
    console.error(`[prebuild] Extraction failed with exit ${err.status}`);
    process.exit(err.status || 1);
  }
}

// Flatten if electron-builder nests under a sub-directory named by hash.
for (const entry of fs.readdirSync(targetDir)) {
  const sub = path.join(targetDir, entry);
  if (fs.statSync(sub).isDirectory() && !entry.startsWith("windows") && !entry.startsWith("darwin")) {
    for (const item of fs.readdirSync(sub)) {
      fs.renameSync(path.join(sub, item), path.join(targetDir, item));
    }
    try { fs.rmdirSync(sub); } catch {}
  }
}

const ok = fs.existsSync(path.join(targetDir, "windows-10", "x64", "signtool.exe"));
if (ok) {
  console.log("[prebuild] winCodeSign ready.");
} else {
  console.warn("[prebuild] winCodeSign extracted but signtool.exe not found — build may still work.");
}
