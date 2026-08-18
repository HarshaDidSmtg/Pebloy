const { parentPort } = require("worker_threads");

const { formatTextAsync } = require("./tsqlFormatterProvider");

if (!parentPort) {
  throw new Error("formatterWorker must be started as a worker thread.");
}

parentPort.on("message", async (message) => {
  const requestId = String(message?.requestId || "");
  try {
    const formatted = await formatTextAsync(message?.sql ?? "", message?.options || {}, {
      onProgress: ({ done, total }) => {
        parentPort.postMessage({ type: "progress", requestId, done, total });
      },
    });
    parentPort.postMessage({ type: "result", requestId, formatted });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});