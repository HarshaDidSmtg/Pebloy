const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { acquireRuntimeLocks } = require("./runtimeLockService");
const { extractStartupFailureReason } = require("./startupFailure");

test.each([
  ["Pebloy failed to start: Runtime storage is already in use.\n    at listen (node:net:1)", "Runtime storage is already in use."],
  ["Error: EADDRINUSE\n    at Server.setupListenHandle (node:net:1)", "Error: EADDRINUSE"],
  ["", ""],
])("reports the cause rather than a stack frame", (stderr, expected) => {
  expect(extractStartupFailureReason(stderr)).toBe(expected);
});

test("a second backend reports why it cannot use the same runtime storage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-busy-"));
  const environment = { ...process.env, DATA_DIR: path.join(root, "data"), ARTIFACTS_DIR: path.join(root, "artifacts"), PORT: "4501" };
  for (const key of ["LOGS_DIR", "EXPORTS_DIR", "SCRIPTS_DIR", "REPORTS_DIR", "TEMP_DIR", "CODEDIFF_DIR", "LOG_ARCHIVE_DIR"]) delete environment[key];
  const owner = await acquireRuntimeLocks([environment.DATA_DIR, environment.ARTIFACTS_DIR]);
  const child = spawn(process.execPath, ["src/server.js"], { cwd: path.resolve(__dirname, "../.."), env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    expect(exitCode).toBe(1);
    expect(extractStartupFailureReason(stderr)).toContain("Runtime storage is already in use");
  } finally {
    await owner.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("schedule APIs require authorization, reviewed inputs, and explicit deletion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-schedule-api-"));
  const source = `
    require('./src/services/scriptAutomationService').ensureSqlServerModule = async () => {};
    require('./src/services/profileService').getProfileWithSecret = id => ({ id, serverName: 'offline', databaseName: id });
    require('./src/services/deploymentBatchService').buildBatchPlan = async () => ({ fingerprint: 'a'.repeat(64) });
    require('./src/services/deploymentBatchService').runDeploymentBatch = async () => { throw new Error('Saving must not execute'); };
    require('./src/server');
  `;
  const environment = { ...process.env, DATA_DIR: path.join(root, "data"), ARTIFACTS_DIR: path.join(root, "artifacts"), PORT: "4502" };
  for (const key of ["LOGS_DIR", "EXPORTS_DIR", "SCRIPTS_DIR", "REPORTS_DIR", "TEMP_DIR", "CODEDIFF_DIR", "LOG_ARCHIVE_DIR"]) delete environment[key];
  const child = spawn(process.execPath, ["-e", source], { cwd: path.resolve(__dirname, "../.."), env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/listening on (http:\/\/[^\s]+)/); if (match) resolve(match[1]); });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Server exited before readiness")));
    });
    const { token } = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
    const headers = { "Content-Type": "application/json", "X-Pebloy-Token": token };
    const imported = await fetch(`${baseUrl}/api/profiles/import`, { method: "POST", headers,
      body: JSON.stringify({ profiles: [{ profileLabel: "Grouped QA", serverName: "offline", databaseName: "qa", authenticationType: "Windows", groupName: "Finance" }] }),
    });
    expect((await imported.json()).created).toBe(1);
    const exported = await fetch(`${baseUrl}/api/profiles/export`).then((response) => response.json());
    expect(exported[0]).toMatchObject({ profileLabel: "Grouped QA", groupName: "Finance" });
    const input = { name: "Offline API", repeat: "once", nextRunAt: new Date(Date.now() + 3600000).toISOString(), confirmed: true,
      request: { sourceProfileId: "source", targetProfileIds: ["qa"], mode: "DryRun", selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Fixture" }], password: "not-persisted", options: { confirmedBatchFingerprint: "a".repeat(64) } } };
    expect((await fetch(`${baseUrl}/api/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/schedules`).then((response) => response.json())).enabled).toBe(false);
    const disabled = await fetch(`${baseUrl}/api/schedules`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(disabled.status).toBe(400);
    expect((await disabled.json()).error).toContain("turned off");
    await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ features: { schedules: true } }) });
    const saved = await fetch(`${baseUrl}/api/schedules`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(saved.status).toBe(200);
    const record = await saved.json();
    expect(record).toMatchObject({ enabled: true, request: { targetProfileIds: ["qa"] } });
    expect(record.request.password).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "data", "schedules.json"), "utf8")).not.toContain("not-persisted");
    expect((await fetch(`${baseUrl}/api/factory-reset`, { method: "POST", headers, body: "{}" })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ features: { schedules: false } }) })).status).toBe(400);
    const stale = { ...input, request: { ...input.request, options: { confirmedBatchFingerprint: "b".repeat(64) } } };
    expect((await fetch(`${baseUrl}/api/schedules/${record.id}`, { method: "PUT", headers, body: JSON.stringify(stale) })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/schedules/${record.id}`, { method: "DELETE", headers, body: "{}" })).status).toBe(400);
    const paused = await fetch(`${baseUrl}/api/schedules/${record.id}/pause`, { method: "POST", headers, body: "{}" });
    expect((await paused.json()).enabled).toBe(false);
    expect((await fetch(`${baseUrl}/api/schedules/${record.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmed: true }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/schedules`).then((response) => response.json())).items).toEqual([]);
    const off = await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ features: { schedules: false } }) });
    expect((await off.json()).features.schedules).toBe(false);
  } finally {
    if (child.exitCode === null) { child.send("shutdown"); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("shutdown drains a workflow after its HTTP client disconnects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-lifecycle-"));
  const source = `
    require('./src/services/scriptAutomationService').ensureSqlServerModule = async () => {};
    require('./src/services/profileService').getProfileWithSecret = () => ({ id: 'offline', databaseName: 'offline' });
    require('./src/services/backupService').runBackup = () => new Promise(resolve => {
      process.send('task-started');
      process.on('message', message => { if (message === 'finish-task') resolve({ objectCount: 1 }); });
    });
    process.on('message', message => { if (message === 'ping') process.send('still-alive'); });
    require('./src/server');
  `;
  const environment = { ...process.env, DATA_DIR: path.join(root, "data"), ARTIFACTS_DIR: path.join(root, "artifacts"), PORT: "4499" };
  for (const key of ["LOGS_DIR", "EXPORTS_DIR", "SCRIPTS_DIR", "REPORTS_DIR", "TEMP_DIR", "CODEDIFF_DIR", "LOG_ARCHIVE_DIR"]) delete environment[key];
  const child = spawn(process.execPath, ["-e", source], { cwd: path.resolve(__dirname, "../.."), env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const waitMessage = (expected) => new Promise((resolve) => {
    const handler = (message) => { if (message === expected) { child.removeListener("message", handler); resolve(); } };
    child.on("message", handler);
  });
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/listening on (http:\/\/[^\s]+)/); if (match) resolve(match[1]); });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Server exited before readiness")));
    });
    const { token } = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
    const started = waitMessage("task-started");
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/api/backup/run`, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Pebloy-Token": token },
      body: JSON.stringify({ sourceProfileId: "offline", selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Offline" }] }),
    }).catch(() => {});
    await started;
    controller.abort();
    await request;
    child.send("shutdown");
    const alive = waitMessage("still-alive");
    child.send("ping");
    await alive;
    expect(child.exitCode).toBeNull();
    child.send("finish-task");
    expect(await exited).toBe(0);
    const logDir = path.join(root, "artifacts", "logs");
    const logs = fs.readdirSync(logDir).filter((name) => name.endsWith(".json"));
    expect(JSON.parse(fs.readFileSync(path.join(logDir, logs[0]), "utf8")).status).toBe("Success");
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);