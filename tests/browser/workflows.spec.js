const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");

const selectedObject = { objectType: "VIEW", schemaName: "dbo", objectName: "Fixture" };

// Builds a report with the production diff engine; artifact paths point at a temp folder.
function buildEngineDiffReport(objects) {
  const fixtureRoot = path.join(os.tmpdir(), "pebloy-diff-fixture");
  process.env.ARTIFACTS_DIR ||= fixtureRoot;
  process.env.DATA_DIR ||= path.join(fixtureRoot, "data");
  const { compareMaps } = require("../../src/services/diffService");
  const toMap = (side) => new Map(objects.filter((item) => item[side] != null).map((item) => [
    `${item.objectType}|${item.schemaName.toLowerCase()}|${item.objectName.toLowerCase()}`,
    { objectType: item.objectType, schemaName: item.schemaName, objectName: item.objectName, definition: item[side] },
  ]));
  return compareMaps(toMap("source"), toMap("target"));
}

test.beforeEach(async ({ page }) => {
  let appState = {};
  await page.route(/\/api\/app-state$/, (route) => {
    if (route.request().method() === "PUT") appState = route.request().postDataJSON();
    return route.fulfill({ json: appState });
  });
});

test("app logo loads and has stable dimensions", async ({ page }, testInfo) => {
  const response = await page.request.get("/logo.svg");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  await page.goto("/");
  const logo = page.locator(".app-logo");
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  const bounds = await logo.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(28);
  expect(bounds.height).toBeGreaterThanOrEqual(28);
  await page.locator(".brand-wrap").screenshot({ path: testInfo.outputPath("current-logo.png") });
});

for (const themeId of ["pebloy-light", "pebloy-dark", "porcelain", "graphite", "sepia", "spiderman", "monochrome"]) {
  test(`workspace theme ${themeId} persists and styles the SQL editor`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.locator('[data-tab="customize"]').click();
    const picker = page.locator("#themeSelect");
    const options = await picker.locator("option").evaluateAll((options) => options.map((option) => option.textContent.trim()));
    expect(options).toEqual(["☀️ Light", "🌙 Dark", "◇ Porcelain", "🦇 Batman", "◐ Sepia", "🕷️ Spider-Man", "◑ Monochrome"]);
    await picker.selectOption(themeId === "sepia" ? "graphite" : "sepia");
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/app-state") &&
      response.request().method() === "PUT" && response.request().postDataJSON().preferences?.theme === themeId);
    await picker.selectOption(themeId);
    await saved;
    await expect(page.locator("body")).toHaveAttribute("data-theme", themeId);
    const theme = await page.evaluate((id) => globalThis.PebloyThemes.find((theme) => theme.id === id), themeId);
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme.colorScheme);
    await expect(page.locator(".app-logo")).toHaveCSS("filter", themeId === "monochrome" ? "grayscale(1)" : "none");
    const contrast = (foreground, background) => {
      const luminance = (hex) => {
        const channels = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255)
          .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const pairs = [["accent-fg", "accent"], ["accent-fg", "accent-2"], ["accent-fg", "danger"], ["tab-active-fg", "tab-active-bg"], ["toast-fg", "toast-bg"]];
    for (const text of ["text", "text-2", "muted"]) {
      for (const surface of ["bg", "surface", "surface-2", "surface-3", "input-bg"]) pairs.push([text, surface]);
    }
    for (const status of ["info", "success", "warning", "danger"]) pairs.push([`${status}-ink`, `${status}-soft`]);
    for (const stage of ["cobalt", "violet", "teal", "amber"]) pairs.push([`stage-${stage}`, `stage-${stage}-soft`]);
    for (const foreground of ["accent", "success", "warning", "danger"]) pairs.push([foreground, "surface"]);
    for (const [foreground, background] of pairs) {
      expect(contrast(theme.tokens[foreground], theme.tokens[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-theme", themeId);
    await page.locator('[data-tab="objects"]').click();
    await expect(page.locator("#specifyWrap .monaco-editor").first()).toBeVisible();
    const surfaceColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.body).getPropertyValue("--surface");
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(page.locator("#specifyWrap .monaco-editor").first()).toHaveCSS("background-color", surfaceColor);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-objects.png`), fullPage: true });
    await page.locator('[data-tab="formatter"]').click();
    const editor = page.locator("#formatterEditorStage .monaco-editor:visible").first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveCSS("background-color", surfaceColor);
    await editor.locator("textarea").first().fill("-- Theme preview\nSELECT TOP (10) OrderId, N'Pending' AS Status\nFROM dbo.Orders\nWHERE Total > 100;");
    await expect(editor.locator(".view-lines")).toContainText("Pending");
    const readSyntaxColors = () => editor.locator(".view-line span[class*=mtk]").evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
    // Monaco can swap line spans while re-tokenizing; detached spans report an empty color.
    await expect.poll(async () => { const colors = await readSyntaxColors(); return colors.length > 0 && colors.every((color) => /\d/.test(color)); }).toBe(true);
    const syntaxColors = await readSyntaxColors();
    expect(syntaxColors.length).toBeGreaterThan(0);
    for (const color of syntaxColors) {
      const hex = "#" + color.match(/\d+/g).slice(0, 3).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("");
      expect(contrast(hex, theme.tokens.surface), `SQL token ${hex}`).toBeGreaterThanOrEqual(4.5);
    }
    if (themeId === "monochrome") {
      for (const value of Object.values(theme.tokens).filter((value) => value.startsWith("#"))) {
        expect(new Set(value.slice(1).match(/../g)).size).toBe(1);
      }
      for (const color of syntaxColors) expect(new Set(color.match(/\d+/g)).size).toBe(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-formatter.png`), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#formatterClearBtn").click();
    await page.locator('[data-tab="customize"]').click();
    const nextTheme = themeId === "pebloy-light" ? "pebloy-dark" : "pebloy-light";
    await picker.selectOption(nextTheme);
    await expect(page.locator("body")).toHaveAttribute("data-theme", nextTheme);
    expect(await page.locator("body").evaluate((body) => body.style.getPropertyValue("--stage-cobalt"))).toBe(nextTheme === "pebloy-dark" ? "#8bbaf4" : "#22569b");
    await expect(page.locator(".app-logo")).toHaveCSS("filter", "none");
    expect(errors).toEqual([]);
  });
}

test("retired theme selections resolve to the replacement palettes", async ({ page }) => {
  let selectedTheme;
  await page.route(/\/api\/app-state$/, (route) => route.fulfill({ json: { preferences: { theme: selectedTheme } } }));
  for (const [previous, replacement] of [["light", "pebloy-light"], ["dark", "pebloy-dark"], ["azure", "pebloy-dark"], ["batman", "graphite"]]) {
    selectedTheme = previous;
    await page.goto("/");
    await expect(page.locator("body")).toHaveAttribute("data-theme", replacement);
    await expect(page.locator("#themeSelect")).toHaveValue(replacement);
  }
});

