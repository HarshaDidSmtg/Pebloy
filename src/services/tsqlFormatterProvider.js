const poorSql = require("poor-mans-t-sql-formatter");
const { splitGoBatches } = require("./sqlBatchService");
const GO_LINE_PATTERN = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/i;

const { DEFAULT_INTERACTIVE_FORMATTER_OPTIONS } = require("./formatterOptions");

// GO is a batch separator understood by clients, not by the SQL parser.
// Batches are formatted independently and GO lines (incl. "GO 5") preserved.

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function analyzeInput(text) {
  const raw = String(text ?? "");
  const bom = raw.startsWith("﻿");
  const body = bom ? raw.slice(1) : raw;
  return {
    body,
    bom,
    eol: detectEol(body),
    trailingNewline: /\r?\n$/.test(body),
  };
}

function assembleBatches(chunks, eol, { bom, trailingNewline }) {
  const out = chunks.join("\n\n").replace(/\n/g, eol);
  return (bom ? "﻿" : "") + out + (trailingNewline ? eol : "");
}

// Pebloy option ids → Poor Man's T-SQL Formatter engine options.
// `useTabs`/`tabWidth` become poorsql's `indent`/`spacesPerTab`.
function toPoorSqlOptions(formatterOptions = {}) {
  const merged = { ...DEFAULT_INTERACTIVE_FORMATTER_OPTIONS, ...formatterOptions };
  const tabWidth = Number.isInteger(merged.tabWidth) ? Math.min(8, Math.max(2, merged.tabWidth)) : 4;
  return {
    indent: merged.useTabs ? "\t" : " ".repeat(tabWidth),
    spacesPerTab: tabWidth,
    maxLineWidth: merged.maxLineWidth,
    statementBreaks: merged.statementBreaks,
    clauseBreaks: merged.clauseBreaks,
    expandCommaLists: merged.expandCommaLists,
    trailingCommas: merged.trailingCommas,
    spaceAfterExpandedComma: merged.spaceAfterExpandedComma,
    expandBooleanExpressions: merged.expandBooleanExpressions,
    expandCaseStatements: merged.expandCaseStatements,
    expandBetweenConditions: merged.expandBetweenConditions,
    expandInLists: merged.expandInLists,
    breakJoinOnSections: merged.breakJoinOnSections,
    uppercaseKeywords: merged.uppercaseKeywords,
    keywordStandardization: merged.keywordStandardization,
  };
}

// ── Modern-syntax masking ────────────────────────────────────────────────
// The poorsql engine's parser predates SQL Server 2016 syntax: it splits
// "DROP TABLE IF EXISTS x" into a DROP plus a bogus IF statement (the same
// bug exists on poorsql.com) and mangles "CREATE OR ALTER". Hiding the
// modern phrase inside a block-comment marker makes the engine parse the
// statement as its classic form; comments pass through formatting verbatim,
// so the marker survives in place and is swapped back afterwards.
const IF_EXISTS_MARKER = "PBLIFX";
const OR_ALTER_MARKER = "PBLORA";

const DROP_IF_EXISTS_STICKY = new RegExp(
  "(DROP\\s+(?:TABLE|PROC(?:EDURE)?|FUNCTION|VIEW|INDEX|TRIGGER|SEQUENCE|SYNONYM|SCHEMA|DATABASE|TYPE|USER|ROLE|RULE|DEFAULT|ASSEMBLY|AGGREGATE|EXTERNAL\\s+TABLE|SECURITY\\s+POLICY)\\s+)(IF\\s+EXISTS)(?![\\w@#$])",
  "iy"
);
const CREATE_OR_ALTER_STICKY = new RegExp(
  "(CREATE\\s+)(OR\\s+ALTER)(?=\\s+(?:PROC(?:EDURE)?|FUNCTION|VIEW|TRIGGER)\\b)",
  "iy"
);

function collapsePhrase(phrase) {
  return phrase.replace(/\s+/g, " ");
}

