import { defineConfig } from "@playwright/test";
import { loadE2eTargetContract } from "./src/target-contract";

if (process.env.E2E_DISCOVERY_ONLY) throw new Error("E2E_DISCOVERY_MODE_FORBIDDEN_FOR_APPROVAL_TARGET");
const target = loadE2eTargetContract();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: target.baseUrl,
    ignoreHTTPSErrors: false,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off"
  },
  projects: [
    { name: "auth", testMatch: /auth-rbac\.spec\.ts/ },
    { name: "business", testMatch: /business-kpi-report\.spec\.ts/, dependencies: ["auth"] },
    { name: "storage", testMatch: /storage-lifecycle\.spec\.ts/, dependencies: ["business"] },
    { name: "resource", testMatch: /resource-concurrency\.spec\.ts/, dependencies: ["storage"] },
    { name: "cleanup", testMatch: /cleanup\.spec\.ts/ }
  ],
  reporter: [["line"]]
});
