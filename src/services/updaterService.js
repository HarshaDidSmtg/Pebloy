"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

function isTrustedDownloadUrl(value, redirect = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return (url.hostname === "github.com" && url.pathname.startsWith("/HarshaDidSmtg/Pebloy/releases/download/")) ||
      (redirect && ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname));
  } catch (_error) {
    return false;
  }
}

async function readAuthenticodeSignature(filePath) {
  const powershellPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; $signature = Get-AuthenticodeSignature -LiteralPath $env:PEBLOY_INSTALLER_PATH; @{ status = [string]$signature.Status; thumbprint = [string]$signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress"], {
    env: { ...process.env, PEBLOY_INSTALLER_PATH: filePath }, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function verifyInstaller(filePath, digest, { readSignature = readAuthenticodeSignature, applicationPath = process.execPath } = {}) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  if (`sha256:${hash.digest("hex")}` !== digest.toLowerCase()) {
    throw new Error("Installer integrity verification failed. The file will not be launched.");
  }
  const [installer, installed] = await Promise.all([readSignature(filePath), readSignature(applicationPath)]);
  if (installer?.status !== "Valid" || installed?.status !== "Valid" ||
      !/^[a-f0-9]{40}$/i.test(installed?.thumbprint || "") ||
      String(installer?.thumbprint || "").toLowerCase() !== installed.thumbprint.toLowerCase()) {
    throw new Error("Installer signature does not match the trusted installed application signer. Unsigned builds and certificate changes require a separately verified manual installation.");
  }
}

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
    canInstall: Boolean(hasUpdate && installer && isTrustedDownloadUrl(installer.browser_download_url) && /^sha256:[a-f0-9]{64}$/i.test(installer.digest || "")),
    digest: installer?.digest || null,
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
      if (!isTrustedDownloadUrl(url, hops > 0)) {
        fail(new Error("Update download URL is not a trusted HTTPS release asset."));
        return;
      }
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
          if (received > 512 * 1024 * 1024) {
            res.destroy(new Error("Update download exceeds 512 MB."));
            return;
          }
          if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("Update download was interrupted.")));
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
  digest,
  shell,
  quit,
  currentVersion = "0.0.0",
  downloadFileFn = downloadFile,
  verifyInstallerFn = verifyInstaller,
  onProgress = null,
  setTimeoutFn = setTimeout,
  tempDir = os.tmpdir(),
  userAgent = `Pebloy/${currentVersion}`,
} = {}) {
  if (!downloadUrl) throw new Error("No update installer download URL was provided.");
  if (!isTrustedDownloadUrl(downloadUrl) || !/^sha256:[a-f0-9]{64}$/i.test(digest || "")) {
    throw new Error("A verified GitHub release URL and SHA-256 digest are required for installation.");
  }
  if (!shell || typeof shell.openPath !== "function") throw new Error("Updater launch requires Electron shell.openPath.");

  const downloadDir = fs.mkdtempSync(path.join(tempDir, "pebloy-update-"));
  const destPath = path.join(downloadDir, getInstallerFileName(downloadUrl));
  try {
    await downloadFileFn(downloadUrl, destPath, { onProgress, userAgent });
    await verifyInstallerFn(destPath, digest);
  } catch (error) {
    fs.rmSync(downloadDir, { recursive: true, force: true });
    throw error;
  }

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
  isTrustedDownloadUrl,
  verifyInstaller,
  buildUpdateInfo,
  checkForUpdates,
  compareVersions,
  downloadAndLaunchInstaller,
  downloadFile,
  extractSemanticVersion,
  getInstallerFileName,
  pickInstallerAsset,
};