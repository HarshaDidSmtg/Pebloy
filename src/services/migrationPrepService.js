const fs = require("fs");
const path = require("path");
const { fetchObjectProtectionMetadata } = require("./sqlService");
const { writeSqlFileSync } = require("./sqlFileEncoding");
const { EXPORTS_DIR } = require("./paths");

function quoted(schemaName, objectName) {
  return `[${String(schemaName).replace(/]/g, "]]")}].[${String(objectName).replace(/]/g, "]]")}]`;
}

function groupByObject(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = `${row.schemaName}.${row.objectName}`;
    if (!grouped.has(key)) grouped.set(key, { schemaName: row.schemaName, objectName: row.objectName, rows: [] });
    grouped.get(key).rows.push(row);
  }
  return grouped;
}

function buildObjectSection(entry) {
  const name = quoted(entry.schemaName, entry.objectName);
  const kinds = (kind) => entry.rows.filter((row) => row.kind === kind);
  const lines = [`/* ---- ${entry.schemaName}.${entry.objectName} ---- */`];

  const dependents = [...kinds("Dependent"), ...kinds("TypeDependent")];
  if (dependents.length) {
    lines.push("-- Dependent objects. Deploy them alongside this change; Pebloy will not drop them for you.");
    dependents.forEach((row) => lines.push(`--   ${row.detail1}.${row.detail2} (${row.detail3})`));
  }

  const signatures = kinds("Signature");
  if (signatures.length) {
    lines.push("-- Module is signed. Re-sign it after the change or the signature is silently lost.");
    signatures.forEach((row) => lines.push(`--   thumbprint ${row.detail1} (${row.detail2})`));
    lines.push(`-- ADD SIGNATURE TO ${name} BY CERTIFICATE [<certificate>] WITH PASSWORD = '<password>';`);
  }

  const owner = kinds("Owner")[0];
  if (owner) lines.push(`ALTER AUTHORIZATION ON OBJECT::${name} TO [${owner.detail1}];`);

  const sequence = kinds("SequenceState")[0];
  if (sequence) {
    lines.push(`-- Recreating a sequence resets it. Current value was ${sequence.detail1}.`);
    lines.push(`ALTER SEQUENCE ${name} RESTART WITH ${sequence.detail1};`);
  }

  const permissions = kinds("Permission");
  if (permissions.length) {
    lines.push("-- Explicit permissions to re-apply:");
    permissions.forEach((row) => {
      const verb = String(row.detail2 || "GRANT").toUpperCase() === "DENY" ? "DENY" : "GRANT";
      lines.push(`${verb} ${row.detail1} ON OBJECT::${name} TO [${row.detail3}];`);
    });
  }

  if (lines.length === 1) lines.push("-- No protected metadata found for this object.");
  return lines.join("\n");
}

// Produces a reviewable script only. Nothing here is executed by Pebloy.
async function buildMigrationPrep(destinationProfile, selectedObjects = [], options = {}) {
  const rows = await fetchObjectProtectionMetadata(destinationProfile, selectedObjects);
  const grouped = groupByObject(rows);

  const header = [
    "/*",
    " Pebloy migration scaffold — REVIEW BEFORE USE.",
    ` Target : ${destinationProfile.serverName} / ${destinationProfile.databaseName}`,
    ` Created: ${new Date().toISOString()}`,
    "",
    " Pebloy refuses to drop objects that carry permissions, ownership, signatures,",
    " or dependents because it cannot know your intent. This script captures that",
    " metadata so you can author the migration yourself.",
    "",
    " Pebloy did not and will not execute this file.",
    "*/",
    "",
  ].join("\n");

  const sections = selectedObjects.map((item) => {
    const entry = grouped.get(`${item.schemaName}.${item.objectName}`);
    return entry ? buildObjectSection(entry)
      : `/* ---- ${item.schemaName}.${item.objectName} ---- */\n-- No protected metadata found for this object.`;
  });

  const scriptText = `${header}${sections.join("\n\n")}\n`;
  const outputDir = options.outputDir || path.join(EXPORTS_DIR, "migration-prep");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `MigrationPrep_${options.taskId || Date.now()}.sql`);
  writeSqlFileSync(outputPath, scriptText);

  return {
    outputPath,
    objectCount: selectedObjects.length,
    protectedObjectCount: grouped.size,
    executed: false,
    scriptText,
  };
}

module.exports = { buildMigrationPrep };
