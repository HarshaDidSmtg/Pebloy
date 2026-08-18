const fs = require("fs");
const { randomUUID } = require("crypto");
const { createPatch, diffLines } = require("diff");
const { generateScriptsForProfile, getCodeDiffOutputPaths } = require("./scriptGenerationService");
const { normalizeDdlKeywords } = require("./scriptAutomationService");
const { compareGeneratedArtifacts, normalizeEngine, validateGeneratedArtifacts } = require("./dacfxService");
const { getSettings } = require("./settingsService");
const { writeReportArtifact } = require("./loggingService");

const DACFX_COMPARE_TIMEOUT_MS = 30000;
const DACFX_COMPARE_OBJECT_TYPES = new Set(["TABLE", "USER_DEFINED_TYPE"]);

function buildObjectKey(objectType, schemaName, objectName) {
  return `${String(objectType || "").toUpperCase().trim()}|${String(schemaName || "").trim().toLowerCase()}|${String(objectName || "").trim().toLowerCase()}`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitLinesPreserve(text) {
  const value = String(text || "").replace(/\r\n/g, "\n");
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function flushPendingDiffRows(rows, pendingRemoved, pendingAdded) {
  if (!pendingRemoved.length && !pendingAdded.length) {
    return;
  }

  const count = Math.max(pendingRemoved.length, pendingAdded.length);
  for (let index = 0; index < count; index += 1) {
    const left = pendingRemoved[index] || null;
    const right = pendingAdded[index] || null;
    rows.push({
      status: left && right ? "modified" : left ? "removed" : "added",
      leftLineNumber: left ? left.lineNumber : null,
      leftText: left ? left.text : "",
      rightLineNumber: right ? right.lineNumber : null,
      rightText: right ? right.text : "",
    });
  }

  pendingRemoved.length = 0;
  pendingAdded.length = 0;
}

function buildSideBySideLines(sourceDefinition, destinationDefinition) {
  const changes = diffLines(String(sourceDefinition || ""), String(destinationDefinition || ""));
  const rows = [];
  const pendingRemoved = [];
  const pendingAdded = [];
  let leftLine = 1;
  let rightLine = 1;

  for (const change of changes) {
    const lines = splitLinesPreserve(change.value);

    if (change.removed) {
      lines.forEach((line) => {
        pendingRemoved.push({ lineNumber: leftLine, text: line });
        leftLine += 1;
      });
      continue;
    }

    if (change.added) {
      lines.forEach((line) => {
        pendingAdded.push({ lineNumber: rightLine, text: line });
        rightLine += 1;
      });
      continue;
    }

    flushPendingDiffRows(rows, pendingRemoved, pendingAdded);
    lines.forEach((line) => {
      rows.push({
        status: "unchanged",
        leftLineNumber: leftLine,
        leftText: line,
        rightLineNumber: rightLine,
        rightText: line,
      });
      leftLine += 1;
      rightLine += 1;
    });
  }

  flushPendingDiffRows(rows, pendingRemoved, pendingAdded);
  return rows;
}

function renderLineDiffTable(lineDiff) {
  const rows = (lineDiff || [])
    .map((row) => {
      const leftNumber = row.leftLineNumber == null ? "" : String(row.leftLineNumber);
      const rightNumber = row.rightLineNumber == null ? "" : String(row.rightLineNumber);
      return `<tr class="diff-row diff-${row.status}">
<td class="ln">${leftNumber}</td>
<td class="code">${escapeHtml(row.leftText || "")}</td>
<td class="ln">${rightNumber}</td>
<td class="code">${escapeHtml(row.rightText || "")}</td>
</tr>`;
    })
    .join("\n");

  return `<table class="diff-table">
<thead><tr><th colspan="2">Source</th><th colspan="2">Destination</th></tr></thead>
<tbody>${rows || "<tr><td colspan=\"4\">No line-level changes</td></tr>"}</tbody>
</table>`;
}

function normalizeForCompare(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function scriptsToMap(scripts) {
  const result = new Map();
  for (const script of scripts || []) {
    const key = buildObjectKey(script.objectType, script.schemaName, script.objectName);
    result.set(key, {
      objectType: script.objectType,
      schemaName: script.schemaName,
      objectName: script.objectName,
      definition: fs.existsSync(script.scriptPath) ? normalizeDdlKeywords(fs.readFileSync(script.scriptPath, "utf8").trim()) : "",
    });
  }
  return result;
}

function compareMapsWithSemantic(sourceMap, destinationMap, semanticChanges = []) {
  const semanticByKey = new Map(
    (semanticChanges || []).map((change) => [
      buildObjectKey(change.objectType, change.schemaName, change.objectName),
      change,
    ])
  );
  const keys = new Set([...sourceMap.keys(), ...destinationMap.keys()]);
  const details = [];
  const summary = {
    added: 0,
    missing: 0,
    changed: 0,
    unchanged: 0,
  };

  for (const key of keys) {
    const left = sourceMap.get(key);
    const right = destinationMap.get(key);
    const semanticChange = semanticByKey.get(key);

    if (left && !right) {
      summary.added += 1;
      details.push({
        objectType: left.objectType,
        schemaName: left.schemaName,
        objectName: left.objectName,
        status: "Added",
        diffText: left.definition,
        sourceDefinition: left.definition || "",
        destinationDefinition: "",
        lineDiff: buildSideBySideLines(left.definition, ""),
        semanticOperation: semanticChange?.operation || "Create",
      });
      continue;
    }

    if (!left && right) {
      summary.missing += 1;
      details.push({
        objectType: right.objectType,
        schemaName: right.schemaName,
        objectName: right.objectName,
        status: "Missing",
        diffText: right.definition,
        sourceDefinition: "",
        destinationDefinition: right.definition || "",
        lineDiff: buildSideBySideLines("", right.definition),
        semanticOperation: "Drop",
      });
      continue;
    }

    if (semanticChange) {
      summary.changed += 1;
      details.push({
        objectType: left.objectType,
        schemaName: left.schemaName,
        objectName: left.objectName,
        status: "Changed",
        diffText: createPatch(
          `${left.schemaName}.${left.objectName}`,
          left.definition || "",
          right.definition || "",
          "source",
          "destination"
        ),
        sourceDefinition: left.definition || "",
        destinationDefinition: right.definition || "",
        lineDiff: buildSideBySideLines(left.definition || "", right.definition || ""),
        semanticOperation: semanticChange.operation,
      });
      continue;
    }

    summary.unchanged += 1;
    details.push({
      objectType: left.objectType,
      schemaName: left.schemaName,
      objectName: left.objectName,
      status: "Unchanged",
      diffText: "",
      sourceDefinition: left.definition || "",
      destinationDefinition: right.definition || "",
      lineDiff: [],
      semanticOperation: "None",
    });
  }

  details.sort((a, b) => {
    if (a.objectType !== b.objectType) return a.objectType.localeCompare(b.objectType);
    if (a.schemaName !== b.schemaName) return a.schemaName.localeCompare(b.schemaName);
    return a.objectName.localeCompare(b.objectName);
  });

  return { summary, details };
}

function compareMaps(sourceMap, destinationMap) {
  const keys = new Set([...sourceMap.keys(), ...destinationMap.keys()]);
  const details = [];
  const summary = {
    added: 0,
    missing: 0,
    changed: 0,
    unchanged: 0,
  };

  for (const key of keys) {
    const left = sourceMap.get(key);
    const right = destinationMap.get(key);

    if (left && !right) {
      summary.added += 1;
      const lineDiff = buildSideBySideLines(left.definition, "");
      details.push({
        objectType: left.objectType,
        schemaName: left.schemaName,
        objectName: left.objectName,
        status: "Added",
        diffText: left.definition,
        sourceDefinition: left.definition || "",
        destinationDefinition: "",
        lineDiff,
      });
      continue;
    }

    if (!left && right) {
      summary.missing += 1;
      const lineDiff = buildSideBySideLines("", right.definition);
      details.push({
        objectType: right.objectType,
        schemaName: right.schemaName,
        objectName: right.objectName,
        status: "Missing",
        diffText: right.definition,
        sourceDefinition: "",
        destinationDefinition: right.definition || "",
        lineDiff,
      });
      continue;
    }

    const same = normalizeForCompare(left.definition) === normalizeForCompare(right.definition);
    if (same) {
      summary.unchanged += 1;
      details.push({
        objectType: left.objectType,
        schemaName: left.schemaName,
        objectName: left.objectName,
        status: "Unchanged",
        diffText: "",
        sourceDefinition: left.definition || "",
        destinationDefinition: right.definition || "",
        lineDiff: [],
      });
    } else {
      summary.changed += 1;
      const lineDiff = buildSideBySideLines(left.definition || "", right.definition || "");
      details.push({
        objectType: left.objectType,
        schemaName: left.schemaName,
        objectName: left.objectName,
        status: "Changed",
        diffText: createPatch(
          `${left.schemaName}.${left.objectName}`,
          left.definition || "",
          right.definition || "",
          "source",
          "destination"
        ),
        sourceDefinition: left.definition || "",
        destinationDefinition: right.definition || "",
        lineDiff,
      });
    }
  }

  details.sort((a, b) => {
    if (a.objectType !== b.objectType) return a.objectType.localeCompare(b.objectType);
    if (a.schemaName !== b.schemaName) return a.schemaName.localeCompare(b.schemaName);
    return a.objectName.localeCompare(b.objectName);
  });

  return { summary, details };
}

function filterMapBySelection(map, selectedObjects = []) {
  if (!selectedObjects.length) {
    return map;
  }

  const fullKeys = new Set();
  const partialKeys = new Set();

  for (const item of selectedObjects) {
    const type = String(item.objectType || "").toUpperCase().trim();
    const schema = String(item.schemaName || "").trim();
    const name = String(item.objectName || "").trim();
    if (!schema || !name) continue;
    if (type) {
      fullKeys.add(buildObjectKey(type, schema, name));
    } else {
      partialKeys.add(`${schema.toLowerCase()}|${name.toLowerCase()}`);
    }
  }

  return new Map(
    [...map.entries()].filter(([key]) => {
      if (fullKeys.has(key)) return true;
      if (partialKeys.size > 0) {
        const parts = key.split("|");
        if (parts.length === 3 && partialKeys.has(`${parts[1]}|${parts[2]}`)) return true;
      }
      return false;
    })
  );
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timeoutHandle);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
  });
}