test("mutations require a same-origin session and valid deployment inputs", async ({ request }) => {
  expect((await request.post("/api/backup/run", { data: {} })).status()).toBe(403);
  const sessionResponse = await request.get("/api/session");
  expect(sessionResponse.headers()["cache-control"]).toBe("no-store");
  const { token } = await sessionResponse.json();
  const headers = { "X-Pebloy-Token": token };
  expect((await request.post("/api/deploy/run", { headers, data: { selectedObjects: [selectedObject] } })).status()).toBe(400);
  const unconfirmed = await request.post("/api/deploy/run", { headers, data: { selectedObjects: [selectedObject], mode: "FormatAndExecuteSource" } });
  expect(unconfirmed.status()).toBe(400);
  expect((await unconfirmed.json()).error).toContain("explicit source database confirmation");
  const missingPlan = await request.post("/api/deploy/run", { headers, data: { selectedObjects: [selectedObject], mode: "ExecuteDirectly" } });
  expect(missingPlan.status()).toBe(400);
  expect((await missingPlan.json()).error).toContain("confirm the deployment plan");
  expect((await request.post("/api/deploy/plan", { headers, data: { selectedObjects: [selectedObject], engine: "DacFx" } })).status()).toBe(400);
  expect((await request.post("/api/backup/run", { headers, data: { selectedObjects: "invalid" } })).status()).toBe(400);
  for (const endpoint of ["resolve-types", "dependencies", "dependencies/query"]) {
    const invalid = await request.post(`/api/objects/${endpoint}`, { headers, data: { objects: [{ objectName: "invalid\nname" }] } });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toContain("Metadata requests require");
    const oversized = await request.post(`/api/objects/${endpoint}`, { headers, data: { objects: Array(5001).fill(selectedObject) } });
    expect((await oversized.json()).error).toContain("Metadata requests require");
  }
  const oversizedImport = await request.post("/api/data-import", { headers, data: { profiles: Array(101).fill({}) } });
  expect(oversizedImport.status()).toBe(400);
  expect((await oversizedImport.json()).error).toContain("at most 100");
  expect((await request.get("/api/session", { headers: { Origin: "null" } })).status()).toBe(403);
  expect((await request.get("/api/session", { headers: { Origin: "http://127.0.0.1:4400" } })).status()).toBe(403);
});

test("text fields use native controls and Monaco editors share the font-size setting", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-tab="formatter"]').click();
  await expect(page.locator("#formatterEditorStage .monaco-editor:visible").first()).toBeVisible();
  expect(await page.evaluate(() => window.monaco.editor.getModels().map((model) => model.getLanguageId()).sort())).toEqual(["plaintext", "sql", "sql"]);
  const nativeTypes = await page.evaluate(() => ["profileLabel", "serverName", "databaseName", "username", "password", "backupPath", "objectsFilterInput", "queryTimeoutSeconds"]
    .map((id) => { const field = document.getElementById(id); return { id, tag: field.tagName, type: field.type }; }));
  expect(nativeTypes.every((field) => field.tag === "INPUT")).toBe(true);
  expect(nativeTypes.find((field) => field.id === "password").type).toBe("password");
  expect(nativeTypes.find((field) => field.id === "queryTimeoutSeconds").type).toBe("number");
  await expect(page.locator("#sharedObjectText")).toHaveCSS("pointer-events", "none");
  await page.locator('[data-tab="customize"]').click();
  await page.locator("#fontSizeRange").focus();
  await page.locator("#fontSizeRange").press("End");
  await expect(page.locator("#fontSizeRange")).toHaveValue("20");
  await expect.poll(() => page.evaluate(() => window.monaco.editor.getEditors()
    .map((editor) => editor.getOption(window.monaco.editor.EditorOption.fontSize)))).toEqual([19, 19, 19, 19]);
});

test("connection groups and discovery page sizes preserve choices", async ({ page }) => {
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "finance", profileLabel: "Finance DEV", groupName: "Finance", serverName: "offline", databaseName: "fixture" },
    { id: "sales", profileLabel: "Sales DEV", groupName: "Sales", serverName: "offline", databaseName: "fixture" },
  ] }));
  await page.route(/\/api\/objects\/filters\?/, (route) => route.fulfill({ json: { types: ["VIEW"], schemas: ["dbo"] } }));
  await page.goto("/");
  await expect(page.locator("#profilesTable .profile-group")).toHaveText(["Finance", "Sales"]);
  await page.locator('[data-tab="objects"]').click();
  await expect(page.locator("#objectsProfile optgroup")).toHaveCount(2);
  await page.locator("#objectsProfile").selectOption("finance");
  await page.locator("#objectsMode").selectOption("Discover");
  await page.evaluate(() => {
    sharedDiscoveredObjects = Array.from({ length: 105 }, (_, index) => ({ objectType: "VIEW", schemaName: "dbo", objectName: `View${index}` }));
    renderSharedObjectPicker(1);
  });
  await expect(page.locator("#sharedObjectPicker [data-discovered]")).toHaveCount(50);
  await page.locator("#sharedObjectPicker [data-discovered]").first().check();
  await page.locator("#discoverPageSize").selectOption("25");
  await expect(page.locator("#sharedObjectPicker [data-discovered]")).toHaveCount(25);
  await expect(page.locator("#sharedObjectPicker [data-discovered]").first()).toBeChecked();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/app-state") && response.request().method() === "PUT" && response.request().postDataJSON().ui?.discoverPageSize === 100);
  await page.locator("#discoverPageSize").selectOption("100");
  await expect(page.locator("#sharedObjectPicker [data-discovered]")).toHaveCount(100);
  await saved;
  await page.reload();
  await expect(page.locator("#discoverPageSize")).toHaveValue("100");
});

test("Enter in dropdowns does not trigger discovery or Save All", async ({ page }) => {
  let searches = 0;
  let settingsWrites = 0;
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "fixture", profileLabel: "Offline Source", serverName: "offline", databaseName: "fixture" },
  ] }));
  await page.route(/\/api\/objects\/filters\?/, (route) => route.fulfill({ json: { types: ["TABLE", "VIEW"], schemas: ["dbo", "reporting"] } }));
  await page.route(/\/api\/objects\?/, (route) => {
    searches += 1;
    return route.fulfill({ json: [] });
  });
  await page.route(/\/api\/settings$/, (route) => {
    if (route.request().method() === "PUT") {
      settingsWrites += 1;
      return route.fulfill({ json: route.request().postDataJSON() });
    }
    return route.continue();
  });
  const enterCanceled = (element) => !element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await page.goto("/");
  await page.locator('[data-tab="objects"]').click();
  await page.locator("#objectsProfile").selectOption("fixture");
  await page.locator("#objectsMode").selectOption("Discover");
  await expect(page.locator("#sharedTypeFilter option")).toHaveCount(3);
  for (const id of ["sharedTypeFilter", "sharedSchemaFilter"]) {
    const dropdown = page.locator(`#${id}`);
    await dropdown.focus();
    expect(await dropdown.evaluate(enterCanceled)).toBe(false);
  }
  expect(searches).toBe(0);
  await page.locator("#sharedNameFilter").fill("Invoice");
  await page.locator("#sharedNameFilter").press("Enter");
  await expect.poll(() => searches).toBe(1);
  await page.locator('[data-tab="customize"]').click();
  for (const id of ["themeSelect", "fontSelector", "logLevelSelect"]) {
    const dropdown = page.locator(`#${id}`);
    await dropdown.focus();
    expect(await dropdown.evaluate(enterCanceled)).toBe(false);
  }
  expect(settingsWrites).toBe(0);
  await page.locator("#defaultBackupPath").fill("C:/ThemeCheck");
  await page.locator("#defaultBackupPath").press("Enter");
  await expect.poll(() => settingsWrites).toBe(1);
});

