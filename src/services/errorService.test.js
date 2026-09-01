"use strict";

const { buildClientError } = require("./errorService");

describe("errorService", () => {
  it("maps login failures to actionable authentication errors", () => {
    const result = buildClientError(new Error("Login failed. Verify server/database, authentication type, username, and password."));

    expect(result.status).toBe(401);
    expect(result.resolutionSteps).toContain("Verify authentication type, username, and password in the selected connection profile.");
  });

  it("maps timeout failures to connectivity guidance", () => {
    const result = buildClientError(new Error("SQL connection timed out for DEV/ALPHABOS_DEV."));

    expect(result.status).toBe(504);
    expect(result.resolutionSteps).toContain("Verify the SQL Server host is reachable from this machine.");
  });

  it("maps profile misses to not-found responses", () => {
    const result = buildClientError(new Error("Profile not found: dev-profile"));

    expect(result.status).toBe(404);
    expect(result.resolutionSteps).toContain("Refresh the connection list and reselect the source or target profile.");
  });

  it("maps identical source and destination conflicts to conflict responses", () => {
    const result = buildClientError(new Error("Source and destination are identical. Use Backup > Format & Execute in Source when you need to format objects in the same database."));

    expect(result.status).toBe(409);
    expect(result.resolutionSteps).toEqual([
      "Choose different source and target profiles for deployment.",
      "Use Backup > Format & Execute in Source when you need to format objects in the same database.",
    ]);
  });
});