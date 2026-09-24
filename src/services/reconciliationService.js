const { fetchObjectDefinitionMap } = require("./sqlService");

// Only module types store their definition text in SQL Server metadata; everything
// else needs a full Code Diff to compare structure.
const COMPARABLE_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);

function keyOf(item) {
  return `${String(item.objectType || "").toUpperCase()}|${item.schemaName}|${item.objectName}`;
}

function normalize(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function classify(sourceDefinition, targetDefinition) {
  if (!targetDefinition) return "MissingInTarget";
  if (!sourceDefinition) return "MissingInSource";
  return normalize(sourceDefinition) === normalize(targetDefinition) ? "MatchesSource" : "DiffersFromSource";
}

// Read-only: reports what the target currently holds after an interrupted or
// uncertain run. It never infers whether a transaction committed.
async function reconcileObjects(sourceProfile, destinationProfile, selectedObjects = []) {
  const objects = (selectedObjects || []).map((item) => ({
    objectType: String(item.objectType || "").toUpperCase().trim(),
    schemaName: String(item.schemaName || "").trim(),
    objectName: String(item.objectName || "").trim(),
  })).filter((item) => item.objectType && item.schemaName && item.objectName);

  if (!objects.length) throw new Error("No objects recorded for this task, so there is nothing to verify.");

  const comparable = objects.filter((item) => COMPARABLE_TYPES.has(item.objectType));
  const [sourceMap, targetMap] = comparable.length
    ? await Promise.all([
        fetchObjectDefinitionMap(sourceProfile, comparable),
        fetchObjectDefinitionMap(destinationProfile, comparable),
      ])
    : [new Map(), new Map()];

  const details = objects.map((item) => {
    if (!COMPARABLE_TYPES.has(item.objectType)) {
      return { ...item, state: "NotComparable", note: "Structure comparison requires a Code Diff run." };
    }
    const state = classify(sourceMap.get(keyOf(item))?.definition, targetMap.get(keyOf(item))?.definition);
    return { ...item, state, note: null };
  });

  const summary = details.reduce((totals, item) => ({ ...totals, [item.state]: (totals[item.state] || 0) + 1 }),
    { MatchesSource: 0, DiffersFromSource: 0, MissingInTarget: 0, MissingInSource: 0, NotComparable: 0 });

  return {
    summary,
    details,
    checkedAt: new Date().toISOString(),
    limitation: "Shows the target's current state only. It cannot prove whether an interrupted transaction committed or rolled back.",
  };
}

module.exports = { reconcileObjects, COMPARABLE_TYPES };
