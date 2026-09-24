jest.mock("./sqlService", () => ({ fetchObjectDefinitionMap: jest.fn() }));

const { fetchObjectDefinitionMap } = require("./sqlService");
const { reconcileObjects } = require("./reconciliationService");

const src = { serverName: "src", databaseName: "srcDb" };
const dst = { serverName: "dst", databaseName: "dstDb" };
const proc = (name, definition) => [`PROCEDURE|dbo|${name}`, { definition }];

beforeEach(() => jest.clearAllMocks());

test("reports what the target holds without claiming a transaction outcome", async () => {
  fetchObjectDefinitionMap
    .mockResolvedValueOnce(new Map([proc("Applied", "CREATE PROCEDURE dbo.Applied AS SELECT 1"),
      proc("Stale", "CREATE PROCEDURE dbo.Stale AS SELECT 2"), proc("Absent", "CREATE PROCEDURE dbo.Absent AS SELECT 3")]))
    .mockResolvedValueOnce(new Map([proc("Applied", "CREATE PROCEDURE dbo.Applied AS SELECT 1\r\n"),
      proc("Stale", "CREATE PROCEDURE dbo.Stale AS SELECT 999")]));

  const result = await reconcileObjects(src, dst, [
    { objectType: "PROCEDURE", schemaName: "dbo", objectName: "Applied" },
    { objectType: "PROCEDURE", schemaName: "dbo", objectName: "Stale" },
    { objectType: "PROCEDURE", schemaName: "dbo", objectName: "Absent" },
    { objectType: "TABLE", schemaName: "dbo", objectName: "Orders" },
  ]);

  expect(result.summary).toMatchObject({ MatchesSource: 1, DiffersFromSource: 1, MissingInTarget: 1, NotComparable: 1 });
  expect(result.details.find((d) => d.objectName === "Orders").note).toContain("Code Diff");
  expect(result.limitation).toContain("cannot prove");
});

test("does not query the databases when nothing is comparable", async () => {
  const result = await reconcileObjects(src, dst, [{ objectType: "TABLE", schemaName: "dbo", objectName: "Orders" }]);
  expect(fetchObjectDefinitionMap).not.toHaveBeenCalled();
  expect(result.summary.NotComparable).toBe(1);
});

test("refuses an empty object list", async () => {
  await expect(reconcileObjects(src, dst, [])).rejects.toThrow("nothing to verify");
});
