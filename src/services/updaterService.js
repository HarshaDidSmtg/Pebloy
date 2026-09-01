"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

function extractSemanticVersion(value) {
  const match = String(value || "").match(/v?(\d+(?:\.\d+){0,2})(?:[^\d]|$)/i);
  if (!match) return null;
  const parts = match[1].split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

function versionParts(value) {
  const version = extractSemanticVersion(value);
  if (!version) return null;
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) {
    throw new Error(`Invalid semantic version comparison: '${a}' vs '${b}'.`);
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function buildLatestReleaseUrl(owner, repo, apiBase = DEFAULT_GITHUB_API_BASE) {
  return `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
}

function requestJson(url, { userAgent = "Pebloy", timeoutMs = 30000, httpsModule = https } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsModule.get(url, { headers: { "User-Agent": userAgent } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API request failed: HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_error) {
          reject(new Error("Invalid JSON from GitHub API."));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("GitHub API request timed out.")));
    req.on("error", reject);
  });
}

function pickInstallerAsset(assets = []) {
  const executableAssets = (assets || []).filter((asset) => {
    const name = String(asset?.name || "");
    return /\.exe$/i.test(name) && asset?.browser_download_url;
  });
  return executableAssets.find((asset) => /setup|installer/i.test(asset.name) && !/portable/i.test(asset.name))
    || executableAssets.find((asset) => !/portable/i.test(asset.name))
    || executableAssets[0]
    || null;
}

function resolveReleaseVersion(release = {}) {
  return extractSemanticVersion(release.tag_name) || extractSemanticVersion(release.name);
}

function buildUpdateInfo(release, currentVersion) {
  if (release?.message === "Not Found") {
    throw new Error("No releases published yet.");
  }

  const latest = resolveReleaseVersion(release);
  if (!latest) {
    throw new Error("Latest GitHub release does not use a semantic version tag or name.");
  }

  const hasUpdate = compareVersions(latest, currentVersion) > 0;
  const installer = pickInstallerAsset(Array.isArray(release.assets) ? release.assets : []);

  return {
    current: extractSemanticVersion(currentVersion) || String(currentVersion || ""),
    latest,
    hasUpdate,
    canInstall: Boolean(hasUpdate && installer),
    downloadUrl: installer ? installer.browser_download_url : null,
    installerAssetName: installer ? installer.name : null,
    releaseName: release.name || `v${latest}`,
    releaseNotes: String(release.body || "").slice(0, 500),
    releaseUrl: release.html_url || "",
  };
}

async function checkForUpdates({
  currentVersion,
  owner,
  repo,
  apiBase = DEFAULT_GITHUB_API_BASE,
  fetchRelease = requestJson,
  userAgent = `Pebloy/${currentVersion}`,
} = {}) {
  if (!currentVersion || !owner || !repo) {
    throw new Error("Updater check requires currentVersion, owner, and repo.");
  }
  const release = await fetchRelease(buildLatestReleaseUrl(owner, repo, apiBase), { userAgent });
  return buildUpdateInfo(release, currentVersion);
}

function getInstallerFileName(downloadUrl) {
  try {
    const url = new URL(downloadUrl);
    const fileName = path.basename(decodeURIComponent(url.pathname));
    return /\.exe$/i.test(fileName) ? fileName.replace(/[<>:"/\\|?*]+/g, "_") : "PebloySetup.exe";
  } catch (_error) {
    return "PebloySetup.exe";
  }
}

function removePartialFile(filePath, callback) {
  fs.rm(filePath, { force: true }, () => callback());
}

function downloadFile(downloadUrl, destPath, {
  httpModule = http,
  httpsModule = https,
  maxRedirects = 6,
  onProgress = null,
  timeoutMs = 120000,
  userAgent = "Pebloy",
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let file = null;

    function fail(error) {
      if (settled) return;
      settled = true;
      if (file) file.destroy();
      removePartialFile(destPath, () => reject(error));
    }

    function done() {
      if (settled) return;
      settled = true;
      resolve();
    }

    function fetch(url, hops = 0) {
      if (hops > maxRedirects) {
        fail(new Error("Too many redirects while downloading update."));
        return;
      }

      const transport = String(url).startsWith("https") ? httpsModule : httpModule;
      const req = transport.get(url, { headers: { "User-Agent": userAgent } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetch(new URL(res.headers.location, url).toString(), hops + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        file = fs.createWriteStream(destPath);
        const total = Number.parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;

        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.on("error", fail);
        file.on("error", fail);
        file.on("finish", () => file.close(done));
        res.pipe(file);
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error("Download timed out.")));
      req.on("error", fail);
    }

    fetch(downloadUrl);
  });
}

async function downloadAndLaunchInstaller({
  downloadUrl,
  shell,
  quit,
  currentVersion = "0.0.0",
  downloadFileFn = downloadFile,
  onProgress = null,
  setTimeoutFn = setTimeout,
  tempDir = os.tmpdir(),
  userAgent = `Pebloy/${currentVersion}`,
} = {}) {
  if (!downloadUrl) throw new Error("No update installer download URL was provided.");
  if (!shell || typeof shell.openPath !== "function") throw new Error("Updater launch requires Electron shell.openPath.");

  const destPath = path.join(tempDir, getInstallerFileName(downloadUrl));
  await downloadFileFn(downloadUrl, destPath, { onProgress, userAgent });

  const launchError = await shell.openPath(destPath);
  if (launchError) {
    throw new Error(`Installer launch failed: ${launchError}`);
  }

  if (typeof quit === "function") {
    setTimeoutFn(() => quit(), 1500);
  }
  return { ok: true, filePath: destPath };
}

module.exports = {
  buildUpdateInfo,
  checkForUpdates,
  compareVersions,
  downloadAndLaunchInstaller,
  downloadFile,
  extractSemanticVersion,
  getInstallerFileName,
  pickInstallerAsset,
};