test("discovery dropdowns ignore a late response from the previous connection", async ({ page }) => {
  let finishSlowRequest;
  let slowRequestStarted = false;
  const slowResponse = new Promise((resolve) => { finishSlowRequest = resolve; });
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "slow", profileLabel: "Slow Source", serverName: "offline", databaseName: "SlowDb" },
    { id: "fast", profileLabel: "Fast Source", serverName: "offline", databaseName: "FastDb" },
  ] }));
  await page.route(/\/api\/objects\/filters\?/, async (route) => {
    const profileId = new URL(route.request().url()).searchParams.get("profileId");
    if (profileId === "slow") {
      slowRequestStarted = true;
      await slowResponse;
    }
    await route.fulfill({ json: profileId === "slow"
      ? { types: ["TABLE"], schemas: ["legacy"] }
      : { types: ["VIEW"], schemas: ["reporting"] } });
  });
  await page.goto("/");
  await page.locator('[data-tab="objects"]').click();
  await page.locator("#objectsProfile").selectOption("slow");
  await page.locator("#objectsMode").selectOption("Discover");
  await expect.poll(() => slowRequestStarted).toBe(true);
  await page.locator("#objectsProfile").selectOption("fast");
  await expect(page.locator("#sharedSchemaFilter option")).toHaveText(["(All Schemas)", "reporting"]);
  await page.locator("#sharedTypeFilter").selectOption("VIEW");
  await page.locator("#sharedSchemaFilter").selectOption("reporting");
  const completed = page.waitForResponse((response) => response.url().includes("/api/objects/filters?") &&
    new URL(response.url()).searchParams.get("profileId") === "slow");
  finishSlowRequest();
  await (await completed).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#sharedTypeFilter")).toHaveValue("VIEW");
  await expect(page.locator("#sharedSchemaFilter")).toHaveValue("reporting");
  await expect(page.locator("#sharedSchemaFilter option")).toHaveText(["(All Schemas)", "reporting"]);
});

test("discovery dropdowns preserve live choices and option nodes on refresh and reload", async ({ page }) => {
  let finishRefresh;
  let refreshStarted = false;
  let filterRequests = 0;
  const heldRefresh = new Promise((resolve) => { finishRefresh = resolve; });
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "fixture", profileLabel: "Offline Source", serverName: "offline", databaseName: "fixture" },
  ] }));
  await page.route(/\/api\/objects\/filters\?/, async (route) => {
    filterRequests += 1;
    if (filterRequests === 2) {
      refreshStarted = true;
      await heldRefresh;
    }
    await route.fulfill({ json: { types: ["TABLE", "VIEW"], schemas: ["dbo", "reporting"] } });
  });
  await page.goto("/");
  await page.locator('[data-tab="objects"]').click();
  await page.locator("#objectsProfile").selectOption("fixture");
  await page.locator("#objectsMode").selectOption("Discover");
  const schema = page.locator("#sharedSchemaFilter");
  const type = page.locator("#sharedTypeFilter");
  await expect(schema).toBeEnabled();
  await schema.selectOption("reporting");
  await type.selectOption("VIEW");
  await page.evaluate(() => { window.originalFilterOption = document.querySelector('#sharedSchemaFilter option[value="reporting"]'); });
  await page.locator("#objectsMode").selectOption("Specify");
  await page.locator("#objectsMode").selectOption("Discover");
  await expect.poll(() => refreshStarted).toBe(true);
  await schema.selectOption("dbo");
  await type.selectOption("");
  const finished = page.waitForResponse((response) => response.url().includes("/api/objects/filters?"));
  finishRefresh();
  await (await finished).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(schema).toHaveValue("dbo");
  await expect(type).toHaveValue("");
  expect(await page.evaluate(() => document.querySelector('#sharedSchemaFilter option[value="reporting"]') === window.originalFilterOption)).toBe(true);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/app-state") &&
    response.request().method() === "PUT" && response.request().postDataJSON().ui?.objectsSchemaFilter === "reporting");
  await type.selectOption("VIEW");
  await schema.selectOption("reporting");
  await saved;
  await page.reload();
  await expect(schema).toHaveValue("reporting");
  await expect(type).toHaveValue("VIEW");
  await page.locator("#objectsProfile").selectOption("");
  await expect(schema).toBeDisabled();
  await expect(schema.locator("option")).toHaveText(["(All Schemas)"]);
});

test("discovery keeps selection across paging and sorting and escapes schema metadata", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const objects = Array.from({ length: 110 }, (_unused, index) => ({ ...selectedObject, objectName: `View${String(index).padStart(3, "0")}` }));
  const schema = '<img src=x onerror="window.metadataInjected=true">';
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [{ id: "fixture", profileLabel: "Offline Fixture", serverName: "offline", databaseName: "fixture", authenticationType: "Windows" }] }));
  await page.route(/\/api\/objects\/filters\?/, (route) => route.fulfill({ json: { types: ["VIEW"], schemas: ["dbo", schema] } }));
  await page.route(/\/api\/objects\?/, (route) => route.fulfill({ json: objects }));
  await page.goto("/");
  await page.locator('[data-tab="objects"]').click();
  await page.locator("#objectsProfile").selectOption("fixture");
  await page.locator("#objectsMode").selectOption("Discover");
  await expect(page.locator("#sharedSchemaFilter option").last()).toHaveText(schema);
  await page.locator("#discoverSharedObjects").click();
  const rows = page.locator("#sharedObjectPicker input[data-discovered]");
  await expect(rows).toHaveCount(50);
  await page.locator("#discoverUnselectVisible").click();
  await expect(page.locator("#discoveredSelectionCount")).toHaveText("60 selected");
  await page.locator("#discoverNext").click();
  await rows.first().uncheck();
  await page.locator('[data-sort-disc="object"]').click();
  await expect(page.locator("#sharedObjectPicker input[data-discovered]:checked")).toHaveCount(0);
  await page.locator("#discoverNext").click();
  await expect(page.locator("#sharedObjectPicker input[data-discovered]:checked")).toHaveCount(49);
  await page.locator("#addDiscoveredObjects").click();
  await expect(page.locator("#sharedSelectionTable tbody tr")).toHaveCount(50);
  await page.locator("#selectionNext").click();
  await expect(page.locator("#sharedSelectionTable tbody tr")).toHaveCount(9);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.metadataInjected)).toBeUndefined();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("objects.png"), fullPage: true });
});

