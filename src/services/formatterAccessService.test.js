const path = require("path");

const {
  LOOPBACK_HOST,
  createFormatterFileAuthority,
  isFormatterSavePath,
  isLoopbackAddress,
  isLoopbackRequest,
} = require("./formatterAccessService");

describe("formatterAccessService", () => {
  it("accepts only loopback addresses for formatter endpoints", () => {
    expect(isLoopbackAddress(LOOPBACK_HOST)).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress(`::ffff:${LOOPBACK_HOST}`)).toBe(true);
    expect(isLoopbackAddress("10.10.0.5")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  });

  it("detects loopback requests from the socket remote address", () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: LOOPBACK_HOST } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "10.10.0.5" } })).toBe(false);
  });

  it("limits formatter overwrite paths to absolute .sql and .txt files", () => {
    expect(isFormatterSavePath(path.resolve("temp", "formatter.sql"))).toBe(true);
    expect(isFormatterSavePath(path.resolve("temp", "formatter.txt"))).toBe(true);
    expect(isFormatterSavePath(path.resolve("temp", "formatter.csv"))).toBe(false);
    expect(isFormatterSavePath("formatter.sql")).toBe(false);
  });

  it("issues per-session file tokens only for eligible formatter files", () => {
    const authority = createFormatterFileAuthority();
    const filePath = path.resolve("temp", "opened.sql");
    const authorized = authority.authorize(filePath);

    expect(authorized).toEqual({
      fileName: "opened.sql",
      filePath,
      fileToken: expect.any(String),
    });
    expect(authority.resolve(authorized.fileToken)).toEqual({
      fileName: "opened.sql",
      filePath,
    });
    expect(authority.authorize(path.resolve("temp", "opened.csv"))).toBeNull();
    expect(authority.resolve("missing-token")).toBeNull();
  });
});