function shouldUseDacFxCompare(requestedEngine, selectedObjects = []) {
  if (requestedEngine !== "DacFx") {
    return false;
  }

  return (selectedObjects || []).some((item) =>
    DACFX_COMPARE_OBJECT_TYPES.has(String(item.objectType || "").toUpperCase().trim())
  );
}

async function compareObjects(sourceProfile, destinationProfile, selectedObjects = [], options = {}) {
  if (!selectedObjects.length) {
    throw new Error("Select at least one object before running CodeDiff.");
  }

  const taskId = options.taskId || randomUUID();
  const requestedEngine = normalizeEngine(options.engine);
  const useDacFxCompare = shouldUseDacFxCompare(requestedEngine, selectedObjects);
  const engine = useDacFxCompare ? "DacFx" : "Legacy";
  const { sourceOut, destOut } = getCodeDiffOutputPaths(taskId);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  let sourceGenerated, destinationGenerated;
  try {
    onProgress({ taskType: "Diff", key: "diff", operation: "Generating latest scripts...", percent: 30 });
    [sourceGenerated, destinationGenerated] = await Promise.all([
      generateScriptsForProfile({ taskId: `${taskId}_src`, profile: sourceProfile, selectedObjects, outputBasePath: sourceOut, appTaskMode: "code_diff" }),
      generateScriptsForProfile({ taskId: `${taskId}_dst`, profile: destinationProfile, selectedObjects, outputBasePath: destOut, appTaskMode: "code_diff" }),
    ]);
  } catch (error) {
    throw new Error(`Script generation failed: ${error.message}`);
  }

  const sourceMap = scriptsToMap(sourceGenerated.scripts);
  const destMap = scriptsToMap(destinationGenerated.scripts);

  let dacfxValidation = { enabled: false };
  if (getSettings().dacfx?.validationEnabled) {
    onProgress({ taskType: "Diff", key: "diff", operation: "Validating generated scripts with DacFx...", percent: 55 });
    const [sourceValidation, destinationValidation] = await Promise.all([
      validateGeneratedArtifacts({ taskId: `${taskId}_src_validate`, scripts: sourceGenerated.scripts }),
      validateGeneratedArtifacts({ taskId: `${taskId}_dst_validate`, scripts: destinationGenerated.scripts }),
    ]);
    dacfxValidation = {
      enabled: true,
      source: sourceValidation,
      destination: destinationValidation,
    };
  }

  onProgress({
    taskType: "Diff",
    key: "diff",
    operation: engine === "DacFx" ? "Running DacFx semantic compare..." : "Comparing object definitions...",
    percent: 75,
  });

  const filteredSourceMap = filterMapBySelection(sourceMap, selectedObjects);
  const filteredDestMap = filterMapBySelection(destMap, selectedObjects);
  let compared;
  let semanticCompare = null;
  let semanticAlerts = [];
  let semanticWarnings = [];

  if (requestedEngine === "DacFx" && !useDacFxCompare) {
    semanticWarnings.push(
      "DacFx semantic compare was skipped for a non-table selection to keep CodeDiff responsive; returning fresh-script textual diff."
    );
  }

  if (useDacFxCompare) {
    try {
      semanticCompare = await withTimeout(
        compareGeneratedArtifacts({
          taskId,
          sourceScripts: sourceGenerated.scripts,
          destinationProfile,
        }),
        DACFX_COMPARE_TIMEOUT_MS,
        "DacFx semantic compare"
      );
      semanticAlerts = semanticCompare.alerts || [];
      semanticWarnings = semanticCompare.warnings || [];
      compared = compareMapsWithSemantic(filteredSourceMap, filteredDestMap, semanticCompare.changes || []);
    } catch (error) {
      semanticWarnings = [
        `DacFx semantic compare failed; returning fresh-script textual diff instead: ${error.message}`,
      ];
      compared = compareMaps(filteredSourceMap, filteredDestMap);
    }
  } else {
    compared = compareMaps(filteredSourceMap, filteredDestMap);
  }

  onProgress({ taskType: "Diff", key: "diff", operation: "Preparing diff results...", percent: 95 });
  return {
    ...compared,
    engine,
    dacfxValidation,
    semanticAlerts,
    semanticWarnings,
    generationWarnings: [
      ...(sourceGenerated.generationWarnings || []).map((warning) => ({ ...warning, profileRole: "source" })),
      ...(destinationGenerated.generationWarnings || []).map((warning) => ({ ...warning, profileRole: "destination" })),
    ],
  };
}

