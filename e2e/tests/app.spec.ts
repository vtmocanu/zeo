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
// active) end to end. It does NOT, however, observe the accelerator string on the
// menu item, so removing/altering an accelerator binding while leaving the handler
// intact would keep these tests green. The separate "binds the expected
// accelerators" test below closes that gap by asserting the `.accelerator` values.
// The literal keychord FIRING (a real OS keystroke reaching the browser-process
// menu matcher) remains the running-app acceptance criterion, not automatable
// headlessly.
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
    // Guard with optional-chaining: if beforeEach's launch rejected, `app` is
    // undefined and an unguarded close would throw a secondary error masking the
    // real launch failure.
    await app?.close();
  });

  test("shows the seeded tab and adds one via the new-tab button", async () => {
    await expect(sidebar.getByTestId("sidebar")).toBeVisible();

    const items = sidebar.getByTestId("tab-item");
    await expect(items).toHaveCount(1);

    await expect(items.first()).toContainText(/example/i);

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

  // Case (b): the New Tab / Close Tab commands add and close a tab. The commands
  // are invoked through the application menu in the MAIN process (see the SEAM
  // note: real accelerator keychords can't be delivered headlessly), so this
  // path is focus-independent by construction. We still run it twice, once with
  // the sidebar frontmost and once with a tab's WebContentsView frontmost, to
  // document that an application-menu command is not scoped to one webContents
  // (unlike before-input-event) and that the sidebar reflects it either way; the
  // literal keychord firing is a running-app acceptance criterion, not asserted
  // here.
  test("new-tab / close-tab commands add and close a tab, sidebar- and tab-view-frontmost", async () => {
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

    // Phase 2 — a tab's WebContentsView frontmost/focused. The command still runs
    // and the sidebar observes the count via the state broadcast even though a
    // tab view — not the sidebar — is in front.
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

  // Guards the application-menu ACCELERATOR bindings. The command tests above
  // drive `MenuItem.click` directly, so they exercise the handlers but never read
  // the `.accelerator` strings — deleting or changing a binding (e.g. dropping
  // "CmdOrCtrl+T" from New Tab) would leave them green. This test reads the
  // accelerator of every "Tabs" submenu item from the main process and asserts the
  // exact keychords, so a removed/altered binding fails here. (It does not prove
  // the keychord FIRES — that stays the non-headless running-app criterion.)
  test("the Tabs menu binds the expected accelerators", async () => {
    // Collect a plain, serializable { label -> accelerator } map from the "Tabs"
    // submenu in the main process. Skip separators / items without a label.
    const accelerators = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (menu === null) {
        throw new Error("no application menu installed");
      }
      const tabsMenu = menu.items.find((item) => item.label === "Tabs");
      if (tabsMenu?.submenu == null) {
        throw new Error('no "Tabs" submenu');
      }
      const map: Record<string, string | null | undefined> = {};
      for (const item of tabsMenu.submenu.items) {
        if (!item.label) {
          continue;
        }
        map[item.label] = item.accelerator;
      }
      return map;
    });

    expect(accelerators["New Tab"]).toBe("CmdOrCtrl+T");
    expect(accelerators["Close Tab"]).toBe("CmdOrCtrl+W");
    for (let n = 1; n <= 9; n += 1) {
      expect(accelerators[`Activate Tab ${n}`]).toBe(`CmdOrCtrl+${n}`);
    }
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
    // Create a dedicated non-pinned tab and archive it, then read the state via
    // list(). Both list() and the pushed state-change broadcast serialize the
    // same store.snapshot(), so asserting `archived` contains the id verifies the
    // shared payload carries the archived list (the sidebar renders no archived
    // UI, so there is no rendered surface to assert against).
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