test("Format & Execute stays in Backup and requires a confirmed source plan", async ({ page }) => {
  const requests = [];
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [{ id: "fixture", profileLabel: "Test Source", serverName: "offline", databaseName: "Source_PebloyTest", authenticationType: "Windows" }] }));
  await page.route(/\/api\/deploy\/run$/, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { itemResults: [], summary: { success: 1, failed: 0, skipped: 0 }, taskId: "offline" } });
  });
  await page.route(/\/api\/backup\/run$/, () => { throw new Error("Format & Execute must not use Backup execution"); });
  await page.route(/\/api\/deploy\/plan$/, (route) => route.fulfill({ json: {
    plan: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", action: "ExecuteCombinedProcedures" }], fingerprint: "a".repeat(64),
    sourceConnection: { id: "fixture", profileLabel: "Test Source", serverName: "offline", databaseName: "Source_PebloyTest" },
    targetConnection: { id: "fixture", profileLabel: "Test Source", serverName: "offline", databaseName: "Source_PebloyTest" },
  } }));
  await page.goto("/");
  await page.evaluate(() => { sharedSelectedObjects = [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }]; });
  await page.locator('[data-tab="backup"]').click();
  await page.locator("#backupProfile").selectOption("fixture");
  await page.locator("#backupFormatMode").selectOption("formatExecute");
  const dialog = page.getByRole("dialog", { name: "Confirm Source Execution" });
  await expect(dialog).toContainText("offline/Source_PebloyTest");
  await expect(dialog).toContainText("modifies SOURCE");
  await expect(page.locator("#tab-backup")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#runBackup")).toBeEnabled();
  expect(requests).toHaveLength(0);
  await page.locator("#backupFormatMode").selectOption("formatExecute");
  await dialog.getByRole("button", { name: "Confirm & Execute in Source", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ sourceProfileId: "fixture", destinationProfileId: "fixture", mode: "FormatAndExecuteSource", options: { confirmedSourceDatabase: "Source_PebloyTest", confirmedPlanFingerprint: "a".repeat(64) } });
  await expect(page.locator("#backupResult")).toContainText("Format & Execute in Source");
  await expect(page.locator('#deployMode option[value="FormatAndExecuteSource"]')).toHaveCount(0);
});

for (const mode of ["ExecuteDirectly", "Rollback", "DryRun"]) {
  test(`${mode} requires a fresh plan popup before running`, async ({ page }, testInfo) => {
    const requests = [];
    let planRequests = 0;
    const objects = ["Base", "Consumer"].map((objectName) => ({ objectType: "PROCEDURE", schemaName: "dbo", objectName }));
    await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
      { id: "src", profileLabel: "Source", serverName: "offline", databaseName: "SourceDb", authenticationType: "Windows" },
      { id: "dst", profileLabel: "Production Target", serverName: "offline", databaseName: "TargetDb", authenticationType: "Windows", environmentTag: "PROD" },
    ] }));
    await page.route(/\/api\/deploy\/plan$/, (route) => {
      planRequests += 1;
      return route.fulfill({ json: { plan: objects.map((item) => ({ ...item, action: "ExecuteCombinedProcedures" })), fingerprint: "b".repeat(64),
        sourceConnection: { id: "src", profileLabel: "Source", serverName: "offline", databaseName: "SourceDb" },
        targetConnection: { id: "dst", profileLabel: "Refreshed Target", serverName: "offline", databaseName: "RefreshedTargetDb", environmentTag: "PROD" },
      } });
    });
    await page.route(/\/api\/deploy\/run$/, (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { itemResults: [], summary: { total: 2, success: 2, failed: 0 }, taskId: "offline" } });
    });
    await page.goto("/");
    await expect(page.locator('#deploySourceProfile option[value="src"]')).toBeAttached();
    await page.evaluate((items) => { sharedSelectedObjects = items; }, objects);
    await page.locator('[data-tab="deploy"]').click();
    await page.locator("#deploySourceProfile").selectOption("src");
    await page.locator("#deployDestProfile").selectOption("dst");
    await page.locator("#deployMode").selectOption(mode);
    await page.locator("#runDeployment").click();
    const dialog = page.getByRole("dialog", { name: "Confirm Deployment Plan" });
    await expect(dialog).toContainText("offline/SourceDb");
    await expect(dialog).toContainText("offline/RefreshedTargetDb");
    await expect(dialog).not.toContainText("offline/TargetDb");
    await expect(dialog).toContainText("PRODUCTION TARGET: PROD");
    await expect(dialog.locator("tbody tr")).toHaveCount(2);
    await expect(dialog.locator("tbody tr td:first-child")).toHaveText(["1", "1"]);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    expect(requests).toHaveLength(0);
    expect(await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plan-${mode}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#runDeployment")).toBeFocused();
    expect(requests).toHaveLength(0);
    await page.locator("#runDeployment").click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => { sharedSelectedObjects = []; document.getElementById("deployDestProfile").value = "src"; });
    await dialog.getByRole("button", { name: mode === "DryRun" ? "Confirm & Generate Scripts" : "Confirm & Run", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(planRequests).toBe(2);
    expect(requests[0]).toMatchObject({ sourceProfileId: "src", destinationProfileId: "dst", mode, selectedObjects: objects,
      options: { confirmedPlanFingerprint: "b".repeat(64) } });
  });
}

test("planning errors block deployment and removed order controls do not return", async ({ page }) => {
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "src", profileLabel: "Source", serverName: "offline", databaseName: "SourceDb" },
    { id: "dst", profileLabel: "Target", serverName: "offline", databaseName: "TargetDb" },
  ] }));
  await page.route(/\/api\/deploy\/plan$/, (route) => route.fulfill({ status: 400, json: { error: "Dependency metadata unavailable" } }));
  await page.route(/\/api\/deploy\/run$/, () => { throw new Error("A failed plan must never execute"); });
  await page.goto("/");
  await page.evaluate((item) => { sharedSelectedObjects = [item]; }, selectedObject);
  await page.locator('[data-tab="deploy"]').click();
  await page.locator("#deploySourceProfile").selectOption("src");
  await page.locator("#deployDestProfile").selectOption("dst");
  await page.locator("#runDeployment").click();
  await expect(page.getByText("Dependency metadata unavailable")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#runDeployment")).toBeEnabled();
  await expect(page.locator("#deployOrderList")).toHaveCount(0);
});

test("confirmation dialogs trap focus and restore it on Escape", async ({ page }) => {
  await page.goto("/");
  const previous = page.locator('[data-tab="objects"]');
  await previous.focus();
  await page.evaluate(() => { window.pendingConfirmation = showConfirmModal({ title: "Confirm action", message: "Continue?", buttons: ["Continue", "Cancel"] }); });
  const dialog = page.getByRole("dialog", { name: "Confirm action" });
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previous).toBeFocused();
});

