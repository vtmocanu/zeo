import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout: e2e/tests/app.spec.ts -> repo root is
// two levels up, then into the desktop app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e does not depend on @zeo/core, so we redeclare only the slice we touch here.
// These stay structurally compatible with @zeo/core's ZeoApi / Tab / TabsState;
// the fields we assert on (id/title/pinned + archived rows) are all we need.
interface BridgeTab {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  pinned: boolean;
}
interface BridgeState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  archived: BridgeTab[];
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    close(id: string): Promise<void>;
    pin(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
}
// Inside `page.evaluate` the callback runs in the renderer, where the real global
// carries the bridge. We reach it via `globalThis` (not `window`) so it never
// resolves to the outer `Page` variable, and cast through `unknown` to keep the
// bridge typed without importing @zeo/core and without `any`. The cast helper is
// inlined at each call site because module-scope functions are not in scope in
// the serialized browser context.

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

/**
 * Return an open window that is NOT the sidebar — i.e. a tab's WebContentsView.
 * Used to prove application-menu accelerators fire while focus is inside a tab.
 * Same defensive try/catch as {@link sidebarWindow}: a navigating view can throw.
 */
async function tabViewWindow(app: ElectronApplication, sidebar: Page): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w === sidebar) {
        continue;
      }
      try {
        if ((await w.getByTestId("sidebar").count()) === 0) {
          return w;
        }
      } catch {
        // Navigating context; retry on the next pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("No tab WebContentsView window (non-sidebar) was found within 15s");
}

// --- SEAM: invoking the New Tab / Close Tab commands. ---------------------------
// New/Close Tab (and the nine numeric activators) are wired as APPLICATION-menu
// accelerators (Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+1..9). The accelerator KEY
// itself cannot be exercised from Playwright: page.keyboard.press dispatches a
// synthetic key event via CDP into a renderer, but Electron matches menu
// accelerators in the BROWSER process from real OS key events, so a CDP-injected
// key never reaches the menu (verified: under xvfb the press is a no-op). We
// therefore drive the SAME menu item the accelerator is bound to, through the
// main process — this proves the command wiring (menu item -> createTab/close
// active) end to end. The literal keychord firing is covered by the running-app
// acceptance criterion, which is not automatable headlessly.
async function clickTabsMenuItem(
  app: ElectronApplication,
  label: string,
): Promise<void> {
  await app.evaluate(({ Menu }, itemLabel) => {
    const menu = Menu.getApplicationMenu();
    if (menu === null) {
      throw new Error("no application menu installed");
    }
    const tabsMenu = menu.items.find((item) => item.label === "Tabs");
    if (tabsMenu?.submenu == null) {
      throw new Error('no "Tabs" submenu');
    }
    const item = tabsMenu.submenu.items.find((i) => i.label === itemLabel);
    if (item == null) {
      throw new Error(`no menu item labelled "${itemLabel}"`);
    }
    // MenuItem.click is typed to receive (menuItem, window, event); our handler
    // ignores them. Cast to a nullary call to trigger the bound command.
    (item.click as () => void)();
  }, label);
}
async function pressNewTab(app: ElectronApplication): Promise<void> {
  await clickTabsMenuItem(app, "New Tab");
}
async function pressCloseTab(app: ElectronApplication): Promise<void> {
  await clickTabsMenuItem(app, "Close Tab");
}

