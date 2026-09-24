const path = require("path");

const {
  LOOPBACK_HOST,
  isAuthorizedMutation,
  createFormatterFileAuthority,
  isFormatterSavePath,
  isLoopbackAddress,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isLoopbackRequest,
  isLocalBrowserRequest,
} = require("./formatterAccessService");

describe("formatterAccessService", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH"])("requires a session token for %s", (method) => {
    expect(isAuthorizedMutation({ method, headers: {} }, "session-token")).toBe(false);
    expect(isAuthorizedMutation({ method, headers: { "x-pebloy-token": "other" } }, "session-token")).toBe(false);
    expect(isAuthorizedMutation({ method, headers: { "x-pebloy-token": "session-token" } }, "session-token")).toBe(true);
  });

  it("allows read-only requests without a token", () => {
    expect(isAuthorizedMutation({ method: "GET" }, "session-token")).toBe(true);
  });

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

  it("accepts only loopback Host headers, ignoring the port", () => {
    expect(isLoopbackHostHeader("127.0.0.1:5089")).toBe(true);
    expect(isLoopbackHostHeader("localhost:5089")).toBe(true);
    expect(isLoopbackHostHeader("LOCALHOST")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:5089")).toBe(true);
    expect(isLoopbackHostHeader("evil.example.com:5089")).toBe(false);
    expect(isLoopbackHostHeader("")).toBe(false);
  });

  it("accepts an absent Origin but rejects cross-site origins", () => {
    expect(isLoopbackOriginHeader(undefined)).toBe(true);
    expect(isLoopbackOriginHeader("null")).toBe(false);
    expect(isLoopbackOriginHeader("http://127.0.0.1:5089")).toBe(true);
    expect(isLoopbackOriginHeader("http://localhost:5089")).toBe(true);
    expect(isLoopbackOriginHeader("https://evil.example.com")).toBe(false);
    expect(isLoopbackOriginHeader("not-a-url")).toBe(false);
    expect(isLoopbackOriginHeader("file://localhost")).toBe(false);
  });

  it.each(["null", "http://127.0.0.1:3000", "http://localhost:5089", "https://127.0.0.1:5089"])("rejects a nonmatching browser origin: %s", (origin) => {
    expect(isLocalBrowserRequest({
      socket: { remoteAddress: LOOPBACK_HOST },
      headers: { host: "127.0.0.1:5089", origin },
    })).toBe(false);
  });

  it("accepts a matching browser origin", () => {
    expect(isLocalBrowserRequest({
      socket: { remoteAddress: LOOPBACK_HOST },
      headers: { host: "127.0.0.1:5089", origin: "http://127.0.0.1:5089" },
    })).toBe(true);
  });

  it("requires socket, Host, and Origin to all be loopback", () => {
    const local = { socket: { remoteAddress: LOOPBACK_HOST }, headers: { host: "127.0.0.1:5089" } };
    expect(isLocalBrowserRequest(local)).toBe(true);

    // DNS rebinding: the socket is local but Host still carries the attacker hostname.
    expect(
      isLocalBrowserRequest({
        socket: { remoteAddress: LOOPBACK_HOST },
        headers: { host: "evil.example.com:5089" },
      })
    ).toBe(false);

    expect(
      isLocalBrowserRequest({
        socket: { remoteAddress: LOOPBACK_HOST },
        headers: { host: "127.0.0.1:5089", origin: "https://evil.example.com" },
      })
    ).toBe(false);
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