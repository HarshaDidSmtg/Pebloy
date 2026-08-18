const DEFAULT_FORMATTER_DIALECT = "tsql";

const DEFAULT_INTERACTIVE_FORMATTER_OPTIONS = Object.freeze({
  useTabs: true,
  tabWidth: 4,
  maxLineWidth: 999,
  statementBreaks: 2,
  clauseBreaks: 1,
  expandCommaLists: true,
  trailingCommas: false,
  spaceAfterExpandedComma: true,
  expandBooleanExpressions: true,
  expandCaseStatements: true,
  expandBetweenConditions: true,
  expandInLists: false,
  breakJoinOnSections: false,
  uppercaseKeywords: true,
  keywordStandardization: false,
});

const SUPPORTED_FORMATTER_OPTION_IDS = Object.freeze(Object.keys(DEFAULT_INTERACTIVE_FORMATTER_OPTIONS));
const LEGACY_ALIAS_KEYS = Object.freeze([
  "keywordCase",
  "identifierCase",
  "dataTypeCase",
  "functionCase",
  "indentStyle",
  "logicalOperatorNewline",
  "expressionWidth",
  "linesBetweenQueries",
  "denseOperators",
  "newlineBeforeSemicolon",
]);

const FORMATTER_CAPABILITIES = Object.freeze({
  version: 1,
  defaultDialect: DEFAULT_FORMATTER_DIALECT,
  supportedOptionIds: SUPPORTED_FORMATTER_OPTION_IDS,
  dialects: [
    {
      id: "tsql",
      label: "T-SQL",
      status: "supported",
      notes: [
        "Local/offline formatting only.",
        "GO batches, comments, BOM, EOL style, and trailing newline are preserved.",
        "Unparseable batches remain unchanged instead of being guessed.",
      ],
    },
  ],
  groups: [
    {
      id: "formatting",
      title: "Formatting",
      options: [
        {
          id: "maxLineWidth",
          type: "number",
          min: 0,
          max: 999,
          step: 1,
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.maxLineWidth,
          supported: true,
          description: "Wrap long lines to this approximate width.",
        },
        {
          id: "statementBreaks",
          type: "number",
          min: 1,
          max: 4,
          step: 1,
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.statementBreaks,
          supported: true,
          description: "Line breaks inserted between statements.",
        },
        {
          id: "clauseBreaks",
          type: "number",
          min: 0,
          max: 4,
          step: 1,
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.clauseBreaks,
          supported: true,
          description: "Line breaks inserted between major clauses.",
        },
      ],
    },
    {
      id: "indentation",
      title: "Indentation",
      options: [
        {
          id: "useTabs",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.useTabs,
          supported: true,
          description: "Indent using tabs instead of spaces.",
        },
        {
          id: "tabWidth",
          type: "number",
          min: 2,
          max: 8,
          step: 1,
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.tabWidth,
          supported: true,
          description: "Indent width when spaces are used.",
        },
      ],
    },
    {
      id: "commaStyle",
      title: "Comma Style",
      options: [
        {
          id: "expandCommaLists",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandCommaLists,
          supported: true,
          description: "Expand comma-delimited lists onto separate lines.",
        },
        {
          id: "trailingCommas",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.trailingCommas,
          supported: true,
          description: "Keep commas at the end of the previous line.",
        },
        {
          id: "spaceAfterExpandedComma",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.spaceAfterExpandedComma,
          supported: true,
          description: "Add a space after an expanded comma.",
        },
      ],
    },
    {
      id: "keywords",
      title: "Keywords",
      options: [
        {
          id: "uppercaseKeywords",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.uppercaseKeywords,
          supported: true,
          description: "Uppercase SQL keywords.",
        },
        {
          id: "keywordStandardization",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.keywordStandardization,
          supported: true,
          description: "Standardize vendor keyword spellings where supported.",
        },
      ],
    },
    {
      id: "case",
      title: "CASE",
      supported: false,
      description: "CASE-specific layout is controlled by the general boolean expression options in this release.",
      options: [],
    },
    {
      id: "boolean",
      title: "Boolean",
      options: [
        {
          id: "expandBooleanExpressions",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandBooleanExpressions,
          supported: true,
          description: "Break AND/OR expressions onto separate lines.",
        },
        {
          id: "expandCaseStatements",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandCaseStatements,
          supported: true,
          description: "Expand CASE expressions over multiple lines.",
        },
        {
          id: "expandBetweenConditions",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandBetweenConditions,
          supported: true,
          description: "Expand BETWEEN expressions when wrapping.",
        },
        {
          id: "expandInLists",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandInLists,
          supported: true,
          description: "Expand IN() lists over multiple lines.",
        },
      ],
    },
    {
      id: "join",
      title: "JOIN",
      options: [
        {
          id: "breakJoinOnSections",
          type: "boolean",
          defaultValue: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.breakJoinOnSections,
          supported: true,
          description: "Break JOIN predicates into ON sections.",
        },
      ],
    },
    {
      id: "output",
      title: "Output",
      options: [],
      guarantees: [
        "The formatter preserves BOM, EOL style, trailing newline, GO separators, and comments.",
      ],
    },
    {
      id: "misc",
      title: "Misc",
      supported: false,
      description: "Legacy Pebloy formatter switches not supported by the current engine are ignored.",
      options: [],
    },
  ],
});

