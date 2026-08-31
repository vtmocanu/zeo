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
interface BridgeSpace {
  id: string;
  name: string;
  profileId: string;
  createdAt: number;
}
// A profile as returned by the m2 `profiles.create` bridge method. Structurally
// the @zeo/core Profile, redeclared here (like BridgeSpace) so e2e stays
// import-free of @zeo/core; only `id` is load-bearing for the isolation test.
interface BridgeProfile {
  id: string;
  name: string;
  createdAt: number;
}
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
}
interface BridgeState extends BridgeSpacesState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  archived: BridgeTab[];
}
// The serializable context-menu descriptor main returns from showContextMenu.
// Structurally the @zeo/core TabContextMenuResult, redeclared here so e2e stays
// import-free of @zeo/core. `id` is the stable action key we key assertions off.
interface BridgeMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}
interface BridgeMenuResult {
  tabId: string;
  items: BridgeMenuItem[];
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    close(id: string): Promise<void>;
    pin(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    list(): Promise<BridgeState>;
    showContextMenu(id: string, x: number, y: number): Promise<BridgeMenuResult>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    rename(id: string, name: string): Promise<void>;
    delete(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    setProfile(spaceId: string, profileId: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  profiles: {
    create(name: string): Promise<BridgeProfile>;
    rename(id: string, name: string): Promise<void>;
    delete(id: string): Promise<void>;
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
      // ZEO_E2E=1 puts main in headless test mode: showContextMenu still returns
      // its serializable descriptor but skips popping the native menu (which
      // cannot be driven headlessly), so the context-menu IPC is assertable.
      env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
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

  // Case (d'): PRD 2.4 deliverable #4 — the archived-tabs VIEW. Renders an
  // archived tab as a row under the footer toggle and restores it to the open
  // list on title click. Unlike case (d), which asserts on the broadcast payload,
  // this exercises the rendered surface end to end: bridge archive/restore ->
  // main->renderer broadcast -> re-render. All assertions key off stable testids
  // and the archived id (never live page titles), so CI's real navigation of
  // news.ycombinator.com cannot flake them; the web-first expect(...) matchers
  // auto-retry through the broadcast + re-render.
  test("the archived view lists an archived tab and restoring it returns it to the open list", async () => {
    // Fresh launch: exactly one seeded open tab, no archives.
    const openItems = sidebar.getByTestId("tab-item");
    await expect(openItems).toHaveCount(1);

    // Create a dedicated tab and archive it. create() returns the Tab, giving us
    // its stable id directly; the seeded tab stays open.
    const archivedId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const created = await zeo.tabs.create("https://news.ycombinator.com/");
      await zeo.tabs.archive(created.id);
      return created.id;
    });

    // Open the archived panel from the footer toggle.
    await sidebar.getByTestId("archived-toggle").click();

    // The toggle reflects the single archived tab, the panel is visible, and it
    // holds exactly one row — the one for the archived id.
    await expect(sidebar.getByTestId("archived-toggle")).toContainText("Archived (1)");
    await expect(sidebar.getByTestId("archived-view")).toBeVisible();
    await expect(sidebar.getByTestId("archived-item")).toHaveCount(1);
    const archivedRow = sidebar.locator(`[data-archived-id="${archivedId}"]`);
    await expect(archivedRow).toHaveCount(1);

    // Restore via the row's title button. This round-trips through the bridge and
    // the state broadcast; the web-first matchers below poll until it lands.
    await archivedRow.locator(".archived-item__title").click();

    // It left the archived view: the toggle now reads zero and no row remains.
    await expect(sidebar.getByTestId("archived-toggle")).toContainText("Archived (0)");
    await expect(sidebar.locator(`[data-archived-id="${archivedId}"]`)).toHaveCount(0);

    // The panel stays open (restore does not toggle it), so its empty state shows.
    await expect(sidebar.getByTestId("archived-empty")).toBeVisible();

    // And it returned to the open list: seeded + restored = two rows.
    await expect(openItems).toHaveCount(2);

    await expect(
      sidebar.locator(`[data-tab-id="${archivedId}"]`),
    ).toHaveAttribute("aria-current", "true");
  });

  // Case (e): PRD 2.3 pointer-drag reorder. Drives a REAL pointer gesture (not
  // HTML5 DnD, not Locator.dragTo) so the renderer's pointerdown -> 5px-threshold
  // -> pointermove -> pointerup path runs end to end and round-trips through the
  // bridge's reorder + the main->renderer state broadcast + a re-render. We assert
  // only on the stable `data-tab-id` ORDER and the row count — never on rendered
  // titles, which a real page load in CI could change.
  test("dragging a tab past the one below it reorders the rendered list", async () => {
    // Reads the current data-tab-id order from the rendered tab-item rows. This
    // deliberately keys off tab-item only, so the transient drop-indicator /
    // dropzone rows (distinct testids) never enter the order or the count.
    const tabIdOrder = (): Promise<(string | null)[]> =>
      sidebar
        .getByTestId("tab-item")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id")));

    // Fresh launch seeds one unpinned tab; add a second so there are two rows to
    // reorder. create() returns the created Tab, giving us its id directly.
    const seededId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return s.activeTabId ?? s.tabs[0].id;
    });
    const createdId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const created = await zeo.tabs.create("https://news.ycombinator.com/");
      return created.id;
    });

