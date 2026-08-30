import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout: e2e/tests/app.spec.ts -> repo root is
// two levels up, then into the desktop app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

/**
 * Return the renderer window that hosts the React sidebar.
 *
 * `firstWindow()` cannot be trusted: each tab is a separate WebContentsView
 * (example.com) that may also surface as a window. Poll every open window for
 * the one exposing the sidebar, up to a deadline.
 */
async function sidebarWindow(app: ElectronApplication): Promise<Page> {
  // Ensure at least one window has been created before we start polling.
  await app.firstWindow();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.getByTestId("sidebar").count()) > 0) {
          return w;
        }
      } catch {
        // A tab's WebContentsView can surface as a window and, while it is
        // navigating (example.com loads in CI), its execution context may be
        // momentarily destroyed. Skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

test.describe("zeo desktop app", () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [mainPath],
      // Empty string forces main's production `loadFile` path instead of a
      // dev renderer URL — this is exactly the packaged/CI code path.
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    window = await sidebarWindow(app);
  });

  test.afterAll(async () => {
    await app.close();
  });

  // Both assertions share one app instance. On a CI retry Playwright discards
  // the worker and starts a fresh one, so beforeAll re-runs and the app is
  // relaunched clean (tab count back to 1) — the flow stays deterministic.
  test("shows the seeded tab and adds one via the new-tab button", async () => {
    await expect(window.getByTestId("sidebar")).toBeVisible();

    const items = window.getByTestId("tab-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("example.com");

    await window.getByTestId("new-tab-button").click();
    await expect(items).toHaveCount(2);
  });
});