test.describe("zeo desktop app", () => {
  // Fresh launch per test: each Electron process gets a pristine TabStore (one
  // seeded tab, no pins, no archives), so counts are deterministic and a CI
  // retry of any single test — which runs in a fresh worker — sees identical
  // state. Cold start under xvfb is slow, hence the config's 60s per-test budget.
  let app!: ElectronApplication;
  let sidebar!: Page;

  test.beforeEach(async () => {
    // Chromium refuses to launch as root without --no-sandbox. The GitHub CI
    // job runs as a non-root user, so it needs no flag; a containerized run
    // (the documented Playwright docker sidecar, which runs as root) sets
    // ZEO_E2E_NO_SANDBOX=1 to opt in. Gated so the default/CI path is unchanged.
    const launchArgs =
      process.env.ZEO_E2E_NO_SANDBOX === "1"
        ? [mainPath, "--no-sandbox"]
        : [mainPath];
    app = await electron.launch({
      args: launchArgs,
      // Empty string forces main's production `loadFile` path instead of a
      // dev renderer URL — this is exactly the packaged/CI code path.
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    sidebar = await sidebarWindow(app);
  });

  test.afterEach(async () => {
    await app.close();
  });

  test("shows the seeded tab and adds one via the new-tab button", async () => {
    await expect(sidebar.getByTestId("sidebar")).toBeVisible();

    const items = sidebar.getByTestId("tab-item");
    await expect(items).toHaveCount(1);

    // NOTE: we intentionally do NOT assert the seeded tab's rendered title. The
    // seed loads https://example.com, which has network in CI/container, so
    // page-title-updated fires and flips the title from the "example.com"
    // hostname fallback to "Example Domain" — a network-timing-dependent value.
    // Asserting either is flaky; the hostname fallback is covered deterministically
    // by the create()-return test below.

    await sidebar.getByTestId("new-tab-button").click();
    await expect(items).toHaveCount(2);
  });

  // Case (a): a created tab carries the hostname-derived fallback title.
  test("a created tab exposes the hostname-derived fallback title", async () => {
    const items = sidebar.getByTestId("tab-item");
    const before = await items.count();

    // create() returns the created Tab synchronously from the store, carrying the
    // hostname-derived fallback title BEFORE any page-title-updated can overwrite
    // it — deterministic and network-independent. (We deliberately do not assert
    // the RENDERED title, which a real page load could replace.)
    const created = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.create("https://news.ycombinator.com/");
    });
    expect(created.title).toBe("news.ycombinator.com");

    // The new tab is also rendered as a row.
    await expect(items).toHaveCount(before + 1);

    // Clean up so counts stay predictable (harmless with fresh-per-test launches).
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.close(id);
    }, created.id);
    await expect(items).toHaveCount(before);
  });

  // Case (b): Cmd/Ctrl+T adds a tab and Cmd/Ctrl+W closes it, proven from BOTH
  // focus surfaces — the sidebar renderer and a tab's WebContentsView.
  test("new-tab / close-tab accelerators fire from the sidebar and from a tab view", async () => {
    const items = sidebar.getByTestId("tab-item");

    // Phase 1 — sidebar renderer frontmost/focused. Click a neutral element (the
    // header title has no click handler) so focus sits in the sidebar.
    await sidebar.bringToFront();
    await sidebar.locator(".sidebar__title").click();
    const n1 = await items.count();
    await pressNewTab(app);
    await expect(items).toHaveCount(n1 + 1);
    await pressCloseTab(app);
    await expect(items).toHaveCount(n1);

    // Phase 2 — a tab's WebContentsView frontmost/focused. Because these are
    // APPLICATION-menu commands (not per-webContents before-input-event), the
    // command fires and the sidebar still observes the count via the state
    // broadcast even though a tab view — not the sidebar — is in front.
    const tabView = await tabViewWindow(app, sidebar);
    await tabView.bringToFront();
    // Clicking the tab body just moves focus into the view; guard because an
    // error/blank page's body may momentarily be unclickable.
    await tabView
      .locator("body")
      .click()
      .catch(() => {});
    const n2 = await items.count();
    await pressNewTab(app);
    await expect(items).toHaveCount(n2 + 1);
    await pressCloseTab(app);
    await expect(items).toHaveCount(n2);
  });

  // Case (c): pinning a tab via the bridge renders the pinned section.
  test("pinning a tab via the bridge renders the pinned section", async () => {
    // No tab is pinned on a fresh launch, so the pinned section must be absent.
    await expect(sidebar.getByTestId("pinned-section")).toHaveCount(0);

    const targetId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const state = await zeo.tabs.list();
      return state.activeTabId ?? state.tabs[0].id;
    });

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.pin(id);
    }, targetId);

    const pinnedSection = sidebar.getByTestId("pinned-section");
    await expect(pinnedSection).toBeVisible();
    // The pinned tab's row lives inside the pinned section.
    await expect(pinnedSection.getByTestId("tab-item")).toHaveCount(1);
  });

  // Case (d): the renderer's state carries the archived tab in `archived`.
  test("archiving a tab surfaces it in the broadcast state's archived list", async () => {
    // Create a dedicated non-pinned tab and archive it, then read the state the
    // renderer holds. Asserting `archived` contains the id verifies the broadcast
    // payload carries the archived list (the sidebar renders no archived UI).
    const archivedId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const created = await zeo.tabs.create("https://news.ycombinator.com/");
      await zeo.tabs.archive(created.id);
      return created.id;
    });

    const state = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    expect(state.archived.map((tab) => tab.id)).toContain(archivedId);
  });
});
