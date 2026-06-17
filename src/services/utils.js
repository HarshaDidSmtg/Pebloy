// Utility functions for Pebloy services

function normalizeAuthType(authType) {
  // Only accept "Sql" or "Windows" (case-insensitive), fallback to "Windows"
  const value = String(authType || "").trim().toLowerCase();
  if (value === "sql") return "Sql";
  if (value === "windows") return "Windows";
  return "Windows";
}

function normalizeSqlName(value) {
  return String(value || "").trim().replace(/^\[(.*)\]$/, "$1");
}

module.exports = {
  normalizeAuthType,
  normalizeSqlName,
};