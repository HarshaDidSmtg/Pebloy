const fs = require("fs");
const os = require("os");
const path = require("path");
describe("schedules", () => {
  let root;
  let previousData;
  let service;
  const now = Date.parse("2030-01-01T12:00:00Z");
  const input = { name: "Nightly QA", confirmed: true, repeat: "daily", nextRunAt: "2030-01-01T13:00:00Z", request: {
    sourceProfileId: "source", targetProfileIds: ["qa"], selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Fixture" }],
    mode: "DryRun", options: { confirmedBatchFingerprint: "a".repeat(64) }, password: "must-not-persist",
  } };
  beforeEach(() => {
    jest.resetModules();
    previousData = process.env.DATA_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-schedules-"));
    process.env.DATA_DIR = root;
    service = require("./scheduleService");
  });
  afterEach(() => {
    if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  });
  test("stores only reviewed inputs and runs due jobs once without backlog replay", async () => {
    const job = service.saveSchedule(input, null, now);
    expect(fs.readFileSync(service.SCHEDULE_FILE, "utf8")).not.toContain("must-not-persist");
    const execute = jest.fn(async () => ({ taskId: "task", summary: { failed: 0 } }));
    const due = now + 4 * 86400000;
    await service.runDueSchedules({ execute, now: due });
    await service.runDueSchedules({ execute, now: due });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(Date.parse(service.readSchedules()[0].nextRunAt)).toBeGreaterThan(due);
    service.pauseSchedule(job.id);
    await service.runDueSchedules({ execute, now: due + 10 * 86400000 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test("does not overlap, and stale approval pauses the schedule", async () => {
    service.saveSchedule(input, null, now);
    let finish;
    const execute = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const running = service.runDueSchedules({ execute, now: now + 7200000 });
    expect(await service.runDueSchedules({ execute, now: now + 7200000 })).toEqual([]);
    finish({ summary: { failed: 1 } });
    await running;
    expect(service.readSchedules()[0]).toMatchObject({ enabled: false, lastStatus: "NeedsReview" });
  });
  test("recovers interrupted jobs without retry and requires reauthorization", () => {
    const job = service.saveSchedule(input, null, now);
    fs.writeFileSync(service.SCHEDULE_FILE, JSON.stringify([{ ...job, lastStatus: "Running" }]));
    service.recoverInterruptedSchedules();
    expect(service.readSchedules()[0]).toMatchObject({ enabled: false, lastStatus: "Interrupted" });
    expect(() => service.saveSchedule({ ...input, confirmed: false }, job.id, now)).toThrow("confirmation");
    expect(() => service.saveSchedule({ ...input, nextRunAt: "2020-01-01" }, job.id, now)).toThrow("future");
  });
});