const {
  DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
  formatGeneratedSql,
  formatGeneratedSqlAsync,
  formatInteractiveSql,
  formatSql,
  formatSqlAsync,
} = require("./formatterService");

jest.mock("./appStateService", () => ({
  getAppState: jest.fn(() => ({ ui: { formatter: {} } })),
}));

const { getAppState } = require("./appStateService");

function normalizeForSemantics(sql) {
  // Case- and whitespace-insensitive token view: if this differs, the
  // formatter changed more than layout/casing/punctuation spacing.
  return String(sql)
    .toLowerCase()
    .replace(/\s*([(),.=<>*])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

describe("formatSql — core formatting", () => {
  it("uppercases keywords and indents clauses", () => {
    const out = formatSql("select a,b from t join u on u.id=t.id where a=1");
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM");
    expect(out).toContain("JOIN u ON u.id = t.id");
    expect(out).toContain("WHERE");
  });

  it("preserves GO batch separators including counted GO", () => {
    const input = "select 1\nGO\nselect 2\nGO 5\nselect 3";
    const out = formatSql(input);
    const goLines = out.split(/\r?\n/).filter((l) => /^GO(\s+\d+)?$/i.test(l.trim()));
    expect(goLines).toHaveLength(2);
    expect(out).toMatch(/GO 5/);
  });

  it("preserves comments", () => {
    const input = "-- top comment\nselect a /* inline */ from t\n/* block\ncomment */";
    const out = formatSql(input);
    expect(out).toContain("-- top comment");
    expect(out).toContain("/* inline */");
    expect(out).toContain("comment */");
  });

  it("never alters string literals (dynamic SQL stays byte-identical)", () => {
    const literal = "'select * from x where  weird   spacing'";
    const out = formatSql(`declare @s nvarchar(max) = ${literal}; exec sp_executesql @s`);
    expect(out).toContain(literal);
  });

  it("keeps unparseable batches verbatim instead of corrupting them", () => {
    const garbage = "THIS IS NOT (( SQL @@@ %%%";
    const out = formatSql(`select 1\nGO\n${garbage}`);
    expect(out).toContain(garbage);
    expect(out).toContain("SELECT");
  });

  it("preserves the original unparseable batch whitespace verbatim", () => {
    const garbage = "  THIS IS NOT (( SQL @@@ %%%  ";
    const out = formatSql(`select 1\nGO\n${garbage}`);
    expect(out).toContain(garbage);
  });

  it("is idempotent — formatting twice yields identical output", () => {
    const input = [
      "create procedure dbo.usp_demo @id int as",
      "begin try",
      "  begin tran",
      "  with cte as (select id, row_number() over (order by id) rn from dbo.t)",
      "  merge dbo.target as tgt using cte as src on tgt.id = src.id",
      "  when matched then update set tgt.rn = src.rn",
      "  when not matched then insert (id, rn) values (src.id, src.rn);",
      "  commit tran",
      "end try",
      "begin catch",
      "  rollback tran",
      "end catch",
      "GO",
      "select case when a=1 then 'one' else 'other' end from #tmp",
    ].join("\n");

    const once = formatSql(input);
    const twice = formatSql(once);
    expect(twice).toBe(once);
  });

  it("does not change SQL semantics (token stream is layout/casing-invariant)", () => {
    const input = "select t.a, u.b from dbo.t t inner join dbo.u u on u.id = t.id where t.x in (1,2,3) group by t.a, u.b having count(*) > 1 order by t.a desc";
    const out = formatSql(input);
    expect(normalizeForSemantics(out)).toBe(normalizeForSemantics(input));
  });

  it("preserves CRLF line endings and trailing newline", () => {
    const input = "select 1\r\nGO\r\nselect 2\r\n";
    const out = formatSql(input);
    expect(out.includes("\r\n")).toBe(true);
    expect(out.split("\n").every((l, i, arr) => i === arr.length - 1 || l.endsWith("\r"))).toBe(true);
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("returns empty/whitespace input unchanged", () => {
    expect(formatSql("")).toBe("");
    expect(formatSql("   \n  ")).toBe("   \n  ");
  });
});

describe("formatSql — T-SQL module handling", () => {
  const proc = [
    "-- =============================================",
    "-- Author:      Test",
    "-- Description: header banner must survive",
    "-- =============================================",
    "CREATE PROCEDURE [dbo].[usp_Demo]",
    "    @Id INT,",
    "    @Label NVARCHAR(50) = N'AS'",
    "AS",
    "BEGIN",
    "    SET NOCOUNT ON;",
    "    SELECT @Id AS Id, @Label AS Label;",
    "END",
  ].join("\n");

  it("keeps authored header comments above CREATE", () => {
    const out = formatSql(proc);
    expect(out).toContain("-- Author:      Test");
    expect(out).toContain("-- Description: header banner must survive");
    expect(out.indexOf("-- Author")).toBeLessThan(out.indexOf("CREATE PROCEDURE"));
  });

  it("puts AS and BEGIN on their own lines and indents the body one level", () => {
    const out = formatSql(proc);
    expect(out).toContain("CREATE PROCEDURE [dbo].[usp_Demo] @Id INT");
    expect(out).toContain("\t, @Label NVARCHAR(50) = N'AS'");
    expect(out).toMatch(/\nAS\nBEGIN\n/);
    // Everything between BEGIN and END is pushed one tab in.
    expect(out).toContain("BEGIN\n\tSET NOCOUNT ON;");
    expect(out).toMatch(/\n\tSELECT @Id AS Id\n\t\t, @Label AS Label;/);
    expect(out).toMatch(/\nEND\s*$/);
  });

  it("keeps session SET statements on one line", () => {
    const out = formatSql(proc);
    expect(out).toContain("SET NOCOUNT ON;");
    expect(out).not.toMatch(/\bSET\n\s*NOCOUNT/);
  });

  it("keeps UPDATE ... SET column lists expanded", () => {
    const out = formatSql("update dbo.t set a = 1, b = 2 where id = 3");
    expect(out).toBe("UPDATE dbo.t\nSET a = 1\n\t, b = 2\nWHERE id = 3");
  });

  it("places the CTE terminator directly before WITH instead of after the previous statement", () => {
    const out = formatSql("select 1;\nwith cte as (select a,b,c from dbo.t) select * from cte");
    expect(out).toContain("SELECT 1\n;WITH cte AS");
    expect(out).not.toContain("SELECT 1;\nWITH cte AS");
  });

  it("places the comma directly before each additional CTE name", () => {
    const out = formatSql("with CustomerDocuments as (select a,b from dbo.t), TP_CUSTTXNS as (select c,d from dbo.u) select * from CustomerDocuments");
    expect(out).toContain(";WITH CustomerDocuments AS");
    expect(out).toContain("\n,TP_CUSTTXNS\nAS (");
    expect(out).not.toContain("\n\t, TP_CUSTTXNS");
    expect(out).not.toContain("\n        , TP_CUSTTXNS");
  });

  it("does not prefix the CTE body of a view with a semicolon", () => {
    const out = formatSql("create view dbo.v as with cte as (select a,b from dbo.t), cte2 as (select c,d from dbo.u) select * from cte");
    expect(out).toContain("CREATE VIEW dbo.v\nAS\nWITH cte AS");
    expect(out).toContain("\n,cte2\nAS (");
    expect(out).not.toContain("AS\n;WITH");
  });

  it("does not prefix the CTE body of an inline table-valued function with a semicolon", () => {
    const out = formatSql("create function dbo.fn() returns table as return with cte as (select a,b from dbo.t), cte2 as (select c,d from dbo.u) select * from cte");
    expect(out).toContain("RETURN\nWITH cte AS");
    expect(out).toMatch(/\n,cte2(?:\nAS| AS) \(/);
    expect(out).not.toContain("RETURN\n;WITH");
  });

  it("uses leading commas for expanded select lists", () => {
    const out = formatSql("select a,b,c from dbo.t");
    expect(out).toContain("SELECT a\n\t, b\n\t, c");
    expect(out).not.toContain("SELECT a,");
  });

  it("does not split bracketed identifiers across lines", () => {
    const input = "INSERT INTO HISTORY.ITEMINVENTORY([INVENTORYID], [ITEMCODE], [FACILITYCODE], [HEXTAGID], [SERIALNO], [CUSTOMERID], [LOCATIONID], [SHIPMENTID], [BATCHID], [MFGDATE], [WARRANTYSTARTDATE], [WARRANTYENDDATE], [RMANUMBER], [INVSTATUSDATE], [ITEMTYPE], [ITEMSTATUS], [ITEMID], [CREATEDDATE], [CREATEDUSER], [UPDATEDDATE], [UPDATEDUSER], [TagAgency], [CCN], [Frame24], [Frame25], [Frame26], [Frame27], [TransponderAuditID], [ACTION], ChannelID, ICNID) SELECT 1";
    const out = formatSql(input);
    expect(out).toContain("[ITEMSTATUS]");
    expect(out).not.toMatch(/\[[^\]\n]*\n\s*\]/);
  });

  it("stays idempotent for reflowed modules", () => {
    const once = formatSql(proc);
    expect(formatSql(once)).toBe(once);
  });
});

describe("formatSql — modern syntax the poorsql engine predates", () => {
  it("keeps DROP TABLE IF EXISTS on one line instead of splitting into an IF statement", () => {
    const out = formatSql("DROP TABLE IF EXISTS #Invoice_Details\nDROP TABLE IF EXISTS #sequence_nos");
    expect(out).toContain("DROP TABLE IF EXISTS #Invoice_Details");
    expect(out).toContain("DROP TABLE IF EXISTS #sequence_nos");
    expect(out).not.toMatch(/^\s*IF EXISTS/m);
    expect(formatSql(out)).toBe(out);
  });

  it("handles the whole DROP ... IF EXISTS family, including multi-name lists", () => {
    const out = formatSql("drop procedure if exists dbo.usp_Old;\ndrop table if exists #a, dbo.b;\ndrop index if exists IX_x on dbo.t;");
    expect(out).toContain("DROP PROCEDURE IF EXISTS dbo.usp_Old;");
    expect(out).toMatch(/DROP TABLE IF EXISTS #a\n\s+, dbo\.b;/);
    expect(out).toContain("DROP INDEX IF EXISTS IX_x ON dbo.t;");
  });

  it("keeps CREATE OR ALTER together", () => {
    const out = formatSql("create or alter procedure dbo.p as begin select 1 end");
    expect(out).toContain("CREATE OR ALTER PROCEDURE dbo.p");
    expect(out).toMatch(/BEGIN\n\tSELECT 1\nEND/);
  });

  it("leaves the phrases alone inside string literals", () => {
    const literal = "'DROP TABLE IF EXISTS #x; CREATE OR ALTER VIEW v AS SELECT 1'";
    const out = formatSql(`declare @s nvarchar(max) = ${literal}; exec(@s)`);
    expect(out).toContain(literal);
  });

  it("respects keyword-case preservation when uppercasing is off", async () => {
    const result = await formatInteractiveSql("drop table if exists #tmp", {
      dialect: "tsql",
      options: { uppercaseKeywords: false },
    });
    expect(result.formatted).toBe("drop table if exists #tmp");
  });
});

describe("formatSqlAsync — large scripts", () => {
  it("formats a 50,000+ line multi-batch script without excessive time", async () => {
    const batch = [
      "insert into dbo.audit_log (id, name, payload, created_at)",
      "values (1, 'row', 'x', getdate());",
      "update dbo.counters set value = value + 1 where name = 'audit';",
      "select top 10 * from dbo.audit_log where id > 100 order by id desc;",
    ].join("\n");
    const script = Array.from({ length: 10001 }, () => batch).join("\nGO\n");
    expect(script.split("\n").length).toBeGreaterThan(50000);

    const startedAt = Date.now();
    const out = await formatSqlAsync(script);
    const elapsed = Date.now() - startedAt;

    expect(out).toContain("INSERT INTO");
    expect(out.split(/\r?\n/).filter((l) => l.trim() === "GO")).toHaveLength(10000);
    // Generous ceiling — guards against pathological slowdowns, not micro-perf.
    expect(elapsed).toBeLessThan(120000);
    // eslint-disable-next-line no-console
    console.log(`formatSqlAsync: ${script.split("\n").length} lines in ${elapsed} ms`);
  }, 180000);
});

describe("formatInteractiveSql", () => {
  it("uses the interactive option set without changing generated-sql defaults", async () => {
    const result = await formatInteractiveSql("select getdate() from dbo.Test where a=1 and b=2", {
      dialect: "tsql",
      options: {
        ...DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
        uppercaseKeywords: false,
        commaPosition: "leading",
      },
    });

    expect(result.options.uppercaseKeywords).toBe(false);
    expect(result.normalization).toEqual({
      appliedDialect: "tsql",
      ignoredOptions: ["commaPosition"],
      requestedDialect: "tsql",
    });
    // Keyword casing is preserved when uppercasing is off.
    expect(result.formatted).toContain("select getdate()");
    expect(result.formatted).toContain("from dbo.Test");
    expect(result.formatted).toContain("where a = 1\n\tand b = 2");
  });

  it("preserves BOM, CRLF, GO, and trailing newline through the worker path", async () => {
    const sql = "﻿select 1\r\nGO\r\nselect 2\r\n";
    const result = await formatInteractiveSql(sql, { dialect: "tsql" });

    expect(result.formatted.startsWith("﻿")).toBe(true);
    expect(result.formatted.includes("\r\nGO\r\n")).toBe(true);
    expect(result.formatted.endsWith("\r\n")).toBe(true);
  });
});

describe("formatGeneratedSql", () => {
  it("produces equivalent output through the bounded generated-script worker", async () => {
    const sql = "SELECT N'A  B' AS text;\r\nGO\r\nSELECT 2;\r\n";
    expect(await formatGeneratedSqlAsync(sql)).toBe(formatGeneratedSql(sql));
  });

  it("rejects generated scripts beyond the input budget", async () => {
    await expect(formatGeneratedSqlAsync(" ".repeat(20 * 1024 * 1024 + 1))).rejects.toThrow("exceeds 20 MB");
  });
  it("uses persisted formatter options for generated scripts", () => {
    getAppState.mockReturnValueOnce({
      ui: {
        formatter: {
          options: {
            trailingCommas: true,
            spaceAfterExpandedComma: false,
          },
        },
      },
    });

    const out = formatGeneratedSql("select a,b,c from dbo.t");
    expect(out).toContain("SELECT a,");
    expect(out).toMatch(/\n\s+b,/);
  });
});
