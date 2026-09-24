const { splitSqlBatches } = require("./sqlBatchService");

describe("SQL batch boundaries", () => {
  it.each([
    "SELECT N'first\nGO\nlast';",
    "/* outer\n/* nested */\nGO\n*/ SELECT 1;",
    'SELECT [first\nGO\nlast];',
    'SELECT "first\nGO\nlast";',
    "SELECT N'escaped ''\nGO\nquote';",
  ])("preserves GO inside SQL text: %s", (sql) => {
    expect(splitSqlBatches(`${sql}\nGO\nSELECT 2;`)).toEqual([sql, "SELECT 2;"]);
  });

  it("supports repeat counts and trailing comments", () => {
    expect(splitSqlBatches("SELECT 1;\r\nGO 2 -- repeat\r\nSELECT 2;")).toEqual(["SELECT 1;", "SELECT 1;", "SELECT 2;"]);
  });

  it("preserves CRLF within literals", () => {
    expect(splitSqlBatches("SELECT 'first\r\nlast';\r\nGO")).toEqual(["SELECT 'first\r\nlast';"]);
  });

  it.each([0, 1001])("rejects unsafe repeat count %s", (count) => {
    expect(() => splitSqlBatches(`SELECT 1;\nGO ${count}`)).toThrow("repeat count");
  });
});