test("overlapping confirmations do not leave connection and object controls inert", async ({ page }) => {
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "src", profileLabel: "Source", serverName: "offline", databaseName: "SourceDb", authenticationType: "Windows" },
    { id: "dst", profileLabel: "Target", serverName: "offline", databaseName: "TargetDb", authenticationType: "Windows" },
  ] }));
  await page.goto("/");
  const focusOrigin = page.locator('[data-tab="objects"]');
  await focusOrigin.focus();
  await page.evaluate(() => {
    showConfirmModal({ title: "First action", message: "First?", buttons: ["Continue", "Cancel"] });
    showConfirmModal({ title: "Second action", message: "Second?", buttons: ["Continue", "Cancel"] });
  });
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await expect(page.getByRole("dialog", { name: "First action" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Second action" })).toBeVisible();
  expect(await page.getByRole("dialog").evaluateAll((dialogs) => new Set(dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"))).size)).toBe(2);

  await page.evaluate(() => document.querySelectorAll(".confirm-modal-overlay")[0]
    .querySelector(".confirm-modal-btn").click());
  await page.evaluate(() => document.querySelector(".confirm-modal-overlay .confirm-modal-btn").click());

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await expect(focusOrigin).toBeFocused();

  await page.locator('[data-tab="backup"]').click();
  await page.locator("#backupProfile").selectOption("dst");
  await expect(page.locator("#backupProfile")).toHaveValue("dst");

  await page.locator('[data-tab="objects"]').click();
  const manualEditor = page.locator("#specifyWrap .monaco-editor:visible").first();
  await manualEditor.locator("textarea").focus();
  await page.keyboard.insertText("dbo.Fixture");
  await expect(manualEditor).toContainText("dbo.Fixture");
  await page.locator("#objectsMode").selectOption("Discover");
  await expect(page.locator("#objectsMode")).toHaveValue("Discover");
  await page.locator("#sharedNameFilter").fill("Fixture");
  await expect(page.locator("#sharedNameFilter")).toHaveValue("Fixture");
});

test("dependency modal cleanup is idempotent", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((dependency) => {
    window.pendingDependencies = showDependencyPickerModal({ dependencies: [dependency], requestedCount: 1, timeWindow: null });
  }, selectedObject);
  const dialog = page.getByRole("dialog", { name: "Fetch Dependencies" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    const closeButton = document.querySelector(".dependency-modal-close");
    closeButton.click();
    closeButton.click();
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
});

test("loading dependency modal focuses an enabled control and restores focus", async ({ page }) => {
  await page.goto("/");
  const focusOrigin = page.locator('[data-tab="objects"]');
  await focusOrigin.focus();
  await page.evaluate(() => {
    window.pendingDependencies = showDependencyPickerModal({
      dependencies: [],
      requestedCount: 1,
      timeWindow: null,
      loadCandidates: () => new Promise(() => {}),
    });
  });
  const dialog = page.getByRole("dialog", { name: "Fetch Dependencies" });
  const closeButton = dialog.getByRole("button", { name: "Close" });
  await expect(closeButton).toBeEnabled();
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.locator("#dependencySearchInput")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(focusOrigin).toBeFocused();
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
});

test("SSE snapshots recover progress and remove stale tasks on reconnect", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.testEventSource = this; }
      close() {}
    };
  });
  await page.goto("/");
  await page.locator('[data-tab="deploy"]').click();
  await page.evaluate(() => {
    const emit = (event, data) => window.testEventSource.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
    emit("snapshot", { tasks: [{ taskId: "stale", taskType: "Backup", percent: 10 }] });
    emit("snapshot", { tasks: [{
      taskId: "active", taskType: "Deploy", percent: 40, progressLabel: "Executing objects",
      objectProgress: [{ taskId: "active", objectType: "VIEW", schemaName: "dbo", objectName: 'name"quoted', status: "Success", done: 1, total: 2 }],
    }] });
    emit("deployProgress", { taskId: "unrelated", objectType: "VIEW", schemaName: "dbo", objectName: "wrong-task", status: "Failed", done: 2, total: 2 });
  });
  await expect(page.locator("#backupProgressText")).toContainText("ended while disconnected");
  await expect(page.getByRole("progressbar", { name: "Deployment progress" })).toHaveAttribute("aria-valuenow", "50");
  await expect(page.locator("#deployObjectProgress .deploy-progress-row")).toHaveCount(1);
  await expect(page.locator("#deployObjectProgress")).toContainText('name"quoted');
  await expect(page.locator("#deployObjectProgress")).not.toContainText("wrong-task");
  await page.evaluate(() => window.testEventSource.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ tasks: [] }) })));
  await expect(page.locator("#parallelTasksPanel")).toBeHidden();
});

test("system theme follows OS changes until an explicit theme is chosen", async ({ page }) => {
  await page.route(/\/api\/app-state$/, (route) => route.fulfill({ json: { preferences: { theme: "system" } } }));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-theme", "pebloy-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveAttribute("data-theme", "pebloy-light");
  await page.locator('[data-tab="customize"]').click();
  await page.locator("#themeSelect").selectOption("sepia");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveAttribute("data-theme", "sepia");
  await expect(page.locator("#followSystemTheme")).not.toBeChecked();
});

test("module status is read-only and installation is explicit", async ({ page }) => {
  let installs = 0;
  await page.route(/\/api\/prerequisites\/sqlserver$/, (route) => route.fulfill({ json: { version: "22.4.5.1", filesPresent: Boolean(installs), modulePath: "offline/modules", repairInstallation: false } }));
  await page.route(/\/api\/prerequisites\/sqlserver\/install$/, (route) => { installs += 1; return route.fulfill({ json: { filesPresent: true } }); });
  await page.goto("/");
  await page.locator("#checkSqlModule").click();
  await expect(page.locator("#sqlModuleStatus")).toContainText("missing");
  expect(installs).toBe(0);
  await page.locator("#installSqlModule").click();
  await expect(page.locator("#sqlModuleStatus")).toContainText("module files present");
  expect(installs).toBe(1);
});

test("scheduled deployments stay hidden until enabled in Settings", async ({ page }) => {
  let settings = { features: { schedules: false } };
  let scheduleLoads = 0;
  let rejectDisable = false;
  await page.route(/\/api\/settings$/, (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: settings });
    const body = route.request().postDataJSON();
    if (rejectDisable && body.features.schedules === false) return route.fulfill({ status: 400, json: { error: "Delete saved schedules before turning off Scheduled Deployments." } });
    settings = body;
    return route.fulfill({ json: settings });
  });
  await page.route(/\/api\/schedules$/, (route) => {
    scheduleLoads += 1;
    return route.fulfill({ json: { enabled: settings.features.schedules, items: [], capabilities: { wakeApplication: false }, timeZone: "UTC" } });
  });
  await page.goto("/");
  await page.locator('[data-tab="deploy"]').click();
  await expect(page.locator("#runDeployment")).toBeVisible();
  await expect(page.locator("#scheduleSection")).toBeHidden();
  expect(scheduleLoads).toBe(0);
  await page.locator('[data-tab="customize"]').click();
  const toggle = page.locator("label.toggle-switch", { has: page.locator("#schedulesFeatureToggle") });
  await toggle.click();
  await expect(page.locator("#schedulesFeatureToggle")).toBeChecked();
  await page.locator("#saveAllSettings").click();
  await expect.poll(() => settings.features.schedules).toBe(true);
  await page.locator('[data-tab="deploy"]').click();
  await expect(page.locator("#saveSchedule")).toBeVisible();
  await expect.poll(() => scheduleLoads).toBeGreaterThan(0);
  rejectDisable = true;
  await page.locator('[data-tab="customize"]').click();
  await toggle.click();
  await expect(page.locator("#schedulesFeatureToggle")).not.toBeChecked();
  await page.locator("#saveAllSettings").click();
  await expect(page.getByText("Delete saved schedules before turning off")).toBeVisible();
  await expect(page.locator("#schedulesFeatureToggle")).toBeChecked();
});