    const items = sidebar.getByTestId("tab-item");
    await expect(items).toHaveCount(2);
    // Initial order: seeded first, created appended after it.
    expect(await tabIdOrder()).toEqual([seededId, createdId]);

    // Grab both rows' geometry. boundingBox() is in the page's CSS pixels, which
    // is the coordinate space Playwright's mouse API drives.
    const box1 = await items.nth(0).boundingBox();
    const box2 = await items.nth(1).boundingBox();
    if (box1 === null || box2 === null) {
      throw new Error("tab-item rows had no bounding box");
    }

    // Press near the LEFT of the first row (x + 20), clear of the × close button
    // on the far right, at its vertical midpoint.
    const startX = box1.x + 20;
    const startY = box1.y + box1.height / 2;

    await sidebar.mouse.move(startX, startY);
    await sidebar.mouse.down();
    // Cross the 5px threshold first: this flips the renderer into drag mode,
    // which reveals the (empty) opposite-section drop zone and thus SHIFTS the
    // rows' on-screen positions. So we must re-read the target row's geometry
    // AFTER the drag has started rather than trusting the pre-drag boundingBox
    // (a human likewise aims at the live, shifted target).
    await sidebar.mouse.move(startX, startY + box1.height, { steps: 6 });
    const boxTargetDuringDrag = await items.nth(1).boundingBox();
    if (boxTargetDuringDrag === null) {
      throw new Error("target row had no bounding box mid-drag");
    }
    // Release just below the second row's midpoint so the computed insertion
    // slot is the end of the unpinned section -> the dragged row moves last.
    await sidebar.mouse.move(
      boxTargetDuringDrag.x + 20,
      boxTargetDuringDrag.y + boxTargetDuringDrag.height * 0.75,
      { steps: 12 },
    );
    await sidebar.mouse.up();

    // The reorder round-trips through the bridge + a main->renderer broadcast +
    // a re-render, so poll rather than assert once.
    await expect
      .poll(async () => tabIdOrder(), {
        message: "expected the pointer drag to reorder the rows to [created, seeded]",
      })
      .toEqual([createdId, seededId]);

