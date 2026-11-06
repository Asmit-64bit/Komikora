import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
const development = process.env.PLAYWRIGHT_DEV === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  timeout: development ? 120_000 : 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: development ? 120_000 : 20_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node node_modules/next/dist/bin/next ${development ? "dev --turbopack" : "start"} --hostname 127.0.0.1 --port 3100`,
    url: "http://127.0.0.1:3100",
    env: { CONSENTCRAFT_DATA_NAMESPACE: `e2e-${randomUUID()}`, APP_ORIGIN: "http://127.0.0.1:3100", RATE_LIMIT_MULTIPLIER: "100", ...(development ? { CONSENTCRAFT_E2E_DEV: "1" } : {}) },
    reuseExistingServer: false,
    timeout: development ? 180_000 : 120_000,
  },
});