test("code diff viewer renders engine output like a review tool", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const body = Array.from({ length: 24 }, (_unused, index) => `    ,o.Column${index} -- column ${index}`);
  const procedure = (select, where, trailer) => [
    "/* Returns customer orders.",
    "   Owner: sales team */",
    "CREATE PROCEDURE Sales.GetOrders @CustomerId int",
    "AS",
    select,
    ...body,
    "FROM Sales.Orders AS o",
    where,
    ...trailer,
  ].join("\n");
  const report = buildEngineDiffReport([
    { objectType: "PROCEDURE", schemaName: "Sales", objectName: "GetOrders",
      target: procedure("SELECT o.OrderId, o.Total", "WHERE o.CustomerId = @CustomerId;", []),
      source: procedure("SELECT o.OrderId, o.Total, o.Status", "WHERE o.CustomerId = @CustomerId", ["  AND o.Note <> N'<img src=x onerror=window.diffInjected=1>';"]) },
    { objectType: "VIEW", schemaName: "dbo", objectName: "NewView", source: "CREATE VIEW dbo.NewView AS SELECT 1 AS Id;", target: null },
    { objectType: "FUNCTION", schemaName: "dbo", objectName: "OldFunction", source: null, target: "CREATE FUNCTION dbo.OldFunction() RETURNS int AS BEGIN RETURN 1; END" },
    { objectType: "VIEW", schemaName: "dbo", objectName: "Same", source: "CREATE VIEW dbo.Same AS SELECT 1 AS Id;", target: "CREATE VIEW dbo.Same AS SELECT 1 AS Id;" },
  ]);
  await page.goto("/");
  await page.locator('[data-tab="diff"]').click();
  await page.evaluate((value) => { currentDiffReport = value; currentDiffIndex = -1; renderDiff(value); }, report);

  const items = page.locator("#diffObjectItems .diff-object-item");
  await expect(items).toHaveCount(3);
  await expect(page.locator(".diff-count-badge")).toHaveText("3");
  await items.filter({ hasText: "Sales.GetOrders" }).click();
  await expect(items.filter({ hasText: "Sales.GetOrders" })).toHaveAttribute("aria-current", "true");
  await expect(items.filter({ hasText: "Sales.GetOrders" })).toContainText("+3");
  await expect(items.filter({ hasText: "dbo.NewView" })).toContainText("+1");
  await expect(items.filter({ hasText: "dbo.OldFunction" })).toContainText("\u22121");
  await expect(page.locator(".diff-grid thead")).toContainText("Target (current)");
  await expect(page.locator(".diff-file-name")).toHaveCSS("text-transform", "none");
  const grid = page.locator(".diff-grid");
  await expect(grid).toHaveClass(mobile ? /diff-grid-unified/ : /diff-grid-split/);
  expect((await page.locator(".diff-word-ins").allTextContents()).join("")).toBe(", o.Status");
  await expect(page.locator(".diff-word-del")).toHaveText([";"]);
  await expect(page.locator(".tk-kw", { hasText: /^SELECT$/ }).first()).toBeVisible();
  await expect(page.locator(".tk-str").last()).toContainText("<img src=x");
  expect(await page.evaluate(() => window.diffInjected)).toBeUndefined();
  await expect(page.locator(".diff-num").first()).toHaveText("");

  const expand = page.locator(".diff-expand");
  await expect(expand.first()).toContainText(/Show \d+ unchanged line/);
  await expect(page.locator(".diff-hunk-header").first()).toHaveText(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  const rowsBefore = await page.locator("tr.diff-row").count();
  await expand.first().click();
  await expect.poll(() => page.locator("tr.diff-row").count()).toBeGreaterThan(rowsBefore);
  await expect(page.locator(".tk-com").first()).toContainText("/* Returns customer orders.");
  await expect(page.locator(".tk-com", { hasText: "Owner: sales team */" }).first()).toBeVisible();

  const position = page.locator("#diffChangePosition");
  await expect(position).toHaveText("Change 1 of 2");
  await page.locator("#diffNextChange").click();
  await expect(position).toHaveText("Change 2 of 2");
  await expect(page.locator("#diffNextChange")).toBeDisabled();
  await page.locator(".diff-scroll").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(position).toHaveText("Change 1 of 2");
  await expect(page.locator("tr.diff-row-current").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("diff-split.png"), fullPage: true });

  await page.locator('[data-diff-mode="unified"]').click();
  await expect(grid).toHaveClass(/diff-grid-unified/);
  const firstChange = page.locator('tr[data-change="0"]');
  await expect(firstChange).toHaveCount(2);
  await expect(firstChange.nth(0)).toHaveClass(/diff-row-removed/);
  await expect(firstChange.nth(1)).toHaveClass(/diff-row-added/);
  await page.locator("#diffContext").selectOption("full");
  await expect(page.locator(".diff-expand")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("diff-unified.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.locator('[data-diff-filter="added"]').click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("dbo.NewView");
  await page.locator('[data-diff-filter="all"]').click();
  await page.locator("#diffObjectSearch").fill("function");
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("dbo.OldFunction");

  await page.reload();
  await page.locator('[data-tab="diff"]').click();
  await page.evaluate((value) => { currentDiffReport = value; currentDiffIndex = -1; renderDiff(value); }, report);
  await expect(page.locator("#diffContext")).toHaveValue("full");
  await expect(page.locator('[data-diff-mode="unified"]')).toHaveAttribute("aria-pressed", "true");
  if (!mobile) await page.locator('[data-diff-mode="split"]').click();
  await page.locator("#diffContext").selectOption("3");
  await page.evaluate(() => { const picker = document.getElementById("themeSelect"); picker.value = "pebloy-dark"; picker.dispatchEvent(new Event("change")); });
  await page.locator("#diffViewer").screenshot({ path: testInfo.outputPath("diff-dark.png") });
});

test("schedules require an explicit plan confirmation and do not execute on save", async ({ page }, testInfo) => {
  const profiles = ["source", "qa"].map((id) => ({ id, profileLabel: id, serverName: "offline", databaseName: id }));
  let records = [];
  let saved = 0;
  await page.route(/\/api\/settings$/, (route) => route.request().method() === "GET" ? route.fulfill({ json: { features: { schedules: true } } }) : route.continue());
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: profiles }));
  await page.route(/\/api\/deploy\/batch\/plan$/, (route) => route.fulfill({ json: { sourceConnection: profiles[0], fingerprint: "a".repeat(64), plans: [{ targetConnection: profiles[1], plan: [{ ...selectedObject, action: "DropAndCreate" }] }] } }));
  await page.route(/\/api\/deploy\/batch\/run$/, () => { throw new Error("Saving a schedule must not execute SQL"); });
  await page.route(/\/api\/schedules$/, (route) => {
    if (route.request().method() === "POST") {
      saved += 1;
      const record = { ...route.request().postDataJSON(), id: "fixture", enabled: true, lastStatus: "NotRun" };
      records = [record];
      expect(record.request.options.confirmedBatchFingerprint).toBe("a".repeat(64));
      return route.fulfill({ json: record });
    }
    return route.fulfill({ json: { items: records, capabilities: { wakeApplication: false }, timeZone: "UTC" } });
  });
  await page.goto("/");
  await expect(page.locator('#deploySourceProfile option[value="source"]')).toBeAttached();
  await page.evaluate((item) => { sharedSelectedObjects = [item]; }, selectedObject);
  await page.locator('[data-tab="deploy"]').click();
  await page.locator("#deploySourceProfile").selectOption("source");
  await page.locator("#deployDestProfile").selectOption("qa");
  await page.locator("#scheduleName").fill("Nightly QA");
  await page.locator("#scheduleTime").fill("2040-01-01T22:30");
  await page.locator("#saveSchedule").click();
  await expect(page.getByRole("dialog")).toContainText("missed intervals are not replayed");
  await page.keyboard.press("Escape");
  expect(saved).toBe(0);
  await page.locator("#saveSchedule").click();
  await page.getByRole("button", { name: "Confirm & Save Schedule", exact: true }).click();
  await expect(page.locator("#scheduleList")).toContainText("Nightly QA");
  expect(saved).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("schedules.png"), fullPage: true });
});