function exportReport(format, report) {
  if (format === "json") {
    const path = writeReportArtifact("diff_report", "json", JSON.stringify(report, null, 2));
    return path;
  }

  if (format === "md") {
    const lines = [
      "# Diff Report",
      "",
      `- Added: ${report.summary.added}`,
      `- Missing: ${report.summary.missing}`,
      `- Changed: ${report.summary.changed}`,
      `- Unchanged: ${report.summary.unchanged}`,
      "",
      "## Object Details",
      "",
      "| Type | Schema | Name | Status |",
      "| --- | --- | --- | --- |",
    ];

    report.details.forEach((item) => {
      lines.push(`| ${item.objectType} | ${item.schemaName} | ${item.objectName} | ${item.status} |`);
    });

    const path = writeReportArtifact("diff_report", "md", lines.join("\n"));
    return path;
  }

  if (format === "html") {
    const rows = report.details
      .map(
        (item) => `<div class="block">
<h3>${escapeHtml(item.objectType)} ${escapeHtml(item.schemaName)}.${escapeHtml(item.objectName)} - ${escapeHtml(item.status)}</h3>
${renderLineDiffTable(item.lineDiff || [])}
</div>`
      )
      .join("\n");

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Diff Report</title>
<style>
body { font-family: Segoe UI, sans-serif; margin: 20px; color: #1b1f24; }
h1 { margin-bottom: 8px; }
.block { border: 1px solid #d1d8e0; border-radius: 8px; padding: 12px; margin: 12px 0; }
.diff-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.diff-table th, .diff-table td { border: 1px solid #e7ebef; padding: 4px 6px; vertical-align: top; }
.diff-table .ln { width: 56px; color: #607080; text-align: right; font-family: Consolas, monospace; }
.diff-table .code { font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.diff-row.diff-added td { background: #e8fff0; }
.diff-row.diff-removed td { background: #fff0f0; }
.diff-row.diff-modified td { background: #fff9e6; }
</style>
</head><body>
<h1>Diff Report</h1>
<ul>
<li>Added: ${report.summary.added}</li>
<li>Missing: ${report.summary.missing}</li>
<li>Changed: ${report.summary.changed}</li>
<li>Unchanged: ${report.summary.unchanged}</li>
</ul>
${rows || "<p>No object details available.</p>"}
</body></html>`;

    const path = writeReportArtifact("diff_report", "html", html);
    return path;
  }

  throw new Error("Unsupported export format. Use md, html, or json.");
}

module.exports = {
  compareObjects,
  exportReport,
};
