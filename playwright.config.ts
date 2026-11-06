import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    env: { CONSENTCRAFT_DATA_NAMESPACE: `e2e-${randomUUID()}`, APP_ORIGIN: "http://127.0.0.1:3100", RATE_LIMIT_MULTIPLIER: "100" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