    // The drag moved a row; it neither added nor removed one, and the count is of
    // tab-item rows only (any indicator/dropzone is a different testid).
    await expect(items).toHaveCount(2);
  });

  test("right-clicking a tab row returns the expected context-menu descriptor", async () => {
    const id = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return s.activeTabId ?? s.tabs[0].id;
    });

    const lastMenu = (): Promise<BridgeMenuResult | null> =>
      sidebar.evaluate(
        () =>
          (globalThis as unknown as { __zeoLastContextMenu?: BridgeMenuResult })
            .__zeoLastContextMenu ?? null,
      );

    const row = sidebar.getByTestId("tab-item").first();
    await row.click({ button: "right" });
    await expect.poll(lastMenu).not.toBeNull();
    const res = (await lastMenu()) as BridgeMenuResult;

    expect(res.tabId).toBe(id);
    expect(res.items.map((item) => item.id)).toEqual([
      "pin",
      "archive",
      "close",
      "copyUrl",
    ]);
    const byId = new Map(res.items.map((item) => [item.id, item]));
    expect(byId.get("pin")).toMatchObject({ id: "pin", label: "Pin" });
    expect(byId.get("archive")?.enabled).toBe(true);
    expect(byId.get("close")?.enabled).toBe(true);
    expect(byId.get("copyUrl")?.enabled).toBe(true);

    await sidebar.evaluate(async (tabId) => {
      delete (globalThis as unknown as { __zeoLastContextMenu?: BridgeMenuResult })
        .__zeoLastContextMenu;
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.pin(tabId);
    }, id);
    await row.click({ button: "right" });
    await expect
      .poll(async () => (await lastMenu())?.items.map((item) => item.id) ?? null)
      .toEqual(["unpin", "archive", "close", "copyUrl"]);

    const pinnedRes = (await lastMenu()) as BridgeMenuResult;
    expect(pinnedRes.tabId).toBe(id);
    const pinnedById = new Map(pinnedRes.items.map((item) => [item.id, item]));
    expect(pinnedById.get("unpin")).toMatchObject({ id: "unpin", label: "Unpin" });
    expect(pinnedById.has("pin")).toBe(false);
    expect(pinnedById.get("archive")?.enabled).toBe(false);
  });

  test("pointer drag reorders pinned rows and moves tabs across the pin boundary", async () => {
    const sectionOrder = (sectionTestId: string): Promise<(string | null)[]> =>
      sidebar
        .getByTestId(sectionTestId)
        .getByTestId("tab-item")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id")));

    const pinnedOf = (tabId: string): Promise<boolean | null> =>
      sidebar.evaluate(async (target) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const s = await zeo.tabs.list();
        return s.tabs.find((t) => t.id === target)?.pinned ?? null;
      }, tabId);

    const rowBox = async (tabId: string) => {
      const box = await sidebar.locator(`[data-tab-id="${tabId}"]`).boundingBox();
      if (box === null) {
        throw new Error(`row ${tabId} had no bounding box`);
      }
      return box;
    };

    const edgeOf = async (
      tabId: string,
      place: "above" | "below",
    ): Promise<{ x: number; y: number }> => {
      const box = await rowBox(tabId);
      return {
        x: box.x + 20,
        y: box.y + box.height * (place === "above" ? 0.25 : 0.75),
      };
    };

    const tickFrame = () =>
      sidebar.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    const seenY = () =>
      sidebar.evaluate(
        () =>
          (globalThis as { __zeoDrag?: { y: number } }).__zeoDrag?.y ?? null,
      );

    const dragRowOnce = async (
      tabId: string,
      destination: () => Promise<{ x: number; y: number }>,
    ): Promise<boolean> => {
      const box = await rowBox(tabId);
      const startX = box.x + 20;
      const startY = box.y + box.height / 2;
      await sidebar.mouse.move(startX, startY);
      await sidebar.mouse.down();
      await sidebar.mouse.move(startX, startY + box.height, { steps: 6 });
      const dest = await destination();
      await sidebar.mouse.move(dest.x, dest.y, { steps: 12 });
      await tickFrame();
      const settled = await destination();
      let acknowledged = false;
      for (let attempt = 0; attempt < 20 && !acknowledged; attempt += 1) {
        await sidebar.mouse.move(settled.x, settled.y);
        await tickFrame();
        acknowledged = (await seenY()) === settled.y;
      }
      await sidebar.mouse.up();
      return acknowledged;
    };

    const dragRow = async (
      tabId: string,
      destination: () => Promise<{ x: number; y: number }>,
    ): Promise<void> => {
      for (let gesture = 0; gesture < 5; gesture += 1) {
        if (await dragRowOnce(tabId, destination)) {
          return;
        }
        await tickFrame();
      }
      throw new Error(
        `drag gesture for ${tabId} was never acknowledged; renderer saw y=${await seenY()}`,
      );
    };

    const seededId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return s.activeTabId ?? s.tabs[0].id;
    });
    const [bId, cId] = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const b = await zeo.tabs.create("about:blank");
      const c = await zeo.tabs.create("about:blank");
      return [b.id, c.id];
    });
    await sidebar.evaluate(
      async (ids) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        for (const tabId of ids) {
          await zeo.tabs.pin(tabId);
        }
      },
      [seededId, bId],
    );
    await expect
      .poll(() => sectionOrder("pinned-section"))
      .toEqual([seededId, bId]);
    await expect.poll(() => sectionOrder("unpinned-section")).toEqual([cId]);

    await dragRow(seededId, () => edgeOf(bId, "below"));
    await expect
      .poll(() => sectionOrder("pinned-section"), {
        message: "expected the drag to reorder the pinned rows to [b, seeded]",
      })
      .toEqual([bId, seededId]);

    await dragRow(bId, () => edgeOf(cId, "below"));
    await expect
      .poll(() => sectionOrder("unpinned-section"), {
        message: "expected the drag to unpin b and append it after c",
      })
      .toEqual([cId, bId]);
    await expect.poll(() => sectionOrder("pinned-section")).toEqual([seededId]);
    expect(await pinnedOf(bId)).toBe(false);

    await dragRow(cId, () => edgeOf(seededId, "above"));
    await expect
      .poll(() => sectionOrder("pinned-section"), {
        message: "expected the drag to pin c and place it before seeded",
      })
      .toEqual([cId, seededId]);
    await expect.poll(() => sectionOrder("unpinned-section")).toEqual([bId]);
    expect(await pinnedOf(cId)).toBe(true);
  });

  // PRD 3.1 deliverable #4 — the space model end to end, driven entirely over the
  // bridge (there is no space UI yet). Creates a second space, switches into it,
  // creates a tab there, switches back and forth asserting each space shows only
  // its own tabs and restores its own active tab, then deletes the second space
  // and asserts its tabs are gone and the first space is active. All assertions
  // key off ids/counts (never live page titles), and the tab created in the
  // second space loads about:blank, so CI's real navigation cannot flake it. The
  // rendered tab-item count is asserted alongside the bridge state to prove the
  // existing sidebar still renders the active space against the new snapshot shape.
  test("spaces isolate their tabs and switching restores each space's own tabs", async () => {
    const items = sidebar.getByTestId("tab-item");

    // Fresh launch: exactly one space ("Personal") holding the one seeded tab,
    // which is active.
    const initial = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    expect(initial.spaces).toHaveLength(1);
    expect(initial.spaces[0].name).toBe("Personal");
    expect(initial.activeSpaceId).toBe(initial.spaces[0].id);
    expect(initial.tabs).toHaveLength(1);
    const personalId = initial.activeSpaceId;
    const seededTabId = initial.activeTabId;
    expect(seededTabId).not.toBeNull();
    await expect(items).toHaveCount(1);

    // Create a second space. It does NOT steal focus: Personal stays active.
    const work = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.create("Work");
    });
    expect(work.name).toBe("Work");
    const afterCreate = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    expect(afterCreate.spaces.map((s) => s.name)).toEqual(["Personal", "Work"]);
    expect(afterCreate.activeSpaceId).toBe(personalId);
    // Renderer still shows Personal's single tab.
    await expect(items).toHaveCount(1);

    // Switch into Work: it is empty, so no tabs and no active tab.
    const inWork = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
      return zeo.tabs.list();
    }, work.id);
    expect(inWork.activeSpaceId).toBe(work.id);
    expect(inWork.tabs).toHaveLength(0);
    expect(inWork.activeTabId).toBeNull();
    // The sidebar re-rendered to the empty space via the broadcast.
    await expect(items).toHaveCount(0);
    await expect(sidebar.getByTestId("sidebar")).toContainText("No open tabs");

    // Create a tab in Work (about:blank — no network). It becomes Work's active.
    const workTab = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.create("about:blank");
    });
    await expect(items).toHaveCount(1);
    const workState = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    expect(workState.tabs.map((t) => t.id)).toEqual([workTab.id]);
    expect(workState.activeTabId).toBe(workTab.id);

    // Switch back to Personal: it shows ONLY its own seeded tab (Work's tab is
    // absent) and restores its own active tab.
    const backToPersonal = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
      return zeo.tabs.list();
    }, personalId);
    expect(backToPersonal.activeSpaceId).toBe(personalId);
    expect(backToPersonal.tabs.map((t) => t.id)).toEqual([seededTabId]);
    expect(backToPersonal.tabs.map((t) => t.id)).not.toContain(workTab.id);
    expect(backToPersonal.activeTabId).toBe(seededTabId);
    await expect(items).toHaveCount(1);
    await expect(
      sidebar.locator(`[data-tab-id="${seededTabId}"]`),
    ).toHaveAttribute("aria-current", "true");

    // Switch to Work again: its own active tab (workTab) is restored.
    const backToWork = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
      return zeo.tabs.list();
    }, work.id);
    expect(backToWork.tabs.map((t) => t.id)).toEqual([workTab.id]);
    expect(backToWork.activeTabId).toBe(workTab.id);

    // Delete Work while it is active: its tabs vanish and Personal becomes active.
    const afterDelete = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.delete(id);
      return zeo.tabs.list();
    }, work.id);
    expect(afterDelete.spaces.map((s) => s.name)).toEqual(["Personal"]);
    expect(afterDelete.spaces.some((s) => s.id === work.id)).toBe(false);
    expect(afterDelete.activeSpaceId).toBe(personalId);
    expect(afterDelete.tabs.map((t) => t.id)).toEqual([seededTabId]);
    expect(afterDelete.tabs.map((t) => t.id)).not.toContain(workTab.id);
    await expect(items).toHaveCount(1);
  });

  // PRD 3.2 deliverable #4 — per-space session/cookie ISOLATION, end to end.
  //
  // Mechanism: a profile maps to an Electron session partition
  // ("persist:<profile-id>"); every tab's WebContentsView is created with
  // `webPreferences.partition` resolved from its space's profile (see
  // apps/desktop main `createViewFor`). So two spaces on DIFFERENT profiles run
  // their views on different Session objects and cannot see each other's
  // cookies, while two spaces SHARING a profile run on the SAME Session and do.
  //
  // We drive space/profile setup and tab creation over the sidebar bridge (the
  // only window carrying `window.zeo`; tab WebContentsViews have none), then
  // reach the Sessions in the MAIN process via `app.evaluate`. Isolation is
  // proven two ways: (1) partition wiring by IDENTITY — each tab's
  // `webContents.session` is the very `session.fromPartition("persist:"+id)`
  // object its profile maps to; (2) a cookie set on profile A's Session is
  // read back present from A and absent from B.
  //
  // Network-independent by construction: tabs load `data:` URLs (no fetch), and
  // the cookie is keyed to https://zeo.test/ — a URL the app never navigates to
  // or fetches, so `cookies.set`/`cookies.get` on the partition store touch no
  // network. All webContents matching is by a distinct in-URL TOKEN (never a
  // live page title), and the tokens are chosen so none is a substring of
  // another (ZEOISO_ALPHA / ZEOISO_BETA / ZEOISO_GAMMA).
  test("spaces on different profiles isolate cookies; spaces sharing a profile share them", async () => {
    // Distinct data-URL tokens: no token is a substring of another, so a URL
    // `includes(token)` match identifies exactly one tab's view.
    const tokenA = "ZEOISO_ALPHA";
    const tokenB = "ZEOISO_BETA";
    const tokenA2 = "ZEOISO_GAMMA";

    // Set up two profiles and three spaces over the bridge. A and A2 share
    // profile A; B is on profile B. setProfile re-points each space's profile.
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const profA = await zeo.profiles.create("ProfileA");
      const profB = await zeo.profiles.create("ProfileB");
      const spaceA = await zeo.spaces.create("A");
      const spaceB = await zeo.spaces.create("B");
      const spaceA2 = await zeo.spaces.create("A2");
      await zeo.spaces.setProfile(spaceA.id, profA.id);
      await zeo.spaces.setProfile(spaceB.id, profB.id);
      await zeo.spaces.setProfile(spaceA2.id, profA.id);
      return {
        idA: profA.id,
        idB: profB.id,
        spaceA: spaceA.id,
        spaceB: spaceB.id,
        spaceA2: spaceA2.id,
      };
    });
    expect(setup.idA).not.toBe(setup.idB);

    // For each space: activate it, then create a tab loading its distinct data:
    // URL. The view is created on the ACTIVE space's partition, so activation
    // must precede creation. Capture each tab id (they must be three distinct
    // tabs across the three spaces).
    const makeTab = (spaceId: string, token: string): Promise<BridgeTab> =>
      sidebar.evaluate(
        async (args) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.spaces.activate(args.spaceId);
          return zeo.tabs.create("data:text/html," + args.token);
        },
        { spaceId, token },
      );
    const tabA = await makeTab(setup.spaceA, tokenA);
    const tabB = await makeTab(setup.spaceB, tokenB);
    const tabA2 = await makeTab(setup.spaceA2, tokenA2);
    // Three distinct tabs were created, one per space.
    expect(new Set([tabA.id, tabB.id, tabA2.id]).size).toBe(3);

    // Poll (web-first, no fixed sleep) until all three tab WebContentsViews are
    // present in the main process, matched by their in-URL token, before we
    // assert on their sessions.
    await expect
      .poll(
        async () =>
          app.evaluate(({ webContents }, tokens) => {
            const urls = webContents.getAllWebContents().map((wc) => wc.getURL());
            return tokens.filter((t) => urls.some((u) => u.includes(t))).length;
          }, [tokenA, tokenB, tokenA2]),
        { message: "expected all three tab WebContentsViews to have loaded" },
      )
      .toBe(3);

    // In MAIN: assert partition wiring by identity, then set/read a cookie on
    // profile A's Session. Return only serializable booleans; assert outside.
    const result = await app.evaluate(
      async ({ session, webContents }, data) => {
        const all = webContents.getAllWebContents();
        const findByToken = (token: string) =>
          all.find((wc) => wc.getURL().includes(token)) ?? null;
        const wcA = findByToken(data.tokenA);
        const wcB = findByToken(data.tokenB);
        const wcA2 = findByToken(data.tokenA2);

        const sessA = session.fromPartition("persist:" + data.idA);
        const sessB = session.fromPartition("persist:" + data.idB);

        // Cookie keyed to a URL the app never fetches — pure partition store I/O.
        await sessA.cookies.set({ url: "https://zeo.test/", name: "iso", value: "A" });
        const inA = await sessA.cookies.get({ url: "https://zeo.test/" });
        const inB = await sessB.cookies.get({ url: "https://zeo.test/" });
        // Read the cookie back through A2's OWN view session (the Session its
        // view really runs on), not via session.fromPartition again — a
        // behavioral read that a space sharing profile A sees the cookie.
        const inA2 =
          wcA2 !== null ? await wcA2.session.cookies.get({ url: "https://zeo.test/" }) : [];

        return {
          foundA: wcA !== null,
          foundB: wcB !== null,
          foundA2: wcA2 !== null,
          // Each view runs on the Session its profile maps to (identity, not ==).
          aOnPartitionA: wcA !== null && wcA.session === sessA,
          bOnPartitionB: wcB !== null && wcB.session === sessB,
          // A2 shares profile A: its Session IS partition A's Session. That
          // identity is exactly what "spaces sharing a profile share cookies"
          // means — they read/write the same cookie store.
          a2OnPartitionA: wcA2 !== null && wcA2.session === sessA,
          // Cookie visible from A, invisible from B.
          isoInA: inA.some((c) => c.name === "iso" && c.value === "A"),
          isoInB: inB.some((c) => c.name === "iso"),
          isoInA2: inA2.some((c) => c.name === "iso" && c.value === "A"),
        };
      },
      { idA: setup.idA, idB: setup.idB, tokenA, tokenB, tokenA2 },
    );

    // All three tab views were located in main.
    expect(result.foundA).toBe(true);
    expect(result.foundB).toBe(true);
    expect(result.foundA2).toBe(true);

    // Partition wiring (m2 deliverable): A and A2 tabs run on partition A's
    // Session; B tab runs on partition B's Session.
    expect(result.aOnPartitionA).toBe(true);
    expect(result.a2OnPartitionA).toBe(true);
    expect(result.bOnPartitionB).toBe(true);

    // Cookie isolation: the cookie set on partition A is PRESENT when read from
    // A and ABSENT from B — spaces on different profiles do not share cookies.
    expect(result.isoInA).toBe(true);
    expect(result.isoInB).toBe(false);
    // A space SHARING profile A reads the same cookie through its own view's
    // session (PRD 3.2 #4: cookie present in a second space that shares A).
    expect(result.isoInA2).toBe(true);
  });

  // PRD 3.2 — LIVE-VIEW profile migration path (remapSpaceProfile in the desktop
  // main process). The isolation test above only ever calls setProfile on EMPTY
  // spaces, so remapSpaceProfile always takes its empty-tabIds branch: no view is
  // ever captured, destroyed, or recreated. That leaves the highest-risk
  // migration logic untested — capturing the live tab ids on the OLD partition,
  // destroying their WebContentsViews, moving the store's profile reference, and
  // recreating the views on the NEW partition's Session.
  //
  // This test exercises exactly that path: it reassigns the profile of a space
  // that ALREADY has a loaded tab, then asserts the tab's recreated view moved to
  // the destination partition's Session. Before the remap the view must run on the
  // source partition (persist:<from>); after it, on the destination partition
  // (persist:<to>) — the same in-URL token identifies the view across the
  // destroy/recreate because recreation resumes the snapshotted data: URL.
  //
  // Network-independent by construction: the tab loads a `data:` URL (no fetch)
  // and the assertion is by Session IDENTITY only (`wc.session ===
  // session.fromPartition("persist:"+id)`), never a cookie or a live page title.
  // The token ZEOISO_DELTA is not a substring of any other test's token, so a URL
  // `includes(token)` match identifies exactly this space's tab view.
  test("reassigning a profile on a space with a loaded tab migrates the live view to the new partition", async () => {
    const token = "ZEOISO_DELTA";

    // Over the bridge: two profiles (source + destination), a space initially on
    // the SOURCE profile, activate it, then create a tab loading the data: URL.
    // Activation must precede tab creation so the view is created on the active
    // space's (source) partition.
    const setup = await sidebar.evaluate(async (tok) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const profFrom = await zeo.profiles.create("MigrateFrom");
      const profTo = await zeo.profiles.create("MigrateTo");
      const space = await zeo.spaces.create("Migrate");
      await zeo.spaces.setProfile(space.id, profFrom.id);
      await zeo.spaces.activate(space.id);
      const tab = await zeo.tabs.create("data:text/html," + tok);
      return {
        fromId: profFrom.id,
        toId: profTo.id,
        spaceId: space.id,
        tabId: tab.id,
        token: tok,
      };
    }, token);
    expect(setup.fromId).not.toBe(setup.toId);

    // Poll (web-first, no fixed sleep) until the tab's view exists AND runs on the
    // SOURCE partition's Session by identity — proving it STARTED on the old
    // partition, so the upcoming remap has a live view to migrate.
    await expect
      .poll(
        async () =>
          app.evaluate(({ session, webContents }, data) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().includes(data.token));
            return wc !== undefined && wc.session === session.fromPartition("persist:" + data.fromId);
          }, setup),
        { message: "expected the tab view to start on the source profile's partition" },
      )
      .toBe(true);

    // Over the bridge: reassign the space to the DESTINATION profile. This triggers
    // remapSpaceProfile's live path — capture tab ids, destroy views, move the
    // store profile reference, recreate views on the destination partition.
    await sidebar.evaluate(async (data) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.setProfile(data.spaceId, data.toId);
    }, setup);

    // Poll until the view matched by the SAME token exists AND now runs on the
    // DESTINATION partition's Session by identity — proving the recreated view
    // landed on the new partition, not the old one.
    await expect
      .poll(
        async () =>
          app.evaluate(({ session, webContents }, data) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().includes(data.token));
            return wc !== undefined && wc.session === session.fromPartition("persist:" + data.toId);
          }, setup),
        { message: "expected the recreated tab view to run on the destination profile's partition" },
      )
      .toBe(true);
  });
});