test("multi-target deployment confirms every target before running", async ({ page }, testInfo) => {
  const profiles = ["source", "qa", "uat"].map((id) => ({ id, profileLabel: id, serverName: "offline", databaseName: id }));
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: profiles }));
  await page.route(/\/api\/deploy\/batch\/plan$/, (route) => route.fulfill({ json: {
    sourceConnection: profiles[0], fingerprint: "b".repeat(64), plans: profiles.slice(1).map((profile) => ({ targetConnection: profile, plan: [{ ...selectedObject, action: "DropAndCreate" }] })),
  } }));
  let executions = 0;
  await page.route(/\/api\/deploy\/batch\/run$/, (route) => {
    executions += 1;
    expect(route.request().postDataJSON().targetProfileIds).toEqual(["qa", "uat"]);
    expect(route.request().postDataJSON().options.confirmedBatchFingerprint).toBe("b".repeat(64));
    return route.fulfill({ json: { summary: { failed: 0, reviewRequired: 0 }, targets: profiles.slice(1).map((profile) => ({ targetConnection: profile, status: "Success", summary: { total: 1 }, itemResults: [] })) } });
  });
  await page.goto("/");
  await expect(page.locator('#deploySourceProfile option[value="source"]')).toBeAttached();
  await page.evaluate((item) => { sharedSelectedObjects = [item]; }, selectedObject);
  await page.locator('[data-tab="deploy"]').click();
  await page.locator("#deploySourceProfile").selectOption("source");
  await page.locator("#deployTargetMode").selectOption("multiple");
  await page.locator('[data-batch-target][value="qa"]').check();
  await page.locator('[data-batch-target][value="uat"]').check();
  await page.locator("#runDeployment").click();
  await expect(page.getByRole("dialog")).toContainText("qa");
  await expect(page.getByRole("dialog")).toContainText("uat");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("batch-confirmation.png"), fullPage: true });
  await page.keyboard.press("Escape");
  expect(executions).toBe(0);
  await page.locator("#runDeployment").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm & Run Targets" }).click();
  await expect(page.locator("#deployResult")).toContainText("Target Results");
  expect(executions).toBe(1);
});

test("folder sources load metadata and remain explicit in diff requests", async ({ page }) => {
  await page.route(/\/api\/sources\/folder$/, (route) => route.fulfill({ json: { folderPath: "C:/SqlExports/Fixture", objects: [selectedObject] } }));
  await page.route(/\/api\/diff\/compare$/, (route) => {
    expect(route.request().postDataJSON().sourceFolder).toBe("C:/SqlExports/Fixture");
    expect(route.request().postDataJSON().sourceProfileId).toBeUndefined();
    return route.fulfill({ json: { taskId: "offline-diff", report: { summary: { added: 0, missing: 0, changed: 0, unchanged: 1 }, details: [] } } });
  });
  await page.goto("/");
  await page.locator('[data-tab="objects"]').click();
  await page.locator("#objectsMode").selectOption("Folder");
  await page.locator("#folderSourcePath").fill("C:/SqlExports/Fixture");
  await page.locator("#loadFolderSource").click();
  await expect(page.locator("#sharedSelectionTable")).toContainText("Fixture");
  await expect(page.locator("#objectsProfile")).toBeDisabled();
  await page.locator('[data-tab="diff"]').click();
  await expect(page.locator("#tab-diff .folder-source-label")).toHaveText("Folder source: C:/SqlExports/Fixture");
  await expect(page.locator("#diffSourceProfile")).toBeDisabled();
  await page.locator("#runDiff").click();
  await expect(page.locator("#diffList")).toContainText("No differences");
});

test("diff exports and clipboard reuse the displayed report", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedDiff = text; } } }));
  await page.route(/\/api\/diff\/export$/, (route) => {
    expect(route.request().postDataJSON().format).toBe("html-highlighted");
    return route.fulfill({ json: { filePath: "C:/reports/diff.html" } });
  });
  await page.route(/\/api\/diff\/clipboard$/, (route) => route.fulfill({ json: { text: "# Diff Report\nFixture" } }));
  await page.goto("/");
  await page.locator('[data-tab="diff"]').click();
  await expect(page.locator("#exportDiff")).toBeDisabled();
  await page.evaluate(() => {
    currentDiffReport = { summary: { added: 0, missing: 0, changed: 0, unchanged: 0 }, details: [] };
    renderDiff(currentDiffReport);
  });
  await page.locator("#exportDiff").click();
  await expect(page.locator("#diffExportResult")).toHaveText("C:/reports/diff.html");
  await page.locator("#copyDiff").click();
  await expect.poll(() => page.evaluate(() => window.copiedDiff)).toBe("# Diff Report\nFixture");
});

test("archive cleanup requires preview and explicit confirmation", async ({ page }) => {
  let deletions = 0;
  await page.route(/\/api\/logs\/archive\/preview$/, (route) => route.fulfill({ json: { token: "preview-token", cutoff: "2025-01-01T00:00:00Z", totalBytes: 10, files: [{ name: "old.log", bytes: 10 }] } }));
  await page.route(/\/api\/logs\/archive\/cleanup$/, (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: "preview-token", confirmed: true });
    deletions += 1;
    return route.fulfill({ json: { deleted: 1 } });
  });
  await page.goto("/");
  await page.locator('[data-tab="logs"]').click();
  await expect(page.locator("#deleteArchiveFiles")).toBeDisabled();
  await page.locator("#previewArchiveCleanup").click();
  await expect(page.locator("#logDetail")).toContainText("old.log");
  await page.locator("#deleteArchiveFiles").click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(deletions).toBe(0);
  await page.locator("#deleteArchiveFiles").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete Files", exact: true }).click();
  await expect(page.locator("#logDetail")).toHaveText("Deleted 1 archived files.");
  expect(deletions).toBe(1);
});

