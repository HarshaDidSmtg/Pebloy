"use strict";

const path = require("path");

const {
  buildUpdateInfo,
  checkForUpdates,
  compareVersions,
  downloadAndLaunchInstaller,
  extractSemanticVersion,
  getInstallerFileName,
  pickInstallerAsset,
} = require("./updaterService");

describe("updaterService", () => {
  it("compares semantic versions with v-prefix support", () => {
    expect(compareVersions("v2.0.0", "1.3.2")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.3.2", "2.0.0")).toBeLessThan(0);
  });

  it("extracts a semantic version from release names", () => {
    expect(extractSemanticVersion("V1.3")).toBe("1.3.0");
    expect(extractSemanticVersion("Pebloy v2.0.0 release")).toBe("2.0.0");
    expect(extractSemanticVersion("Testing")).toBeNull();
  });

  it("prefers installable setup assets over portable executables", () => {
    const asset = pickInstallerAsset([
      { name: "Pebloy-2.0.0-portable.exe", browser_download_url: "https://example.test/portable.exe" },
      { name: "Pebloy-Setup.exe", browser_download_url: "https://example.test/setup.exe" },
    ]);

    expect(asset.name).toBe("Pebloy-Setup.exe");
  });

  it("builds update info with an installable download URL", () => {
    const info = buildUpdateInfo({
      tag_name: "v2.0.0",
      name: "Pebloy 2.0.0",
      html_url: "https://github.com/HarshaDidSmtg/Pebloy/releases/tag/v2.0.0",
      assets: [
        { name: "Pebloy-Setup.exe", browser_download_url: "https://example.test/Pebloy-Setup.exe" },
      ],
    }, "1.3.2");

    expect(info).toEqual(expect.objectContaining({
      current: "1.3.2",
      latest: "2.0.0",
      hasUpdate: true,
      canInstall: true,
      downloadUrl: "https://example.test/Pebloy-Setup.exe",
      installerAssetName: "Pebloy-Setup.exe",
    }));
  });

  it("reports an available update without install support when no exe asset exists", () => {
    const info = buildUpdateInfo({ tag_name: "v2.0.0", assets: [] }, "1.3.2");

    expect(info.hasUpdate).toBe(true);
    expect(info.canInstall).toBe(false);
    expect(info.downloadUrl).toBeNull();
  });

  it("checks GitHub releases through an injectable fetcher", async () => {
    const fetchRelease = jest.fn().mockResolvedValue({
      tag_name: "v2.0.0",
      assets: [{ name: "Pebloy-Setup.exe", browser_download_url: "https://example.test/setup.exe" }],
    });

    const info = await checkForUpdates({
      currentVersion: "1.3.2",
      owner: "HarshaDidSmtg",
      repo: "Pebloy",
      fetchRelease,
    });

    expect(fetchRelease).toHaveBeenCalledWith(
      "https://api.github.com/repos/HarshaDidSmtg/Pebloy/releases/latest",
      expect.objectContaining({ userAgent: "Pebloy/1.3.2" })
    );
    expect(info.canInstall).toBe(true);
  });

  it("sanitizes installer file names from download URLs", () => {
    expect(getInstallerFileName("https://example.test/releases/Pebloy-Setup.exe?download=1"))
      .toBe("Pebloy-Setup.exe");
    expect(getInstallerFileName("not-a-url")).toBe("PebloySetup.exe");
  });

  it("downloads, launches the installer, and schedules app quit", async () => {
    const downloadFileFn = jest.fn().mockResolvedValue(undefined);
    const openPath = jest.fn().mockResolvedValue("");
    const quit = jest.fn();
    const setTimeoutFn = jest.fn((callback) => callback());

    const result = await downloadAndLaunchInstaller({
      downloadUrl: "https://example.test/releases/Pebloy-Setup.exe",
      tempDir: path.join("C:", "Temp"),
      shell: { openPath },
      quit,
      currentVersion: "1.3.2",
      downloadFileFn,
      setTimeoutFn,
    });

    expect(downloadFileFn).toHaveBeenCalledWith(
      "https://example.test/releases/Pebloy-Setup.exe",
      expect.stringContaining("Pebloy-Setup.exe"),
      expect.objectContaining({ userAgent: "Pebloy/1.3.2" })
    );
    expect(openPath).toHaveBeenCalledWith(expect.stringContaining("Pebloy-Setup.exe"));
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 1500);
    expect(quit).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("fails when Windows cannot launch the downloaded installer", async () => {
    await expect(downloadAndLaunchInstaller({
      downloadUrl: "https://example.test/releases/Pebloy-Setup.exe",
      shell: { openPath: jest.fn().mockResolvedValue("Access denied") },
      quit: jest.fn(),
      downloadFileFn: jest.fn().mockResolvedValue(undefined),
    })).rejects.toThrow("Installer launch failed: Access denied");
  });
});