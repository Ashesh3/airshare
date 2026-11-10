import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);
// Firefox, WebKit and phone emulation run only where those browsers were installed on purpose: the
// cross-browser CI job, or the e2e runner image. A plain run needs nothing beyond Chromium.
const allBrowsers = process.env.AIRSHARE_E2E_BROWSERS === "all";
const chromium = { name: "chromium", use: { ...devices["Desktop Chrome"] } };

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  outputDir: ".output/results",
  timeout: allBrowsers ? 90_000 : 60_000,
  expect: { timeout: allBrowsers ? 15_000 : 10_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : 4,
  reporter: ci ? [["list"], ["html", { open: "never", outputFolder: ".output/report" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: allBrowsers
    ? [
        chromium,
        // Playwright's Firefox driver sometimes never reports a navigation that did complete (often the fourth tab in one context).
        { name: "linux-firefox", use: { ...devices["Desktop Firefox"] }, retries: 1 },
        { name: "linux-webkit", use: { ...devices["Desktop Safari"] } },
        { name: "iPhone 15 (linux-webkit)", use: { ...devices["iPhone 15"] } },
        { name: "Pixel 8 (chromium)", use: { ...devices["Pixel 8"] } },
      ]
    : [chromium],
});
