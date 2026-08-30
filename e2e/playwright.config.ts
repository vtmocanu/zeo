import { defineConfig } from "@playwright/test";

// Electron end-to-end tests. A single Electron app is launched and shared, so
// the suite runs serially with one worker. No `projects` / browser downloads:
// these tests drive the Electron binary directly, not a downloaded browser.
export default defineConfig({
  testDir: "./tests",
  // Electron cold start under xvfb is slow; give each test generous headroom.
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
});
