"use strict";

const { UTF8_BOM, withUtf8Bom } = require("./sqlFileEncoding");

describe("sqlFileEncoding", () => {
  it("writes SQL text as UTF-8 with BOM without replacing accented characters", () => {
    const text = "SELECT N'Detracción - NOTA DE CRÉDITO' AS Description";
    const encoded = withUtf8Bom(text);
    const bytes = Buffer.from(encoded, "utf8");

    expect(encoded).toBe(`${UTF8_BOM}${text}`);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString("utf8")).toContain("Detracción");
    expect(bytes.toString("utf8")).toContain("NOTA DE CRÉDITO");
    expect(bytes.toString("utf8")).not.toContain("Detracci�n");
    expect(bytes.toString("utf8")).not.toContain("NOTA DE CR�DITO");
  });
});