test("opened logs show tab-separated object lists independently of event filters", async ({ page }, testInfo) => {
  const task = {
    taskId: "object-list", taskType: "Backup", status: "Failed", logLevel: "Normal",
    startedAt: "2026-09-22T10:00:00Z", completedAt: "2026-09-22T10:00:02Z",
    startedBy: "tester", machine: "offline", sourceProfileLabel: "Source",
    selectedObjects: [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      { objectType: "USER_DEFINED_TABLE_TYPE", schemaName: "finance", objectName: "PaymentType" },
      { objectType: "VIEW", schemaName: "Reporting", objectName: "<b>MixedCaseView</b>" },
    ],
    events: [
      { timestamp: "2026-09-22T10:00:00Z", level: "INFO", message: "Generation started" },
      { timestamp: "2026-09-22T10:00:02Z", level: "ERROR", message: "One object failed" },
    ],
  };
  await page.route(/\/api\/logs$/, (route) => route.fulfill({ json: [{ ...task, objectCount: 3, eventCounts: { INFO: 1, WARN: 0, ERROR: 1 }, highestLevel: "ERROR" }] }));
  await page.route(/\/api\/tasks\/object-list$/, (route) => route.fulfill({ json: task }));
  await page.goto("/");
  await page.locator('[data-tab="logs"]').click();
  await page.locator('[data-log-view="object-list"]').click();
  const detail = page.locator("#logDetail");
  await expect(detail).toBeVisible();
  const objectList = "Selected Objects\nObject Type\tSchema.Object\nPROCEDURE\tdbo.ProcA\nUSER_DEFINED_TABLE_TYPE\tfinance.PaymentType\nVIEW\tReporting.<b>MixedCaseView</b>";
  expect(await detail.textContent()).toContain(objectList);
  await expect(detail.locator("b")).toHaveCount(0);
  await expect(detail).toContainText("Generation started");
  const columnStarts = await detail.evaluate((element) => ["Schema.Object", "dbo.ProcA", "finance.PaymentType", "Reporting.<b>MixedCaseView</b>"].map((name) => {
    const offset = element.textContent.indexOf(name);
    const range = document.createRange();
    range.setStart(element.firstChild, offset);
    range.setEnd(element.firstChild, offset + name.length);
    return range.getBoundingClientRect().left;
  }));
  expect(Math.max(...columnStarts) - Math.min(...columnStarts)).toBeLessThan(1);
  await expect(detail).toHaveCSS("overflow-x", "auto");
  await detail.screenshot({ path: testInfo.outputPath("log-object-list.png") });
  await page.locator("#logFilterLevel").selectOption("ERROR");
  await page.locator('[data-log-view="object-list"]').click();
  await expect(detail).not.toContainText("Generation started");
  await expect(detail).toContainText("One object failed");
  expect(await detail.textContent()).toContain(objectList);
  delete task.selectedObjects;
  await page.locator('[data-log-view="object-list"]').click();
  await expect(detail).toContainText("(No objects recorded)");
});

test("guarded migrations display Review Required rather than success", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-tab="deploy"]').click();
  await page.evaluate(() => renderDeployResult({ summary: { total: 1, reviewRequired: 1, failed: 0, success: 0 },
    itemResults: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Protected", status: "ReviewRequired", errorMessage: "Target object has explicit permissions" }],
  }));
  await expect(page.locator("#deployResult tbody")).toContainText("Review Required");
  await expect(page.locator("#deployResult .summary-cards")).toContainText("Review Required");
  await expect(page.locator("#deployRetryRow")).toBeHidden();
});

test("the target dropdown stays usable across deployment modes", async ({ page }) => {
  await page.route(/\/api\/profiles$/, (route) => route.fulfill({ json: [
    { id: "src", profileLabel: "Source", serverName: "host", databaseName: "SrcDb", authenticationType: "Windows" },
    { id: "dst", profileLabel: "Target", serverName: "host", databaseName: "DstDb", authenticationType: "Windows" },
  ] }));
  await page.goto("/");
  await page.locator('[data-tab="deploy"]').click();
  const target = page.locator("#deployDestProfile");
  await page.locator("#deploySourceProfile").selectOption("src");
  await target.selectOption("dst");

  await expect(page.locator('#deployMode option[value="FormatAndExecuteSource"]')).toHaveCount(0);
  await page.locator("#deployMode").selectOption("Rollback");
  await expect(target).toBeEnabled();
  await expect(target).toHaveValue("dst");

  await page.locator("#deployMode").selectOption("ExecuteDirectly");
  await expect(target).toBeEnabled();
  await expect(target).toHaveValue("dst");
});

test("review-required objects offer a migration script that is never executed", async ({ page }) => {
  const requests = [];
  await page.route(/\/api\/deploy\/migration-prep$/, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { outputPath: "C:/artifacts/MigrationPrep_t1.sql", executed: false } });
  });
  await page.route(/\/api\/deploy\/run$/, () => { throw new Error("Generating a scaffold must not deploy"); });
  await page.goto("/");
  await page.locator('[data-tab="deploy"]').click();
  await page.evaluate(() => {
    renderDeployResult({ taskId: "t1", summary: { total: 2, reviewRequired: 1, failed: 0, success: 1 }, itemResults: [
      { objectType: "VIEW", schemaName: "dbo", objectName: "Protected", status: "ReviewRequired", errorMessage: "explicit permissions" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "Plain", status: "Success" },
    ] });
    renderMigrationPrepAction({ taskId: "t1", itemResults: [
      { objectType: "VIEW", schemaName: "dbo", objectName: "Protected", status: "ReviewRequired" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "Plain", status: "Success" },
    ] });
  });
  const button = page.locator("#generateMigrationPrep");
  await expect(button).toHaveText("Generate migration script (1)");
  await button.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].selectedObjects).toEqual([{ objectType: "VIEW", schemaName: "dbo", objectName: "Protected" }]);
});

test("formatter asks before discarding unsaved SQL", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator('[data-tab="formatter"]').click();
  const editor = page.locator("#formatterEditorStage .monaco-editor:visible").first();
  await editor.locator("textarea").focus();
  await page.keyboard.insertText("SELECT 1;");
  const dismissed = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("unsaved SQL");
    await dialog.dismiss();
  });
  await page.locator("#formatterClearBtn").click();
  await dismissed;
  await expect(editor).toContainText("SELECT 1;");
  await page.screenshot({ path: testInfo.outputPath("formatter.png"), fullPage: true });
  page.once("dialog", (nextDialog) => nextDialog.accept());
  await page.locator("#formatterClearBtn").click();
  await expect(editor).not.toContainText("SELECT 1;");
});