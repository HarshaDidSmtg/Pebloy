const { parentPort, workerData } = require("worker_threads");
const { compareMaps, compareMapsWithSemantic } = require("./diffService");

try {
  const { sourceMap, destinationMap, semanticChanges } = workerData;
  const result = semanticChanges === null
    ? compareMaps(sourceMap, destinationMap)
    : compareMapsWithSemantic(sourceMap, destinationMap, semanticChanges);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}