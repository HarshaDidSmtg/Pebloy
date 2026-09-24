const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { acquireRuntimeLocks } = require("./runtimeLockService");

describe("runtime directory ownership", () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-lock-")); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test("rejects competing owners and releases ownership on close", async () => {
    const owner = await acquireRuntimeLocks([directory, path.join(directory, ".")]);
    try {
      await expect(acquireRuntimeLocks([directory])).rejects.toThrow("already in use");
    } finally { await owner.release(); }
    const next = await acquireRuntimeLocks([directory]);
    expect(next.runtimeId).not.toBe(owner.runtimeId);
    await next.release();
  });

  test("releases acquired directories when another requested directory is busy", async () => {
    const other = path.join(directory, "other");
    const owner = await acquireRuntimeLocks([other]);
    try {
      await expect(acquireRuntimeLocks([directory, other])).rejects.toThrow("already in use");
      const next = await acquireRuntimeLocks([directory]);
      await next.release();
    } finally { await owner.release(); }
  });

  test("Windows releases ownership even when the lock-holding process is terminated", async () => {
    if (process.platform !== "win32") return;
    const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("./runtimeLockService"))}).acquireRuntimeLocks([${JSON.stringify(directory)}]).then(()=>console.log('ready'));`], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once("data", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Lock child exited before readiness")));
      });
      await expect(acquireRuntimeLocks([directory])).rejects.toThrow("already in use");
    } finally { child.kill(); await exited; }
    const next = await acquireRuntimeLocks([directory]);
    await next.release();
  });
});