import { defineConfig } from "@playwright/test";

process.env.E2E_DISCOVERY_ONLY = "1";
process.env.E2E_RUN_ID = "00000000-0000-4000-8000-000000000001";
process.env.E2E_CLEANUP_MANIFEST_FILE = "e2e-discovery-cleanup-not-used.json";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [
    { name: "auth", testMatch: /auth-rbac\.spec\.ts/ },
    { name: "business", testMatch: /business-kpi-report\.spec\.ts/, dependencies: ["auth"] },
    { name: "storage", testMatch: /storage-lifecycle\.spec\.ts/, dependencies: ["business"] },
    { name: "resource", testMatch: /resource-concurrency\.spec\.ts/, dependencies: ["storage"] },
    { name: "cleanup", testMatch: /cleanup\.spec\.ts/ }
  ],
  reporter: [["line"]]
});