function sanitizeBoolean(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function sanitizeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toUppercaseKeywords(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "upper") return true;
    if (normalized === "lower" || normalized === "preserve") return false;
  }
  return Boolean(value);
}

function normalizeFormatterOptions(rawOptions = {}) {
  const source = rawOptions && typeof rawOptions === "object" ? rawOptions : {};

  const maxLineWidth = source.maxLineWidth ?? source.expressionWidth;
  const statementBreaks = source.statementBreaks ?? source.linesBetweenQueries;
  const uppercaseKeywords = source.uppercaseKeywords ?? source.keywordCase;

  return {
    useTabs: sanitizeBoolean(source.useTabs, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.useTabs),
    tabWidth: sanitizeInteger(source.tabWidth, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.tabWidth, 2, 8),
    maxLineWidth: sanitizeInteger(maxLineWidth, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.maxLineWidth, 0, 999),
    statementBreaks: sanitizeInteger(statementBreaks, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.statementBreaks, 1, 4),
    clauseBreaks: sanitizeInteger(source.clauseBreaks, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.clauseBreaks, 0, 4),
    expandCommaLists: sanitizeBoolean(source.expandCommaLists, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandCommaLists),
    trailingCommas: sanitizeBoolean(source.trailingCommas, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.trailingCommas),
    spaceAfterExpandedComma: sanitizeBoolean(
      source.spaceAfterExpandedComma,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.spaceAfterExpandedComma
    ),
    expandBooleanExpressions: sanitizeBoolean(
      source.expandBooleanExpressions,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandBooleanExpressions
    ),
    expandCaseStatements: sanitizeBoolean(
      source.expandCaseStatements,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandCaseStatements
    ),
    expandBetweenConditions: sanitizeBoolean(
      source.expandBetweenConditions,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandBetweenConditions
    ),
    expandInLists: sanitizeBoolean(source.expandInLists, DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.expandInLists),
    breakJoinOnSections: sanitizeBoolean(
      source.breakJoinOnSections,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.breakJoinOnSections
    ),
    uppercaseKeywords: toUppercaseKeywords(
      uppercaseKeywords,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.uppercaseKeywords
    ),
    keywordStandardization: sanitizeBoolean(
      source.keywordStandardization,
      DEFAULT_INTERACTIVE_FORMATTER_OPTIONS.keywordStandardization
    ),
  };
}

function normalizeFormatterRequest(rawRequest = {}) {
  const source = rawRequest && typeof rawRequest === "object" ? rawRequest : {};
  const requestedDialect = String(source.dialect || DEFAULT_FORMATTER_DIALECT).trim().toLowerCase();
  const rawOptions = source.options && typeof source.options === "object" ? source.options : {};
  const dialect = requestedDialect === DEFAULT_FORMATTER_DIALECT ? requestedDialect : DEFAULT_FORMATTER_DIALECT;

  return {
    dialect,
    mode: String(source.mode || "format").trim().toLowerCase() === "minify" ? "minify" : "format",
    options: normalizeFormatterOptions(rawOptions),
    normalization: {
      appliedDialect: dialect,
      ignoredOptions: Object.keys(rawOptions)
        .filter((key) => !SUPPORTED_FORMATTER_OPTION_IDS.includes(key) && !LEGACY_ALIAS_KEYS.includes(key))
        .sort(),
      requestedDialect,
    },
  };
}

module.exports = {
  DEFAULT_FORMATTER_DIALECT,
  DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
  FORMATTER_CAPABILITIES,
  SUPPORTED_FORMATTER_OPTION_IDS,
  normalizeFormatterOptions,
  normalizeFormatterRequest,
};