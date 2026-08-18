const {
  DEFAULT_FORMATTER_DIALECT,
  DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
  FORMATTER_CAPABILITIES,
  normalizeFormatterOptions,
  normalizeFormatterRequest,
} = require("./formatterOptions");

describe("formatterOptions", () => {
  it("normalizes formatter requests to the supported T-SQL dialect", () => {
    expect(normalizeFormatterRequest({ dialect: "postgresql" })).toEqual({
      dialect: DEFAULT_FORMATTER_DIALECT,
      mode: "format",
      normalization: {
        appliedDialect: DEFAULT_FORMATTER_DIALECT,
        ignoredOptions: [],
        requestedDialect: "postgresql",
      },
      options: DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
    });
  });

  it("reports ignored unsupported formatter option fields while tolerating legacy aliases", () => {
    expect(
      normalizeFormatterRequest({
        dialect: "tsql",
        options: {
          uppercaseKeywords: false,
          expressionWidth: 120,
          commaPosition: "leading",
          joinLayout: "aligned",
        },
      }).normalization
    ).toEqual({
      appliedDialect: DEFAULT_FORMATTER_DIALECT,
      ignoredOptions: ["commaPosition", "joinLayout"],
      requestedDialect: DEFAULT_FORMATTER_DIALECT,
    });
  });

  it("sanitizes formatter options into deterministic supported values", () => {
    expect(
      normalizeFormatterOptions({
        uppercaseKeywords: false,
        useTabs: 1,
        tabWidth: 99,
        maxLineWidth: 10,
        statementBreaks: 9,
        clauseBreaks: -3,
        expandCommaLists: "yes",
        trailingCommas: 1,
        spaceAfterExpandedComma: false,
        expandBooleanExpressions: 0,
        expandCaseStatements: 1,
        expandBetweenConditions: "",
        expandInLists: true,
        breakJoinOnSections: "x",
        keywordStandardization: 0,
      })
    ).toEqual({
      useTabs: true,
      tabWidth: 8,
      maxLineWidth: 10,
      statementBreaks: 4,
      clauseBreaks: 0,
      expandCommaLists: true,
      trailingCommas: true,
      spaceAfterExpandedComma: false,
      expandBooleanExpressions: false,
      expandCaseStatements: true,
      expandBetweenConditions: false,
      expandInLists: true,
      breakJoinOnSections: true,
      uppercaseKeywords: false,
      keywordStandardization: false,
    });
  });

  it("maps legacy persisted option aliases into the current provider contract", () => {
    expect(
      normalizeFormatterOptions({
        keywordCase: "lower",
        expressionWidth: 120,
        linesBetweenQueries: 3,
      })
    ).toEqual(expect.objectContaining({
      uppercaseKeywords: false,
      maxLineWidth: 120,
      statementBreaks: 3,
    }));
  });

  it("exposes the formatter capability groups expected by the UI", () => {
    const groupIds = FORMATTER_CAPABILITIES.groups.map((group) => group.id);
    expect(groupIds).toEqual([
      "formatting",
      "indentation",
      "commaStyle",
      "keywords",
      "case",
      "boolean",
      "join",
      "output",
      "misc",
    ]);
    expect(FORMATTER_CAPABILITIES.supportedOptionIds).toEqual(Object.keys(DEFAULT_INTERACTIVE_FORMATTER_OPTIONS));
    expect(FORMATTER_CAPABILITIES.groups.find((group) => group.id === "commaStyle")?.options.length).toBeGreaterThan(0);
    expect(FORMATTER_CAPABILITIES.groups.find((group) => group.id === "join")?.options.length).toBe(1);
  });
});