const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:4399", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testMatch: "workflows.spec.js", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", testMatch: "workflows.spec.js", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
    { name: "packaged", testMatch: "desktop.spec.js" },
  ],
  webServer: {
    command: "node scripts/smoke-server.js",
    url: "http://127.0.0.1:4399/api/status",
    reuseExistingServer: false,
    timeout: 30000,
  },
});