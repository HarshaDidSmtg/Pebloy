const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { Data, NtExecutable, NtExecutableResource, Resource } = require("resedit");

async function readTaskbarDetails(desktop) {
  const handle = await desktop.evaluate(({ BrowserWindow }) => {
    const nativeHandle = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
    return nativeHandle.length === 8 ? nativeHandle.readBigUInt64LE().toString() : nativeHandle.readUInt32LE().toString();
  });
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-File",
    path.resolve("tests", "powershell", "Get-TaskbarDetails.ps1"), "-WindowHandle", handle,
  ], { encoding: "utf8", timeout: 20000, windowsHide: true }));
}

test("local desktop exposes the Pebloy taskbar identity and icon", async () => {
  test.setTimeout(90000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-local-desktop-"));
  let desktop;
  try {
    desktop = await electron.launch({
      args: [path.resolve(".")],
      env: { ...process.env, PEBLOY_RUNTIME_ROOT: directory, PORT: "4411" },
    });
    const page = await desktop.firstWindow();
    await expect(page.locator(".app-logo")).toBeVisible();
    const details = await readTaskbarDetails(desktop);
    expect(details.appId).toBe("com.pebloy.app");
    expect(details.displayName).toBe("Pebloy");
    expect(details.iconResource.replace(/"/g, "")).toBe(`${path.resolve("build", "icon.ico")},0`);
    expect(details.relaunchCommand).toBe(`"${path.resolve("node_modules", "electron", "dist", "electron.exe")}" "${path.resolve(".")}"`);
  } finally {
    if (desktop) await desktop.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local desktop closes without prompting for unsaved formatter SQL", async () => {
  test.setTimeout(60000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-local-close-"));
  const dialogMarker = path.join(directory, "unexpected-dialog.txt");
  let desktop;
  try {
    desktop = await electron.launch({
      args: [path.resolve(".")],
      env: { ...process.env, PEBLOY_RUNTIME_ROOT: directory, PORT: "4412" },
    });
    const page = await desktop.firstWindow();
    await page.locator('[data-tab="formatter"]').click();
    const editor = page.locator("#formatterEditorStage .monaco-editor:visible").first();
    await editor.locator("textarea").focus();
    await page.keyboard.insertText("SELECT 1;");
    await desktop.evaluate(({ dialog }, markerPath) => {
      const fs = process.getBuiltinModule("fs");
      dialog.showMessageBoxSync = (_window, options) => {
        fs.writeFileSync(markerPath, options?.message || "dialog shown", "utf8");
        return 1;
      };
    }, dialogMarker);

    const closed = page.waitForEvent("close");
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;

    expect(fs.existsSync(dialogMarker)).toBe(false);
  } finally {
    if (desktop) await desktop.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged desktop starts and authorizes formatter file writes", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "packaged", "Packaged-only native test");
  test.setTimeout(60000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-desktop-"));
  let desktop;
  try {
    desktop = await electron.launch({
      executablePath: path.resolve("dist", "win-unpacked", "Pebloy.exe"),
      env: { ...process.env, PEBLOY_RUNTIME_ROOT: directory, PORT: "4409" },
    });
    const page = await desktop.firstWindow();
    await expect(page.locator('[data-tab="formatter"]')).toBeVisible();
    const details = await readTaskbarDetails(desktop);
    expect(details.appId).toBe("com.pebloy.app");
    expect(details.displayName).toBe("Pebloy");
    expect(details.iconResource.replace(/"/g, "")).toBe(`${path.resolve("dist", "win-unpacked", "Pebloy.exe")},0`);
    expect(details.relaunchCommand).toBe(`"${path.resolve("dist", "win-unpacked", "Pebloy.exe")}"`);
    await expect(page.locator(".app-logo")).toBeVisible();
    await expect.poll(() => page.locator(".app-logo").evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const branding = await desktop.evaluate(async ({ app, nativeImage }) => {
      const fs = process.getBuiltinModule("fs");
      const path = process.getBuiltinModule("path");
      const { createHash } = process.getBuiltinModule("crypto");
      const asset = (name) => path.join(app.getAppPath(), "public", name);
      const digest = (name) => createHash("sha256").update(fs.readFileSync(asset(name))).digest("hex");
      const icon = await app.getFileIcon(process.execPath, { size: "large" });
      return {
        pngSize: nativeImage.createFromPath(asset("logo.png")).getSize(),
        pngHash: digest("logo.png"), svgHash: digest("logo.svg"),
        windowsIcon: icon.toPNG().toString("base64"),
      };
    });
    expect(branding.pngSize).toEqual({ width: 512, height: 512 });
    for (const extension of ["png", "svg"]) {
      const expected = createHash("sha256").update(fs.readFileSync(path.resolve("public", `logo.${extension}`))).digest("hex");
      expect(branding[`${extension}Hash`]).toBe(expected);
    }
    const executable = NtExecutable.from(fs.readFileSync(path.resolve("dist", "win-unpacked", "Pebloy.exe")), { ignoreCert: true });
    const entries = NtExecutableResource.from(executable).entries;
    const groups = Resource.IconGroupEntry.fromEntries(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].icons.map((icon) => icon.width || 256).sort((left, right) => left - right)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    for (const sourceIcon of Data.IconFile.from(fs.readFileSync(path.resolve("build", "icon.ico"))).icons) {
      const embeddedIcon = groups[0].icons.find((icon) => (icon.width || 256) === sourceIcon.data.width);
      expect(embeddedIcon.bitCount).toBe(32);
      const entry = entries.find((entry) => entry.type === 3 && entry.id === embeddedIcon.iconID && entry.lang === groups[0].lang);
      const sourceBytes = sourceIcon.data.bin || sourceIcon.data.generate();
      expect(Buffer.from(entry.bin)).toEqual(Buffer.from(sourceBytes));
    }
    expect(branding.windowsIcon).toBeTruthy();
    fs.writeFileSync(testInfo.outputPath("packaged-windows-icon.png"), Buffer.from(branding.windowsIcon, "base64"));
    await page.locator(".brand-wrap").screenshot({ path: testInfo.outputPath("packaged-logo.png") });
    const target = path.join(directory, "formatted.sql");
    await desktop.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    const saved = await page.evaluate(() => window.electronAPI.saveFile({ content: "SELECT N'A  B';" }));
    expect(saved.fileToken).toBeTruthy();
    expect(fs.readFileSync(target, "utf8")).toBe("SELECT N'A  B';");
    await page.evaluate((fileToken) => window.electronAPI.overwriteFile({ fileToken, content: "SELECT 2;" }), saved.fileToken);
    expect(fs.readFileSync(target, "utf8")).toBe("SELECT 2;");
    await expect(page.evaluate(() => window.electronAPI.overwriteFile({ fileToken: "forged", content: "no" }))).rejects.toThrow("authorization expired");
    fs.writeFileSync(target, "external change");
    await expect(page.evaluate((fileToken) => window.electronAPI.overwriteFile({ fileToken, content: "no" }), saved.fileToken)).rejects.toThrow("changed outside Pebloy");
    expect(fs.readFileSync(target, "utf8")).toBe("external change");
    const folderSource = path.join(directory, "sql-source");
    fs.mkdirSync(folderSource);
    fs.writeFileSync(path.join(folderSource, "PackagedView.sql"), "CREATE VIEW reporting.PackagedView AS SELECT 1 AS Id;", "utf8");
    const catalog = await page.evaluate((folderPath) => api("/api/sources/folder", { method: "POST", body: JSON.stringify({ folderPath }) }), folderSource);
    expect(catalog.objects).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "VIEW", schemaName: "reporting", objectName: "PackagedView" })]));
    const scheduleState = await page.evaluate(() => api("/api/schedules"));
    expect(scheduleState.items).toEqual([]);
    expect(scheduleState.enabled).toBe(false);
    expect(scheduleState.capabilities.wakeApplication).toBe(true);
    await page.locator('[data-tab="deploy"]').click();
    await expect(page.locator("#scheduleSection")).toBeHidden();
    await page.evaluate(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ features: { schedules: true } }) }));
    await page.reload();
    await page.locator('[data-tab="deploy"]').click();
    await expect(page.locator("#saveSchedule")).toBeVisible();
    // Startup restores the saved target mode; retry until that restoration has finished.
    await expect(async () => {
      await page.locator("#deployTargetMode").selectOption("multiple");
      await expect(page.locator("#deployBatchSection")).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(page.locator("#saveSchedule")).toBeVisible();
    await expect(page.locator("#scheduleWake")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("packaged-desktop.png") });
  } finally {
    if (desktop) await desktop.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});