// Walks the batch text, skipping strings, bracket identifiers, and comments,
// and replaces modern phrases in code regions with block-comment markers
// that carry the original phrase text.
function maskModernSyntax(text) {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "[") {
      let j = text.indexOf("]", i + 1);
      j = j === -1 ? n : j + 1;
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "-" && text[i + 1] === "-") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if ((ch === "D" || ch === "d" || ch === "C" || ch === "c") && (i === 0 || !/[\w@#$.\]]/.test(text[i - 1]))) {
      DROP_IF_EXISTS_STICKY.lastIndex = i;
      let match = DROP_IF_EXISTS_STICKY.exec(text);
      if (match) {
        out += `${match[1]}/*${IF_EXISTS_MARKER} ${collapsePhrase(match[2])}*/`;
        i += match[0].length;
        continue;
      }
      CREATE_OR_ALTER_STICKY.lastIndex = i;
      match = CREATE_OR_ALTER_STICKY.exec(text);
      if (match) {
        out += `${match[1]}/*${OR_ALTER_MARKER} ${collapsePhrase(match[2])}*/`;
        i += match[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return out;
}

const UNMASK_PATTERN = new RegExp(`\\/\\*(${IF_EXISTS_MARKER}|${OR_ALTER_MARKER}) ([^*]*?)\\*\\/`, "g");

function unmaskModernSyntax(text, uppercaseKeywords) {
  return text.replace(UNMASK_PATTERN, (_m, _marker, phrase) => (uppercaseKeywords ? phrase.toUpperCase() : phrase));
}

// The engine can leave a trailing space where a token was wrapped away
// (e.g. before a relocated line comment), which would make a second format
// pass differ. Stripping line-trailing whitespace restores idempotency —
// but only on lines that do not end inside a string literal or block
// comment, where the whitespace is real content.
function stripTrailingLineWhitespace(text) {
  const lines = text.split("\n");
  let quote = null;
  let blockCommentDepth = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (blockCommentDepth > 0) {
        if (ch === "*" && line[i + 1] === "/") { blockCommentDepth -= 1; i += 1; continue; }
        if (ch === "/" && line[i + 1] === "*") { blockCommentDepth += 1; i += 1; }
        continue;
      }
      if (quote) {
        if (ch === quote) {
          if (quote === "'" && line[i + 1] === "'") { i += 1; continue; }
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "[") { quote = "]"; continue; }
      if (ch === "/" && line[i + 1] === "*") { blockCommentDepth = 1; i += 1; continue; }
      if (ch === "-" && line[i + 1] === "-") break; // line comment: rest of line is comment
    }
    if (!quote && blockCommentDepth === 0) {
      lines[li] = line.replace(/[ \t]+$/, "");
    }
  }
  return lines.join("\n");
}

const CTE_START_LINE_PATTERN = /^(\s*);?\s*WITH\s+(?!XMLNAMESPACES\b|CHANGE_TRACKING_CONTEXT\b)(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#@][\w$#@]*)\s+AS\b/i;
const CTE_START_SPLIT_LINE_PATTERN = /^(\s*);?\s*WITH\s+(?!XMLNAMESPACES\b|CHANGE_TRACKING_CONTEXT\b)(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#@][\w$#@]*)\s*$/i;
const CTE_AS_LINE_PATTERN = /^\s*AS\b/i;
const CTE_CONTINUATION_LINE_PATTERN = /^(\s*),\s*((?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$#@]*)(?:\s+AS\s*\(.*)?)\s*$/i;

function removeTrailingSemicolonFromPreviousStatement(lines, cteLineIndex) {
  for (let j = cteLineIndex - 1; j >= 0; j--) {
    if (!lines[j].trim()) continue;
    if (!/^GO(?:\s+\d+)?\s*;?$/i.test(lines[j].trim())) {
      lines[j] = lines[j].replace(/[ \t]*;[ \t]*$/, "");
    }
    break;
  }
}

function previousNonEmptyLine(lines, startIndex) {
  for (let i = startIndex; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function shouldPrefixCteWithSemicolon(lines, cteLineIndex) {
  const previous = previousNonEmptyLine(lines, cteLineIndex - 1).trim();
  if (!previous) return true;
  if (/^(AS|RETURN)\b/i.test(previous)) return false;
  return true;
}

function nextNonEmptyLine(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function findCteListIndent(lines, lineIndex) {
  for (let i = lineIndex - 1; i >= 0; i--) {
    const withMatch = /^(\s*);WITH\b/i.exec(lines[i]);
    if (withMatch) return withMatch[1] || "";

    const continuationMatch = CTE_CONTINUATION_LINE_PATTERN.exec(lines[i]);
    if (continuationMatch && (/\bAS\b/i.test(continuationMatch[2]) || CTE_AS_LINE_PATTERN.test(nextNonEmptyLine(lines, i + 1).trim()))) {
      return continuationMatch[1] || "";
    }
  }
  return "";
}

function normalizeCteContinuationCommas(text) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = CTE_CONTINUATION_LINE_PATTERN.exec(lines[i]);
    if (!match) continue;

    const continuationText = match[2].trim();
    const hasInlineAs = /\bAS\b/i.test(continuationText);
    const hasNextLineAs = CTE_AS_LINE_PATTERN.test(nextNonEmptyLine(lines, i + 1).trim());
    if (!hasInlineAs && !hasNextLineAs) continue;

    lines[i] = `${findCteListIndent(lines, i)},${continuationText}`;
  }
  return lines.join("\n");
}

function repairSplitBracketIdentifiers(text) {
  return String(text || "").replace(/\[([^\]\r\n]*)\r?\n[ \t]*\]/g, "[$1]");
}

function finalizeFormattedText(text, uppercaseKeywords) {
  return repairSplitBracketIdentifiers(normalizeCteContinuationCommas(placeCteSemicolonBeforeWith(
    stripTrailingLineWhitespace(
      unmaskModernSyntax(
        text.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd(),
        uppercaseKeywords
      )
    )
  ))).replace(/\n{2,}(\s*;WITH\b)/gi, "\n$1");
}

function placeCteSemicolonBeforeWith(text) {
  const lines = String(text || "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    let match = CTE_START_LINE_PATTERN.exec(lines[i]);
    if (match) {
      const indent = match[1] || "";
      const cteLine = lines[i].trimStart().replace(/^;+\s*/, "");
      const needsSemicolon = shouldPrefixCteWithSemicolon(lines, i);
      lines[i] = `${indent}${needsSemicolon ? ";" : ""}${cteLine}`;
      if (needsSemicolon) removeTrailingSemicolonFromPreviousStatement(lines, i);
      continue;
    }

    match = CTE_START_SPLIT_LINE_PATTERN.exec(lines[i]);
    if (!match) continue;

    let asLineIndex = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (CTE_AS_LINE_PATTERN.test(lines[j])) asLineIndex = j;
      break;
    }
    if (asLineIndex === -1) continue;

    const indent = match[1] || "";
    const cteLine = lines[i].trimStart().replace(/^;+\s*/, "");
    const needsSemicolon = shouldPrefixCteWithSemicolon(lines, i);
    lines[i] = `${indent}${needsSemicolon ? ";" : ""}${cteLine} ${lines[asLineIndex].trimStart()}`;
    lines.splice(asLineIndex, 1);
    if (needsSemicolon) removeTrailingSemicolonFromPreviousStatement(lines, i);
    if (asLineIndex < i) {
      i -= 1;
    }
  }

  return lines.join("\n");
}

// Formatting is a pure function of (batch text, options). The poorsql engine
// costs 10–20 ms per batch, so identical batches — common in generated
// multi-batch deployment scripts — are memoized.
const BATCH_CACHE_LIMIT = 1000;
const batchCache = new Map();

function formatBatch(sql, poorSqlOptions, optionsKey) {
  const source = String(sql || "");
  if (!source.trim()) return "";

  const cacheKey = `${optionsKey} ${source}`;
  const cached = batchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const masked = maskModernSyntax(source);
  const result = poorSql.formatSql(masked, poorSqlOptions);
  let formatted;
  if (result.errorFound) {
    // Unparseable batches remain unchanged instead of being guessed.
    formatted = source;
  } else {
    const uppercaseKeywords = poorSqlOptions.uppercaseKeywords !== false;
    formatted = finalizeFormattedText(result.text, uppercaseKeywords);
    if (/(^|\n)\s*;WITH\b/i.test(formatted)) {
      const stabilized = poorSql.formatSql(maskModernSyntax(formatted), poorSqlOptions);
      if (!stabilized.errorFound) {
        formatted = finalizeFormattedText(stabilized.text, uppercaseKeywords);
      }
    }
  }

  if (batchCache.size >= BATCH_CACHE_LIMIT) batchCache.clear();
  batchCache.set(cacheKey, formatted);
  return formatted;
}

function buildChunk(batch, poorSqlOptions, optionsKey) {
  const formatted = formatBatch(batch.sql, poorSqlOptions, optionsKey);
  if (batch.separator === null) {
    return formatted || null;
  }
  return formatted ? `${formatted}\n${batch.separator}` : batch.separator;
}

function formatTextSync(text, formatterOptions) {
  const input = analyzeInput(text);
  if (!input.body.trim()) return String(text ?? "");

  const poorSqlOptions = toPoorSqlOptions(formatterOptions);
  const optionsKey = JSON.stringify(poorSqlOptions);
  const chunks = [];
  for (const batch of splitGoBatches(input.body)) {
    const chunk = buildChunk(batch, poorSqlOptions, optionsKey);
    if (chunk !== null) chunks.push(chunk);
  }
  return assembleBatches(chunks, input.eol, input);
}

async function formatTextAsync(text, formatterOptions, { onProgress = null } = {}) {
  const input = analyzeInput(text);
  if (!input.body.trim()) return String(text ?? "");

  const poorSqlOptions = toPoorSqlOptions(formatterOptions);
  const optionsKey = JSON.stringify(poorSqlOptions);
  const batches = splitGoBatches(input.body);
  const chunks = [];
  for (let i = 0; i < batches.length; i++) {
    const chunk = buildChunk(batches[i], poorSqlOptions, optionsKey);
    if (chunk !== null) chunks.push(chunk);
    if (onProgress) onProgress({ done: i + 1, total: batches.length });
    if (i % 5 === 4) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return assembleBatches(chunks, input.eol, input);
}

// ── Minify ───────────────────────────────────────────────────────────────
// Whitespace-collapse minifier (PoorSQL's "minify" mode): strings, bracket
// identifiers, and comments pass through verbatim; runs of whitespace become
// a single space. Line comments force a newline (the rest of the line would
// otherwise be swallowed), and GO separators keep their own lines.
function minifyBatch(sql) {
  const text = String(sql || "");
  let out = "";
  let i = 0;

  const flushSpace = () => {
    if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
  };

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      flushSpace();
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "[") {
      let j = text.indexOf("]", i + 1);
      j = j === -1 ? text.length : j + 1;
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "-" && text[i + 1] === "-") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = text.length;
      out += text.slice(i, j).trimEnd() + "\n";
      i = j;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      let j = text.indexOf("*/", i + 2);
      j = j === -1 ? text.length : j + 2;
      out += text.slice(i, j);
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.trim();
}

function minifyTextSync(text) {
  const input = analyzeInput(text);
  if (!input.body.trim()) return String(text ?? "");

  const chunks = [];
  for (const batch of splitGoBatches(input.body)) {
    const minified = minifyBatch(batch.sql);
    if (batch.separator === null) {
      if (minified) chunks.push(minified);
    } else {
      chunks.push(minified ? `${minified}\n${batch.separator}` : batch.separator);
    }
  }
  const out = chunks.join("\n").replace(/\n/g, input.eol);
  return (input.bom ? "﻿" : "") + out + (input.trailingNewline ? input.eol : "");
}

module.exports = {
  GO_LINE_PATTERN,
  analyzeInput,
  formatTextAsync,
  formatTextSync,
  maskModernSyntax,
  minifyBatch,
  minifyTextSync,
  splitGoBatches,
  toPoorSqlOptions,
  unmaskModernSyntax,
};
