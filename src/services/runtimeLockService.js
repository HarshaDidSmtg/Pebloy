const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { createHash, randomUUID } = require("crypto");

async function acquireRuntimeLocks(directories) {
  const identities = [...new Set(directories.map((directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const canonical = fs.realpathSync(directory);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  }))].sort();
  const locks = [];
  const release = async () => {
    await Promise.all(locks.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  };
  try {
    for (const identity of identities) {
      const digest = createHash("sha256").update(identity).digest("hex");
      const address = process.platform === "win32" ? `\\\\.\\pipe\\pebloy-${digest}` : path.join(os.tmpdir(), `pebloy-${digest}.sock`);
      const server = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => { server.removeListener("error", reject); resolve(); });
      });
      locks.push(server);
    }
    return { runtimeId: randomUUID(), release };
  } catch (error) {
    await release();
    if (error.code === "EADDRINUSE" || error.code === "EACCES") {
      throw new Error("Runtime storage is already in use or cannot be locked. Close the other Pebloy backend or choose separate data/artifact directories.");
    }
    throw error;
  }
}

module.exports = { acquireRuntimeLocks };