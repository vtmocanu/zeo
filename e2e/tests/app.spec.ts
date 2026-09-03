import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// PRD 4.2 / CodeRabbit 2c — the @zeo/core value imports in this otherwise
// import-free spec. `commandBarBounds` is the exact bounds math main applies to
// the overlay, so the native-bounds assertion checks against the real formula
// (not a magic number) and can never drift from the source of truth. PRD 4.3 §5
// adds `COMMANDS`: the accelerator/menu assertions derive their expectations from
// the registry itself rather than hard-coded literals, so a registry edit that
// changes a shortcut or a command's menu is caught here without touching the test.
import { commandBarBounds, COMMANDS } from "@zeo/core";

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
// The serializable space context-menu descriptor main returns from
// spaces.showContextMenu. Structurally @zeo/core's SpaceContextMenuResult,
// redeclared here (like BridgeMenuResult for tabs) so e2e stays import-free of
// @zeo/core. `id` is the stable action key; `submenu` carries the Profile
// entries (one `checked`) plus a trailing "new-profile" item.
interface BridgeSpaceMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: BridgeSpaceMenuItem[];
}
interface BridgeSpaceMenuResult {
  spaceId: string;
  items: BridgeSpaceMenuItem[];
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    close(id: string): Promise<void>;
    pin(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
    navigate(id: string, url: string): Promise<void>;
    showContextMenu(id: string, x: number, y: number): Promise<BridgeMenuResult>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    rename(id: string, name: string): Promise<void>;
    delete(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    setProfile(spaceId: string, profileId: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
    showContextMenu(id: string, x: number, y: number): Promise<BridgeSpaceMenuResult>;
  };
  profiles: {
    create(name: string): Promise<BridgeProfile>;
    rename(id: string, name: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  // PRD 4.1 + 4.2 command-bar surface. `submit` forwards the raw text to main,
  // which runs `resolveInput` and either navigates the active tab or opens a new
  // one; `state()` is an invoke round trip (never cached) reading the current
  // overlay state back. PRD 4.2 widens the surface into a tab switcher:
  // `setQuery` re-ranks `suggestions` from a fresh catalog, `moveSelection` wraps
  // the highlight, and `accept` performs the selected (or indexed) row's action
  // and closes the bar. Redeclared structurally (like the rest of this bridge) so
  // the bridge types stay decoupled from @zeo/core (the file imports only the
  // pure `commandBarBounds` helper, nothing type-bearing across the IPC seam);
  // `CommandBarStateShape`/`BridgeSuggestion` mirror @zeo/core's widened
  // `CommandBarState` and `Suggestion` union.
  commandBar: {
    open(mode: "navigate" | "new-tab" | "commands"): Promise<void>;
    close(): Promise<void>;
    submit(text: string, mode?: "navigate" | "new-tab" | "commands"): Promise<void>;
    setQuery(text: string): Promise<void>;
    moveSelection(delta: 1 | -1): Promise<void>;
    accept(index?: number, revision?: number): Promise<void>;
    state(): Promise<CommandBarStateShape>;
  };
  // PRD 4.3 — the command registry bridge. `list` returns every registry entry
  // (its CommandDescriptor fields verbatim); `run` dispatches through main's
  // single checked boundary executeCommand and REJECTS for an unknown id or a
  // command disabled in the current context. Redeclared structurally, like the
  // rest of this bridge, mirroring @zeo/core's CommandsApi.
  commands: {
    list(): Promise<
      { id: string; title: string; keywords: string[]; accelerator: string | null; menu: string | null }[]
    >;
    run(id: string): Promise<void>;
  };
}
// PRD 4.2 — one command-bar suggestion row, structurally the @zeo/core
// `Suggestion` union (redeclared import-free like the rest of this file). Row 0
// is always a `navigate`/`search` text action; `tab`/`archived-tab`/`space` are
// catalog matches. The e2e specs key off `kind`, `tabId`, `spaceId`, `title`,
// `url`, `spaceName`, and `name`.
type BridgeSuggestion =
  | { kind: "navigate"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "archived-tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "space"; spaceId: string; name: string }
  // PRD 4.3 — a command match: its CommandId (`id`), title, and accelerator (or
  // null). Mirrors @zeo/core's widened Suggestion union; `id` keys the e2e
  // assertions (e.g. `tab.pin`/`space.delete`).
  | { kind: "command"; id: string; title: string; accelerator: string | null };
// PRD 4.2 — the widened command-bar state main broadcasts. Additive over the
// PRD 4.1 shape (`open`/`mode`/`initialText` are still present, so the existing
// 4.1 tests that read only those still typecheck), gaining `query`, the ranked
// `suggestions`, and the 0-based `selectedIndex` (`-1` for an empty list).
interface CommandBarStateShape {
  open: boolean;
  mode: "navigate" | "new-tab" | "commands";
  initialText: string;
  query: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
  // PRD 4.2 / CodeRabbit 2a — monotonic id of the current suggestion list, echoed
  // by the renderer on a row-click accept so main can reject a stale click.
  revision: number;
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
        // A real tab view is a window that is NEITHER the sidebar NOR the
        // command-bar overlay. The overlay (PRD 4.1) is a separate
        // WebContentsView loading the renderer with `?view=command-bar`; it
        // carries data-testid="command-bar" (not "sidebar"), so the old
        // sidebar-only check would wrongly return it here. Excluding both
        // testids keeps this to an actual page's WebContentsView.
        if (
          (await w.getByTestId("sidebar").count()) === 0 &&
          (await w.getByTestId("command-bar").count()) === 0
        ) {
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

/**
 * Return the renderer window that hosts the command-bar overlay (PRD 4.1).
 *
 * Like {@link sidebarWindow}, `firstWindow()` cannot be trusted: the overlay is
 * one of several WebContentsViews that surface as windows. Poll every open
 * window for the one exposing data-testid="command-bar", up to a deadline. The
 * overlay page always renders (main drives visibility by showing/hiding the
 * hosting view), so its DOM is queryable whether or not the bar is open.
 */
async function commandBarWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.getByTestId("command-bar").count()) > 0) {
          return w;
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution
        // context; skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="command-bar" was found within 15s');
}

/**
 * Read the NATIVE geometry the main process gave the command-bar overlay: the
 * window's content size plus the overlay `WebContentsView`'s own bounds height.
 * Runs in the MAIN process via `app.evaluate` (the renderer cannot read its own
 * hosting view's bounds), locating the overlay among the window's child views by
 * its `?view=command-bar` url. Returns `null` if the window or overlay is not
 * found. Callers compare `overlayHeight` against `commandBarBounds(width, height,
 * rowCount).height` from @zeo/core — the exact math main applies.
 */
async function overlayNativeBounds(
  app: ElectronApplication,
): Promise<{ width: number; height: number; overlayHeight: number } | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win == null) {
      return null;
    }
    const [width, height] = win.getContentSize();
    for (const child of win.contentView.children) {
      const wc = (child as { webContents?: { getURL(): string } }).webContents;
      if (wc != null && wc.getURL().includes("view=command-bar")) {
        return { width, height, overlayHeight: child.getBounds().height };
      }
    }
    return null;
  });
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
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    // Isolate on-disk persistence per test. PRD 3.4 makes every launch load and
    // save a zeo.db in Electron's userData dir, so WITHOUT a per-test userData
    // dir the launches would share one on-disk database and each test would
    // inherit the previous one's spaces/tabs — breaking the "pristine store per
    // launch" assumption above. A fresh temp dir per test restores isolation.
    userDataDir = mkdtempSync(join(tmpdir(), "zeo-e2e-"));
    // Chromium refuses to launch as root without --no-sandbox. The GitHub CI
    // job runs as a non-root user, so it needs no flag; a containerized run
    // (the documented Playwright docker sidecar, which runs as root) sets
    // ZEO_E2E_NO_SANDBOX=1 to opt in. Gated so the default/CI path is unchanged.
    const baseArgs = [mainPath, "--user-data-dir=" + userDataDir];
    const launchArgs =
      process.env.ZEO_E2E_NO_SANDBOX === "1"
        ? [...baseArgs, "--no-sandbox"]
        : baseArgs;
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
    // Remove the per-test userData dir (best-effort; the process has exited so
    // its files are released). force ignores a missing dir if launch failed.
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = undefined;
    }
  });

  test("shows the seeded tab; the new-tab button opens the command bar, and submitting adds a tab", async () => {
    await expect(sidebar.getByTestId("sidebar")).toBeVisible();

    const items = sidebar.getByTestId("tab-item");
    await expect(items).toHaveCount(1);

    await expect(items.first()).toContainText(/example/i);

    // PRD 4.1 — the new-tab button now OPENS THE COMMAND BAR in new-tab mode
    // instead of creating a tab directly; a tab is created only on submit.
    await sidebar.getByTestId("new-tab-button").click();
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return { open: st.open, mode: st.mode };
        }),
      )
      .toEqual({ open: true, mode: "new-tab" });
    // Opening the bar alone did not create a tab.
    await expect(items).toHaveCount(1);

    // Submitting through the bar creates and renders the tab.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("example.org");
    });
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

  // Case (b): the New Tab / Close Tab commands, invoked through the application
  // menu in the MAIN process (see the SEAM note: real accelerator keychords can't
  // be delivered headlessly), are focus-independent by construction. PRD 4.1
  // changes New Tab: it now OPENS THE COMMAND BAR in new-tab mode rather than
  // creating a tab directly — a tab is created only when the bar is submitted.
  // Close Tab still closes the active tab directly. We run it twice, once with the
  // sidebar frontmost and once with a tab's WebContentsView frontmost, to document
  // that an application-menu command is not scoped to one webContents (unlike
  // before-input-event) and that the sidebar reflects it either way; the literal
  // keychord firing is a running-app acceptance criterion, not asserted here.
  test("new-tab command opens the bar and submit adds a tab; close-tab closes it, sidebar- and tab-view-frontmost", async () => {
    const items = sidebar.getByTestId("tab-item");

    // Drives the New Tab menu command, asserts it opened the command bar (no tab
    // yet, focus-independent), submits to create the tab, then closes it with the
    // Close Tab menu command — the shared body of both focus phases.
    const runPhase = async (n: number): Promise<void> => {
      await pressNewTab(app);
      await expect
        .poll(async () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            return (await zeo.commandBar.state()).open;
          }),
        )
        .toBe(true);
      // Opening the bar alone created no tab.
      await expect(items).toHaveCount(n);
      // Submitting through the bar creates the tab (and closes the bar).
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.submit("example.org");
      });
      await expect(items).toHaveCount(n + 1);
      // Close Tab closes the now-active new tab directly.
      await pressCloseTab(app);
      await expect(items).toHaveCount(n);
    };

    // Phase 1 — sidebar renderer frontmost/focused. Click a neutral element (the
    // header title has no click handler) so focus sits in the sidebar.
    await sidebar.bringToFront();
    await sidebar.locator(".sidebar__title").click();
    await runPhase(await items.count());

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
    await runPhase(await items.count());
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

    // PRD 4.3 §5 — the Tabs submenu is generated from COMMANDS, so the registry
    // is the source of truth. Every NON-SHARED tabs command is keyed by its title
    // to its exact accelerator, so a regression that swapped two bindings (e.g.
    // Archive Tab <-> Copy URL) fails here rather than passing a presence-only
    // check. The pin/unpin pair shares CmdOrCtrl+Shift+P and collapses to a
    // SINGLE item (menuEntries) whose label follows the enabled member, so only
    // its PRESENCE is asserted here (the single-item + label invariant is covered
    // by the dedicated Cmd+Shift+P test below).
    const tabsCommands = COMMANDS.filter(
      (c) =>
        c.menu === "tabs" &&
        c.accelerator !== null &&
        c.id !== "tab.pin" &&
        c.id !== "tab.unpin",
    );
    // Anchor the loop so an empty filter (e.g. a registry edit dropping every
    // keyed tabs command) fails here rather than asserting nothing.
    expect(tabsCommands.length).toBeGreaterThan(0);
    for (const command of tabsCommands) {
      expect(accelerators[command.title]).toBe(command.accelerator);
    }
    expect(Object.values(accelerators)).toContain("CmdOrCtrl+Shift+P");

    // Explicit spot-checks: New Tab opens the bar in new-tab mode; Close Tab
    // closes the active tab directly; and Open Location is NO LONGER a Tabs item —
    // PRD 4.3 moved it to the View menu.
    expect(accelerators["New Tab"]).toBe("CmdOrCtrl+T");
    expect(accelerators["Close Tab"]).toBe("CmdOrCtrl+W");
    expect(accelerators["Open Location"]).toBeUndefined();

    for (let n = 1; n <= 9; n += 1) {
      expect(accelerators[`Activate Tab ${n}`]).toBe(`CmdOrCtrl+Alt+${n}`);
    }
  });

  // PRD 4.3 §5 — the NEW "View" application-menu submenu binds its registry
  // accelerators. Generated from COMMANDS filtered by menu==="view" (Reload Page
  // CmdOrCtrl+R, Go Back CmdOrCtrl+[, Go Forward CmdOrCtrl+], Open Location
  // CmdOrCtrl+L), so — like the Tabs test — we read the `.accelerator` strings
  // from the main process and derive the expectations from the registry. None of
  // the View commands shares an accelerator, so each is keyed by its title.
  test("the View menu binds the expected accelerators", async () => {
    const accelerators = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (menu === null) {
        throw new Error("no application menu installed");
      }
      const viewMenu = menu.items.find((item) => item.label === "View");
      if (viewMenu?.submenu == null) {
        throw new Error('no "View" submenu');
      }
      const map: Record<string, string | null | undefined> = {};
      for (const item of viewMenu.submenu.items) {
        if (!item.label) {
          continue;
        }
        map[item.label] = item.accelerator;
      }
      return map;
    });

    const viewCommands = COMMANDS.filter((c) => c.menu === "view");
    // Anchor the loop so an empty filter cannot pass vacuously — the View loop
    // has no explicit spot-checks after it, unlike the Tabs test.
    expect(viewCommands.length).toBeGreaterThan(0);
    for (const command of viewCommands) {
      // Each registry View command must actually appear in the native View menu
      // (guards e.g. blocking.toggle being reachable from the menu per PRD 5.1
      // §4); without this a null-accelerator command absent from the menu would
      // pass the accelerator check vacuously (undefined === undefined).
      expect(command.title in accelerators).toBe(true);
      // A command with no accelerator surfaces as `null` on the native MenuItem
      // and as `null` in the registry; normalize both to `undefined` so a
      // no-accelerator View command (e.g. blocking.toggle) matches, while
      // accelerator-bearing commands still compare their exact string.
      expect(accelerators[command.title] ?? undefined).toBe(command.accelerator ?? undefined);
    }
  });

  // PRD 3.3 — the NEW "Spaces" application-menu submenu binds its accelerators.
  // Mirrors the "Tabs" accelerator test: reads the `.accelerator` strings from the
  // main process so a removed/altered binding fails here (the numeric activators
  // now own the plain CmdOrCtrl+N chord; New Space is CmdOrCtrl+Shift+N).
  test("the Spaces menu binds the expected accelerators", async () => {
    const accelerators = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (menu === null) {
        throw new Error("no application menu installed");
      }
      const spacesMenu = menu.items.find((item) => item.label === "Spaces");
      if (spacesMenu?.submenu == null) {
        throw new Error('no "Spaces" submenu');
      }
      const map: Record<string, string | null | undefined> = {};
      for (const item of spacesMenu.submenu.items) {
        if (!item.label) {
          continue;
        }
        map[item.label] = item.accelerator;
      }
      return map;
    });

    // PRD 4.3 §5 — derive New Space's accelerator from the registry rather than a
    // literal. space.rename / space.delete have null accelerators (nothing to
    // assert); only New Space carries one in the Spaces menu.
    const newSpace = COMMANDS.find((c) => c.id === "space.new");
    expect(newSpace?.accelerator).toBe("CmdOrCtrl+Shift+N");
    expect(accelerators["New Space"]).toBe(newSpace?.accelerator);
    for (let n = 1; n <= 9; n += 1) {
      expect(accelerators[`Activate Space ${n}`]).toBe(`CmdOrCtrl+${n}`);
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

    const liveToken = "ZEOISO_FOXTROT";
    await app.evaluate(async ({ webContents }, data) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes(data.token));
      if (wc === undefined) {
        throw new Error("live view for the migration tab not found");
      }
      await wc.loadURL("data:text/html," + data.liveToken);
    }, { ...setup, liveToken });

    // Over the bridge: reassign the space to the DESTINATION profile. This triggers
    // remapSpaceProfile's live path — capture tab ids, destroy views, move the
    // store profile reference, recreate views on the destination partition.
    await sidebar.evaluate(async (data) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.setProfile(data.spaceId, data.toId);
    }, setup);

    await expect
      .poll(
        async () =>
          app.evaluate(({ session, webContents }, data) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().includes(data.liveToken));
            return wc !== undefined && wc.session === session.fromPartition("persist:" + data.toId);
          }, { ...setup, liveToken }),
        { message: "expected the recreated tab view on the destination partition at the navigated URL" },
      )
      .toBe(true);

    const staleViewExists = await app.evaluate(({ webContents }, data) => {
      return webContents.getAllWebContents().some((w) => w.getURL().includes(data.token));
    }, setup);
    expect(staleViewExists).toBe(false);
  });

  test("deleting a profile clears its partition's stored data", async () => {
    const prof = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.profiles.create("Doomed");
    });

    const cookiesBefore = await app.evaluate(async ({ session }, id) => {
      const sess = session.fromPartition("persist:" + id);
      await sess.cookies.set({ url: "https://zeo-doomed.test/", name: "zeo_doom", value: "1" });
      const got = await sess.cookies.get({ name: "zeo_doom" });
      return got.length;
    }, prof.id);
    expect(cookiesBefore).toBe(1);

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.profiles.delete(id);
    }, prof.id);

    await expect
      .poll(
        async () =>
          app.evaluate(async ({ session }, id) => {
            const sess = session.fromPartition("persist:" + id);
            const got = await sess.cookies.get({ name: "zeo_doom" });
            return got.length;
          }, prof.id),
        { message: "expected the deleted profile's partition cookies to be cleared" },
      )
      .toBe(0);
  });

  // PRD 3.3 deliverable — the switcher strip renders every space and marks the
  // active one with aria-current. Fresh launch shows the single seeded "Personal"
  // space (active); creating a second space over the bridge (which does NOT steal
  // focus) renders a second strip item while Personal keeps aria-current. Keys off
  // testids / data-space-id / names only, so no network navigation can flake it.
  test("the switcher renders all spaces and highlights the active one", async () => {
    const spaceItems = sidebar.getByTestId("space-item");

    // Fresh launch: exactly one strip item, "Personal", active.
    await expect(spaceItems).toHaveCount(1);
    await expect(spaceItems.first()).toHaveText("Personal");
    await expect(spaceItems.first()).toHaveAttribute("aria-current", "true");

    const personalId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.spaces.list()).activeSpaceId;
    });

    // Create a second space over the bridge; Personal stays active.
    const work = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.create("Work");
    });

    // Both spaces now render, in creation order, and only Personal is current.
    await expect(spaceItems).toHaveCount(2);
    await expect(spaceItems).toHaveText(["Personal", "Work"]);
    await expect(
      sidebar.locator(`[data-space-id="${personalId}"]`),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      sidebar.locator(`[data-space-id="${work.id}"]`),
    ).not.toHaveAttribute("aria-current", "true");
  });

  // PRD 3.3 deliverable — clicking a switcher item activates that space and swaps
  // the rendered tab list to that space's own tabs. We seed a tab into "Work" over
  // the bridge, then drive the switch through the UI (click the strip item, located
  // by data-space-id) and assert the tab-item order and aria-current follow. All
  // assertions key off ids (never live titles); Work's tab loads about:blank.
  test("clicking a space item switches the visible tab list", async () => {
    const tabIds = (): Promise<(string | null)[]> =>
      sidebar
        .getByTestId("tab-item")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id")));

    // Fresh launch: Personal is active with its single seeded tab.
    const initial = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    const personalId = initial.activeSpaceId;
    const seededTabId = initial.activeTabId;
    expect(seededTabId).not.toBeNull();

    // Over the bridge: create Work, activate it, seed one tab into it.
    const workTab = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const work = await zeo.spaces.create("Work");
      await zeo.spaces.activate(work.id);
      const tab = await zeo.tabs.create("about:blank");
      return { spaceId: work.id, tabId: tab.id };
    });

    // Work is active and shows only its own tab.
    await expect.poll(tabIds).toEqual([workTab.tabId]);
    await expect(
      sidebar.locator(`[data-space-id="${workTab.spaceId}"]`),
    ).toHaveAttribute("aria-current", "true");

    // Click the Personal strip item (round-trips: click -> bridge activate ->
    // broadcast -> re-render). The tab list becomes Personal's seeded tab, and
    // aria-current follows the click.
    await sidebar.locator(`[data-space-id="${personalId}"]`).click();
    await expect.poll(tabIds).toEqual([seededTabId]);
    await expect(
      sidebar.locator(`[data-space-id="${personalId}"]`),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      sidebar.locator(`[data-space-id="${workTab.spaceId}"]`),
    ).not.toHaveAttribute("aria-current", "true");

    // Click Work again: the list swaps back to Work's tab.
    await sidebar.locator(`[data-space-id="${workTab.spaceId}"]`).click();
    await expect.poll(tabIds).toEqual([workTab.tabId]);
    await expect(
      sidebar.locator(`[data-space-id="${workTab.spaceId}"]`),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      sidebar.locator(`[data-space-id="${personalId}"]`),
    ).not.toHaveAttribute("aria-current", "true");
  });

  // PRD 3.3 deliverable — the inline "+" create flow. Clicking new-space-button
  // opens the shared inline input prefilled with the default name ("Space 2" when
  // only "Personal" exists); committing on Enter creates the space AND activates it
  // (unlike the bridge `create`, which does not steal focus). Assert both the strip
  // (aria-current) and the store (activeSpaceId) reflect the new space.
  test("creating a space via the + button activates it", async () => {
    const spaceItems = sidebar.getByTestId("space-item");
    await expect(spaceItems).toHaveCount(1);

    // Open the inline create input; it prefills the next default name.
    await sidebar.getByTestId("new-space-button").click();
    const input = sidebar.getByTestId("space-name-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Space 2");

    // Commit on Enter.
    await input.press("Enter");

    // A second strip item "Space 2" appears and becomes active.
    await expect(spaceItems).toHaveCount(2);
    await expect(spaceItems).toHaveText(["Personal", "Space 2"]);
    const created = sidebar.locator(`[data-space-id]`).filter({ hasText: "Space 2" });
    await expect(created).toHaveAttribute("aria-current", "true");

    // The store agrees: the active space is the newly created "Space 2".
    const list = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    const active = list.spaces.find((s) => s.id === list.activeSpaceId);
    expect(active?.name).toBe("Space 2");
  });

  // PRD 3.3 deliverable — inline rename via double-click. Double-clicking a strip
  // item opens the shared inline input prefilled with the live name; committing on
  // Enter renames the space and the strip reflects the STORE after commit. Keys off
  // testids / names only.
  test("renaming a space via double-click updates the strip", async () => {
    const spaceItems = sidebar.getByTestId("space-item");
    const personalId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.spaces.list()).activeSpaceId;
    });

    // Double-click the "Personal" item to open its inline rename input.
    await sidebar.locator(`[data-space-id="${personalId}"]`).dblclick();
    const input = sidebar.getByTestId("space-name-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Personal");

    // Select-all + replace, then commit on Enter.
    await input.fill("Renamed");
    await input.press("Enter");

    // The strip reflects the committed store name.
    await expect(spaceItems).toHaveCount(1);
    await expect(spaceItems.first()).toHaveText("Renamed");
    const renamed = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const list = await zeo.spaces.list();
      return list.spaces.find((s) => s.id === id)?.name ?? null;
    }, personalId);
    expect(renamed).toBe("Renamed");
  });

  // PRD 3.3 deliverable — deleting a space falls back to another. The switcher has
  // no delete button (deletion is via the native menu, not headlessly poppable), so
  // — like the 3.1 test — we drive delete over the bridge and assert the strip and
  // active-space fallback. Create + activate an empty "Work", delete it, and the
  // strip drops back to the single active "Personal".
  test("deleting an empty space falls back to another", async () => {
    const spaceItems = sidebar.getByTestId("space-item");

    const ids = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const before = await zeo.spaces.list();
      const work = await zeo.spaces.create("Work");
      await zeo.spaces.activate(work.id);
      return { personalId: before.activeSpaceId, workId: work.id };
    });
    await expect(spaceItems).toHaveCount(2);

    // Delete Work over the bridge while it is active.
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.delete(id);
    }, ids.workId);

    // The strip drops to a single "Personal" item, and it is active.
    await expect(spaceItems).toHaveCount(1);
    await expect(spaceItems.first()).toHaveText("Personal");
    await expect(
      sidebar.locator(`[data-space-id="${ids.personalId}"]`),
    ).toHaveAttribute("aria-current", "true");
    const afterDelete = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    expect(afterDelete.activeSpaceId).toBe(ids.personalId);
  });

  // PRD 3.3 deliverable — the space context-menu descriptor. Covers three shapes:
  // (1) the LAST remaining space omits "delete" (read over the bridge to avoid
  //     depending on a right-click when only one space exists);
  // (2) a deletable space right-clicked in the UI stashes {rename,delete,profile}
  //     on globalThis.__zeoLastSpaceContextMenu, with a Profile submenu carrying a
  //     checked current-profile entry and a trailing "New profile…" item;
  // (3) a space WITH tabs labels delete "Delete (N tabs)".
  // All assertions key off stable ids/labels (never live titles).
  test("right-clicking a space returns the expected context-menu descriptor", async () => {
    // (1) Fresh launch: a single "Personal" space is the LAST space, so its
    // descriptor (read over the bridge) has NO "delete" item.
    const personalId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.spaces.list()).activeSpaceId;
    });
    const lastSpaceDescriptor = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.showContextMenu(id, 0, 0);
    }, personalId);
    expect(lastSpaceDescriptor.spaceId).toBe(personalId);
    expect(lastSpaceDescriptor.items.some((i) => i.id === "delete")).toBe(false);
    // Rename and Profile are always present.
    expect(lastSpaceDescriptor.items.map((i) => i.id)).toEqual(["rename", "profile"]);

    // (2) Create a second space so Personal becomes DELETABLE, then right-click it
    // in the UI and assert the stashed descriptor.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.create("Work");
    });
    await expect(sidebar.getByTestId("space-item")).toHaveCount(2);

    const lastSpaceMenu = (): Promise<BridgeSpaceMenuResult | null> =>
      sidebar.evaluate(
        () =>
          (
            globalThis as unknown as {
              __zeoLastSpaceContextMenu?: BridgeSpaceMenuResult;
            }
          ).__zeoLastSpaceContextMenu ?? null,
      );

    await sidebar.locator(`[data-space-id="${personalId}"]`).click({ button: "right" });
    await expect.poll(lastSpaceMenu).not.toBeNull();
    const res = (await lastSpaceMenu()) as BridgeSpaceMenuResult;

    expect(res.spaceId).toBe(personalId);
    expect(res.items.map((i) => i.id)).toEqual(["rename", "delete", "profile"]);

    // The Profile submenu carries a checked current-profile entry and a trailing
    // "New profile…" item ending in the U+2026 ellipsis.
    const profileItem = res.items.find((i) => i.id === "profile");
    const submenu = profileItem?.submenu ?? [];
    const checked = submenu.filter((i) => i.checked === true);
    expect(checked).toHaveLength(1);
    expect(checked[0].id.startsWith("profile:")).toBe(true);
    const trailing = submenu[submenu.length - 1];
    expect(trailing.id).toBe("new-profile");
    expect(trailing.label).toBe("New profile…");
    expect(trailing.label.endsWith("…")).toBe(true);

    // (3) A space WITH tabs: activate the second space, seed a tab into it, then
    // read its descriptor over the bridge — delete is labelled "Delete (N tabs)".
    const withTabsDescriptor = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const list = await zeo.spaces.list();
      const work = list.spaces.find((s) => s.name === "Work");
      if (work === undefined) {
        throw new Error("expected a Work space");
      }
      await zeo.spaces.activate(work.id);
      await zeo.tabs.create("about:blank");
      return zeo.spaces.showContextMenu(work.id, 0, 0);
    });
    const deleteItem = withTabsDescriptor.items.find((i) => i.id === "delete");
    expect(deleteItem).toBeDefined();
    expect(deleteItem?.label).toMatch(/^Delete \(\d+ tabs?\)$/);
  });

  // --- PRD 4.1 — command bar shell and URL entry (deliverable §5). ---------------
  // All of these drive the command bar over the sidebar bridge (`window.zeo`) and
  // assert on the BROADCAST STATE — the stored url in `tabs.list()` and the
  // `commandBar.state()` payload — which `submit`/`navigate` mutate synchronously
  // in main before resolving, so they are network-INDEPENDENT: a real page load in
  // the CI sidecar can only canonicalize the url (e.g. add a trailing slash), which
  // the substring/regex assertions tolerate. The two exceptions (overlay input
  // prefill, in-tab navigation) explicitly need a page's DOM/location and say so.

  // §5 bullet 1 — navigate mode opens prefilled with the active tab's url; typing a
  // url and submitting navigates the active tab and closes the bar (no new tab).
  test("command bar opens in navigate mode prefilled with the active tab's url and submitting navigates it", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    expect(before.tabs).toHaveLength(1);
    const activeId = before.activeTabId;
    expect(activeId).not.toBeNull();

    // Open in navigate mode. Main seeds initialText with the active tab's url.
    const opened = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("navigate");
      return zeo.commandBar.state();
    });
    expect(opened.open).toBe(true);
    expect(opened.mode).toBe("navigate");
    expect(opened.initialText).toMatch(/example\.com/);

    // The overlay page's input reflects the seeded url — proves the overlay's DOM
    // is queryable and the renderer applied the pushed state. Web-first matcher
    // auto-retries through the state push + re-render.
    const overlay = await commandBarWindow(app);
    await expect(overlay.getByTestId("command-bar-input")).toHaveValue(/example\.com/);

    // Submit a bare host: resolveInput makes it https://example.org/. The active
    // tab's stored url follows, no tab is added, and the bar closes.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("example.org");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const s = await zeo.tabs.list();
          return s.tabs.find((t) => t.id === id)?.url ?? null;
        }, activeId),
      )
      .toMatch(/example\.org/);

    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      const st = await zeo.commandBar.state();
      return { count: s.tabs.length, active: s.activeTabId, open: st.open };
    });
    expect(after.count).toBe(1);
    expect(after.active).toBe(activeId);
    expect(after.open).toBe(false);
  });

  // §5 bullet 2 — new-tab mode creates a tab ONLY on submit; opening alone does not.
  test("command bar in new-tab mode creates a tab only on submit", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    const beforeCount = before.tabs.length;

    // Opening the bar in new-tab mode must NOT create a tab.
    const afterOpen = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      const st = await zeo.commandBar.state();
      const s = await zeo.tabs.list();
      return { open: st.open, mode: st.mode, count: s.tabs.length };
    });
    expect(afterOpen.open).toBe(true);
    expect(afterOpen.mode).toBe("new-tab");
    expect(afterOpen.count).toBe(beforeCount);

    // Submitting (bar open, new-tab mode) creates and activates a new tab.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("example.org");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.tabs.list()).tabs.length;
        }),
      )
      .toBe(beforeCount + 1);

    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      const st = await zeo.commandBar.state();
      return {
        active: s.tabs.find((t) => t.id === s.activeTabId) ?? null,
        open: st.open,
      };
    });
    expect(after.active).not.toBeNull();
    expect(after.active?.url).toMatch(/example\.org/);
    expect(after.open).toBe(false);
  });

  // Regression (issue #72) — re-seed on mode change while the bar stays OPEN.
  // Opening navigate (Cmd+L) then new-tab (Cmd+T) without closing must clear the
  // seeded navigate url from the input; otherwise Enter would create a tab for the
  // stale url instead of an empty new-tab entry. Asserts the renderer re-seeds when
  // an already-open bar's mode changes, not only on a closed→open transition.
  test("switching an open navigate bar to new-tab mode clears the seeded url", async () => {
    // Open in navigate mode: main seeds initialText with the active tab's url.
    const opened = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("navigate");
      return zeo.commandBar.state();
    });
    expect(opened.open).toBe(true);
    expect(opened.mode).toBe("navigate");

    // The overlay input reflects the seeded url (mirrors the navigate test's regex).
    const overlay = await commandBarWindow(app);
    await expect(overlay.getByTestId("command-bar-input")).toHaveValue(/example\.com/);

    // WITHOUT closing, switch to new-tab mode. Main pushes fresh state with an
    // empty initialText while the bar stays open.
    const switched = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      return zeo.commandBar.state();
    });
    expect(switched.open).toBe(true);
    expect(switched.mode).toBe("new-tab");

    // The input must re-seed to empty on the mode change (web-first matcher retries
    // through the state push + re-render). This is the assertion the fix enables.
    await expect(overlay.getByTestId("command-bar-input")).toHaveValue("");

    // Hygiene: leave the bar closed like the neighbouring tests do.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 3 — a bare word is a search: the active tab lands on the default
  // engine's query url carrying the percent-encoded term. Submit + read in ONE
  // evaluate so the synchronously-stored resolved url is captured before any
  // did-navigate could rewrite it — fully network-independent.
  test("submitting a bare word searches the default engine", async () => {
    const url = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("hello world", "navigate");
      const s = await zeo.tabs.list();
      return s.tabs.find((t) => t.id === s.activeTabId)?.url ?? "";
    });
    // resolveInput uses encodeURIComponent, so a space becomes %20.
    expect(url.startsWith("https://duckduckgo.com/?q=")).toBe(true);
    expect(url).toContain("hello%20world");
  });

  // §5 bullet 4 — Escape (driven through the overlay renderer) closes the bar
  // without navigating or creating a tab.
  test("Escape closes the command bar without navigating or creating a tab", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return {
        count: s.tabs.length,
        active: s.activeTabId,
        url: s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
      };
    });

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("navigate");
    });
    expect(
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return (await zeo.commandBar.state()).open;
      }),
    ).toBe(true);

    // Drive Escape through the overlay input: the renderer's onKeyDown maps
    // Escape -> commandBar.close (a real renderer key event, deliverable via CDP,
    // unlike the OS-level menu accelerators the other tests document as unpressable).
    const overlay = await commandBarWindow(app);
    await overlay.getByTestId("command-bar-input").press("Escape");

    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.commandBar.state()).open;
        }),
      )
      .toBe(false);

    const after = await sidebar.evaluate(async (activeId) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return {
        count: s.tabs.length,
        url: s.tabs.find((t) => t.id === activeId)?.url ?? null,
      };
    }, before.active);
    expect(after.count).toBe(before.count);
    expect(after.url).toBe(before.url);
  });

  // §5 bullet 5 — the headless seam: submit works with the bar CLOSED. Navigating,
  // creating, and whitespace-only (no-op) are each exercised without opening.
  test("submitting with the bar closed navigates, creates a tab, and ignores whitespace", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    const beforeCount = before.tabs.length;
    const activeId = before.activeTabId;

    // (a) submit while closed navigates the active tab and leaves the bar closed.
    const r1 = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("example.net");
      const s = await zeo.tabs.list();
      const st = await zeo.commandBar.state();
      return {
        count: s.tabs.length,
        active: s.activeTabId,
        url: s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
        open: st.open,
      };
    });
    expect(r1.open).toBe(false);
    expect(r1.count).toBe(beforeCount);
    expect(r1.active).toBe(activeId);
    expect(r1.url).toMatch(/example\.net/);

    // (b) submit with an explicit new-tab mode while closed creates a tab.
    const r2 = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("example.org", "new-tab");
      const s = await zeo.tabs.list();
      return {
        count: s.tabs.length,
        url: s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
      };
    });
    expect(r2.count).toBe(beforeCount + 1);
    expect(r2.url).toMatch(/example\.org/);

    // (c) whitespace-only text resolves to null: nothing changes.
    const r3 = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const pre = await zeo.tabs.list();
      await zeo.commandBar.submit("   ");
      const s = await zeo.tabs.list();
      return {
        preCount: pre.tabs.length,
        preUrl: pre.tabs.find((t) => t.id === pre.activeTabId)?.url ?? null,
        postCount: s.tabs.length,
        postUrl: s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
      };
    });
    expect(r3.postCount).toBe(r3.preCount);
    expect(r3.postUrl).toBe(r3.preUrl);
  });

  // §5 bullet 6 — core-level scheme rejection surfaces end to end: a `file:` scheme
  // is NOT a url, so the active tab lands on a search-engine url, never a file url.
  test("submitting a file: scheme resolves to a search, never a file url", async () => {
    const url = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.submit("file:///etc/hosts");
      const s = await zeo.tabs.list();
      return s.tabs.find((t) => t.id === s.activeTabId)?.url ?? "";
    });
    expect(url.startsWith("https://duckduckgo.com/?q=")).toBe(true);
    expect(url.startsWith("file:")).toBe(false);
  });

  // §5 bullet 8 — two rapid submits are last-request-wins. Fire the first WITHOUT
  // awaiting it, then await the second; both navigate the active tab. The stored
  // url ends on the SECOND target and stays there (the superseded first load is
  // aborted and never reverts the url or marks the tab failed).
  test("two rapid submits on the same tab are last-request-wins", async () => {
    const activeId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.tabs.list()).activeTabId;
    });

    const url = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      // Do NOT await the first: the second supersedes it (main aborts the older
      // loadURL). Both are navigate mode with the bar closed.
      void zeo.commandBar.submit("example.net");
      await zeo.commandBar.submit("example.org");
      const s = await zeo.tabs.list();
      return s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null;
    });
    expect(url).toMatch(/example\.org/);

    // The stored url stays on the second target: a late/aborted first load does
    // not revert it (network run: did-navigate for the current sequence keeps it
    // on example.org; never back to example.net).
    await expect
      .poll(
        async () =>
          sidebar.evaluate(async (id) => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const s = await zeo.tabs.list();
            return s.tabs.find((t) => t.id === id)?.url ?? null;
          }, activeId),
        { message: "expected the stored url to remain on the second target" },
      )
      .toMatch(/example\.org/);
  });

  // §5 bullet 9 — in-tab navigation mirrors the real url into the broadcast state.
  // Network-DEPENDENT (drives a real page navigation), so it polls generously. Uses
  // a host distinct from the seeded example.com so the assertion is unambiguous.
  test("in-tab navigation updates the tab's url in the broadcast state", async () => {
    const activeId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.tabs.list()).activeTabId;
    });

    // The seeded tab's own WebContentsView (overlay-safe lookup). Drive an in-page
    // navigation; location.assign returns synchronously before the context tears
    // down, but guard anyway.
    const tabView = await tabViewWindow(app, sidebar);
    await tabView
      .evaluate(() => {
        window.location.assign("https://example.org/");
      })
      .catch(() => {});

    // did-navigate on the tab's webContents updates the stored url and broadcasts.
    await expect
      .poll(
        async () =>
          sidebar.evaluate(async (id) => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const s = await zeo.tabs.list();
            return s.tabs.find((t) => t.id === id)?.url ?? null;
          }, activeId),
        {
          message: "expected did-navigate to mirror the real url into broadcast state",
          timeout: 30_000,
        },
      )
      .toMatch(/example\.org/);
  });

  // --- PRD 4.2 — command bar suggestions: tabs, archived tabs, spaces (§5). ------
  // These drive the widened command bar over the sidebar bridge (`window.zeo`)
  // and assert on the BROADCAST STATE: `commandBar.state()` (open/mode/query/
  // suggestions/selectedIndex), `tabs.list()`, and `spaces.list()` — all of
  // which main mutates synchronously before resolving, so the assertions are
  // network-INDEPENDENT. `expect.poll` settles the async state push after each
  // `setQuery`/`accept`. Tabs use reserved `.example` hostnames (which never
  // resolve, so a CI page load cannot overwrite the fallback hostname title),
  // and assertions match titles/urls by substring/regex — a real load can only
  // canonicalize a url (e.g. add a trailing slash), never change these.

  // §5 bullet 1 — a tab in an INACTIVE space is suggested with its space name;
  // accepting it switches the active space and activates the tab WITHOUT creating
  // a new tab.
  test("suggests a cross-space tab and accepting it switches space and activates it, creating no tab", async () => {
    // Second space ("Research") holding a distinctly-titled tab; then switch back
    // to Personal so Research (and its tab) is inactive at query time.
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const before = await zeo.tabs.list();
      const personalId = before.activeSpaceId;
      const research = await zeo.spaces.create("Research");
      await zeo.spaces.activate(research.id);
      const tab = await zeo.tabs.create("zeobar.example");
      await zeo.spaces.activate(personalId);
      return { personalId, researchId: research.id, tabId: tab.id };
    });

    // Open in new-tab mode and type part of the cross-space tab's title.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("zeobar");
    });

    // Poll until the ranked list carries a `tab` row for it with the right space.
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some(
            (s) => s.kind === "tab" && /zeobar/.test(s.title) && s.spaceName === "Research",
          );
        }),
      )
      .toBe(true);

    // Capture the tab row's index, and the pre-accept baselines we assert against.
    const pre = await sidebar.evaluate(async (ctx) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      const index = st.suggestions.findIndex(
        (s) => s.kind === "tab" && s.tabId === ctx.tabId,
      );
      const row = st.suggestions[index];
      const spaces = await zeo.spaces.list();
      const active = await zeo.tabs.list();
      return {
        index,
        rowUrl: row !== undefined && "url" in row ? row.url : null,
        spaceCount: spaces.spaces.length,
        activeSpaceId: spaces.activeSpaceId,
        activeTabCount: active.tabs.length,
      };
    }, setup);
    expect(pre.index).toBeGreaterThanOrEqual(0);
    expect(pre.rowUrl).toMatch(/zeobar\.example/);
    expect(pre.activeSpaceId).toBe(setup.personalId);

    // Accept the tab row by index: main activates Research, then the tab.
    await sidebar.evaluate(async (index) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(index);
    }, pre.index);

    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.commandBar.state()).open;
        }),
      )
      .toBe(false);

    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const spaces = await zeo.spaces.list();
      const active = await zeo.tabs.list();
      return {
        activeSpaceId: spaces.activeSpaceId,
        activeTabId: active.activeTabId,
        tabCount: active.tabs.length,
      };
    });
    // Active space switched to the tab's space; the tab is now active.
    expect(after.activeSpaceId).toBe(setup.researchId);
    expect(after.activeTabId).toBe(setup.tabId);
    // No new tab was created: Research still holds exactly the one tab it had.
    expect(after.tabCount).toBe(pre.activeTabCount);
    expect(after.tabCount).toBe(1);
  });

  // §5 bullet 2 — an ARCHIVED tab is suggested; accepting the `archived-tab` row
  // restores it (moves it out of `archived` into the open list) and activates it.
  test("suggests an archived tab and accepting restores and activates it", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const tab = await zeo.tabs.create("archmy.example");
      await zeo.tabs.archive(tab.id);
      const s = await zeo.tabs.list();
      return {
        tabId: tab.id,
        archivedContains: s.archived.some((t) => t.id === tab.id),
        openContains: s.tabs.some((t) => t.id === tab.id),
      };
    });
    expect(setup.archivedContains).toBe(true);
    expect(setup.openContains).toBe(false);

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("archmy");
    });

    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some(
            (s) => s.kind === "archived-tab" && /archmy/.test(s.title),
          );
        }),
      )
      .toBe(true);

    const index = await sidebar.evaluate(async (tabId) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.findIndex(
        (s) => s.kind === "archived-tab" && s.tabId === tabId,
      );
    }, setup.tabId);
    expect(index).toBeGreaterThanOrEqual(0);

    await sidebar.evaluate(async (i) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(i);
    }, index);

    await expect
      .poll(async () =>
        sidebar.evaluate(async (tabId) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const s = await zeo.tabs.list();
          const st = await zeo.commandBar.state();
          return {
            open: st.open,
            restored: s.tabs.some((t) => t.id === tabId),
            stillArchived: s.archived.some((t) => t.id === tabId),
            active: s.activeTabId,
          };
        }, setup.tabId),
      )
      .toEqual({ open: false, restored: true, stillArchived: false, active: setup.tabId });
  });

  // §5 bullet 3 — a SPACE is suggested by name; moving the selection onto its row
  // and accepting (no index — acts on the selected row) switches the active space.
  test("suggests a space and accepting the moved-to space row switches the active space", async () => {
    const sundialId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      // A name unlikely to be a substring of any tab title/url, so the only
      // `space` match is this one and no `tab` rows are interleaved with it.
      const space = await zeo.spaces.create("Sundial");
      return space.id;
    });

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("Sundial");
    });

    await expect
      .poll(async () =>
        sidebar.evaluate(async (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "space" && s.spaceId === id);
        }, sundialId),
      )
      .toBe(true);

    // Selection resets to row 0 after setQuery; step it down onto the space row,
    // then assert the state's selectedIndex actually points at that row.
    const landed = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      const target = st.suggestions.findIndex(
        (s) => s.kind === "space" && s.spaceId === id,
      );
      for (let i = 0; i < target; i++) {
        await zeo.commandBar.moveSelection(1);
      }
      const next = await zeo.commandBar.state();
      const selected = next.suggestions[next.selectedIndex];
      return {
        target,
        selectedIndex: next.selectedIndex,
        selectedKind: selected !== undefined ? selected.kind : null,
      };
    }, sundialId);
    expect(landed.selectedIndex).toBe(landed.target);
    expect(landed.selectedKind).toBe("space");

    // Accept with NO index: main acts on the row at selectedIndex.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept();
    });

    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.spaces.list()).activeSpaceId;
        }),
      )
      .toBe(sundialId);
  });

  // §5 bullet 4 — row 0 (the text action) stays selected when the arrows are not
  // touched, even though the query ALSO matches an open tab: accepting creates a
  // new tab for the resolved text rather than activating the matched tab.
  test("row 0 remains the text action: accept without moving creates a tab instead of activating the match", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const match = await zeo.tabs.create("zebra.example");
      // A second, non-matching tab so zebra.example is no longer the ACTIVE tab:
      // the active tab is excluded from suggestions (ranking contract, PRD §1),
      // so without this "zebra" would surface only row 0 and never a tab row.
      await zeo.tabs.create("other.example");
      const s = await zeo.tabs.list();
      return { matchId: match.id, tabCount: s.tabs.length };
    });

    // "zebra" resolves to a SEARCH (no dot), so row 0 is a `search` action; it
    // also substring-matches the zebra.example tab, so there is a tab row below.
    const shape = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("zebra");
      const st = await zeo.commandBar.state();
      return {
        selectedIndex: st.selectedIndex,
        row0Kind: st.suggestions[0]?.kind ?? null,
        hasTabRow: st.suggestions.some((s) => s.kind === "tab"),
      };
    });
    expect(shape.selectedIndex).toBe(0);
    expect(shape.row0Kind).toMatch(/navigate|search/);
    expect(shape.hasTabRow).toBe(true);

    // Accept WITHOUT moving the selection: row 0 wins.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept();
    });

    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      const st = await zeo.commandBar.state();
      return {
        tabCount: s.tabs.length,
        activeId: s.activeTabId,
        activeUrl: s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
        open: st.open,
      };
    });
    // A new tab was created for the resolved (search) url; the matched tab was
    // NOT activated, and the bar closed.
    expect(after.tabCount).toBe(setup.tabCount + 1);
    expect(after.activeId).not.toBe(setup.matchId);
    expect(after.activeUrl).toMatch(/duckduckgo\.com/);
    expect(after.open).toBe(false);
  });

  // §5 bullet 5 — arrow selection wraps at both ends. With row 0 plus at least one
  // match, `moveSelection(1)` past the last row wraps to 0 and `moveSelection(-1)`
  // from 0 wraps to the last row.
  test("arrow selection wraps at both ends of the suggestion list", async () => {
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      // Two matches so the list is [row0, tab, tab] — at least one row past row 0.
      await zeo.tabs.create("zebra.example");
      await zeo.tabs.create("zebrafish.example");
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("zebra");
    });

    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.commandBar.state()).suggestions.length;
        }),
      )
      .toBeGreaterThanOrEqual(2);

    const result = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const start = await zeo.commandBar.state();
      const count = start.suggestions.length;
      const last = count - 1;
      // Step down to the last row.
      for (let i = 0; i < last; i++) {
        await zeo.commandBar.moveSelection(1);
      }
      const atLast = (await zeo.commandBar.state()).selectedIndex;
      // One more wraps to row 0.
      await zeo.commandBar.moveSelection(1);
      const wrappedForward = (await zeo.commandBar.state()).selectedIndex;
      // Up from row 0 wraps to the last row.
      await zeo.commandBar.moveSelection(-1);
      const wrappedBackward = (await zeo.commandBar.state()).selectedIndex;
      return { start: start.selectedIndex, last, atLast, wrappedForward, wrappedBackward };
    });
    expect(result.start).toBe(0);
    expect(result.atLast).toBe(result.last);
    expect(result.wrappedForward).toBe(0);
    expect(result.wrappedBackward).toBe(result.last);
  });

  // §5 bullet 6 — empty query in new-tab mode lists the recent open tabs: all
  // `tab` rows (no row 0), most-recently-active first, the active tab excluded,
  // capped at 8. Distinct 5ms gaps between creates give strictly increasing
  // `lastActiveAt` so the recency order is deterministic (suggest tie-breaks equal
  // timestamps only by catalog order, which is not recency).
  test("empty query in new-tab mode lists recent tabs, most recent first, active excluded, capped at 8", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const before = await zeo.tabs.list();
      const seededId = before.activeTabId;
      const gap = (): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, 5));
      await gap();
      const alpha = await zeo.tabs.create("alpha.example");
      await gap();
      const bravo = await zeo.tabs.create("bravo.example");
      await gap();
      const charlie = await zeo.tabs.create("charlie.example");
      return {
        seededId,
        alphaId: alpha.id,
        bravoId: bravo.id,
        charlieId: charlie.id,
      };
    });

    // charlie was created last, so it is active and must be EXCLUDED.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      // Force a recompute of the empty-query recent list.
      await zeo.commandBar.setQuery("");
    });

    const list = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return {
        kinds: st.suggestions.map((s) => s.kind),
        tabIds: st.suggestions.map((s) => (s.kind === "tab" ? s.tabId : null)),
      };
    });
    // Every row is a tab (no navigate/search row 0 on an empty query).
    expect(list.kinds.every((k) => k === "tab")).toBe(true);
    expect(list.kinds.length).toBeLessThanOrEqual(8);
    // Active tab (charlie) is absent.
    expect(list.tabIds).not.toContain(setup.charlieId);
    // Most-recently-active first: bravo, then alpha, then the seeded tab.
    expect(list.tabIds).toEqual([setup.bravoId, setup.alphaId, setup.seededId]);
  });

  // §5 bullet 7 — the overlay panel grows with the list and shrinks back when the
  // query stops matching. We assert BOTH the rendered DOM row count (one row per
  // suggestion, row 0 included) AND the NATIVE overlay WebContentsView bounds
  // height read from the main process, checked against commandBarBounds() from
  // @zeo/core so the panel geometry — not just the DOM — actually tracks the list.
  test("overlay row count and native bounds grow when the query matches and shrink back to row 0 when it does not", async () => {
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.create("orchid.example");
      // A second, non-matching tab so orchid.example is not the ACTIVE tab (the
      // active tab is excluded from suggestions), letting "orchid" surface row 0
      // plus the orchid tab row.
      await zeo.tabs.create("daffodil.example");
      await zeo.commandBar.open("new-tab");
    });

    const overlay = await commandBarWindow(app);
    const rows = overlay.getByTestId("command-bar-suggestion");

    // A query that matches the orchid tab: row 0 (search) + the tab row = 2 rows.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.setQuery("orchid");
    });
    await expect(rows).toHaveCount(2);
    // Native overlay height matches the 2-row geometry main computes. Polled
    // because the DOM row count and the native setBounds settle independently.
    await expect
      .poll(async () => {
        const b = await overlayNativeBounds(app);
        return b === null ? null : b.overlayHeight;
      })
      .toBe(
        await overlayNativeBounds(app).then((b) =>
          b === null ? null : commandBarBounds(b.width, b.height, 2).height,
        ),
      );

    // A resolvable-but-unmatched query: only row 0 (the text action) remains.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.setQuery("qzxvwmklunlikely");
    });
    await expect(rows).toHaveCount(1);
    // Native overlay height shrinks back to the single-row (row 0 only) geometry.
    await expect
      .poll(async () => {
        const b = await overlayNativeBounds(app);
        return b === null ? null : b.overlayHeight;
      })
      .toBe(
        await overlayNativeBounds(app).then((b) =>
          b === null ? null : commandBarBounds(b.width, b.height, 1).height,
        ),
      );

    // Hygiene: close the bar like the neighbouring tests do.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // CodeRabbit 2a — a row-click accept carries the revision of the list it was
  // rendered against. If the suggestion list changes before the click reaches
  // main (a click racing a newer pushed list), main rejects the stale accept and
  // performs no action, rather than resolving the clicked index against the new
  // (different) rows. Here the stale index is still IN RANGE for the new list but
  // points at a DIFFERENT tab, so only the revision guard — not the range check —
  // can prevent the wrong activation.
  test("a row-click accept with a stale revision is rejected and performs no action", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.create("tulip.example");
      await zeo.tabs.create("rose.example");
      // A third, non-matching tab so BOTH tulip and rose are non-active and thus
      // eligible as suggestion rows.
      await zeo.tabs.create("fern.example");
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("tulip"); // list revision R: [search, tulip]
      const st = await zeo.commandBar.state();
      const s = await zeo.tabs.list();
      const tabIndex = st.suggestions.findIndex((x) => x.kind === "tab");
      return {
        staleRevision: st.revision,
        tabIndex,
        tabCount: s.tabs.length,
        activeId: s.activeTabId,
      };
    });
    // The tulip tab is a real row below row 0.
    expect(setup.tabIndex).toBe(1);

    // Change the list to [search, rose]: bumps the revision, so setup.staleRevision
    // is now stale while index 1 stays in range (but points at rose, not tulip).
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.setQuery("rose");
    });

    // Accept the OLD index with the STALE revision. Main rejects (throws), so the
    // invoke rejects; without the guard this would activate the rose tab.
    const rejected = await sidebar.evaluate(
      async ({ index, revision }) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.commandBar.accept(index, revision);
          return false;
        } catch {
          return true;
        }
      },
      { index: setup.tabIndex, revision: setup.staleRevision },
    );
    expect(rejected).toBe(true);

    // The bar is untouched (still open) and no tab was activated or created.
    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      const s = await zeo.tabs.list();
      return { open: st.open, tabCount: s.tabs.length, activeId: s.activeTabId };
    });
    expect(after.open).toBe(true);
    expect(after.tabCount).toBe(setup.tabCount);
    expect(after.activeId).toBe(setup.activeId);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // --- PRD 4.3 — command registry and action suggestions (§5). -------------------
  // These drive the command bar / bridge over the sidebar bridge (`window.zeo`)
  // and assert on the BROADCAST STATE — `commandBar.state()` (open/query/
  // suggestions/revision), `tabs.list()`, `spaces.list()`, and the application
  // menu read from the MAIN process — which main mutates synchronously before
  // resolving, so the enablement/toggle assertions are network-INDEPENDENT.
  // `expect.poll` settles the async state push after each accept/navigate, and
  // the two history/reload tests that genuinely need a real page load say so and
  // poll generously (CI has network). Menu accelerator KEYCHORDS cannot be fired
  // headlessly (see the SEAM note above), so command dispatch is driven through
  // the bar/bridge and the menu is only READ, never key-pressed.

  // §5 bullet 1 — a `command` row pins the active tab; re-querying then offers the
  // tab.unpin row (tab.pin is disabled/absent once the tab is pinned).
  test("a command row pins the active tab, then the bar offers unpin", async () => {
    const activeId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.tabs.list()).activeTabId;
    });
    expect(activeId).not.toBeNull();

    // Open the bar and query "pin"; the tab.pin command row must surface.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("pin");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.pin");
        }),
      )
      .toBe(true);

    // Accept the tab.pin row by its index: main runs the handler and closes the bar.
    const pinIndex = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.findIndex((s) => s.kind === "command" && s.id === "tab.pin");
    });
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    await sidebar.evaluate(async (i) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(i);
    }, pinIndex);

    // The active tab is now pinned.
    await expect
      .poll(async () =>
        sidebar.evaluate(async (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const s = await zeo.tabs.list();
          return s.tabs.find((t) => t.id === id)?.pinned ?? null;
        }, activeId),
      )
      .toBe(true);

    // Re-open and query "pin" again: tab.pin is gone (disabled — the tab is
    // pinned) and the row is now tab.unpin.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("pin");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return {
            hasUnpin: st.suggestions.some((s) => s.kind === "command" && s.id === "tab.unpin"),
            hasPin: st.suggestions.some((s) => s.kind === "command" && s.id === "tab.pin"),
          };
        }),
      )
      .toEqual({ hasUnpin: true, hasPin: false });

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 2 — a `command` row creates a new space and activates it.
  test("a command row creates a new space and makes it active", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    const beforeCount = before.spaces.length;
    const beforeIds = new Set(before.spaces.map((s) => s.id));

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("new space");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "command" && s.id === "space.new");
        }),
      )
      .toBe(true);

    const idx = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.findIndex((s) => s.kind === "command" && s.id === "space.new");
    });
    await sidebar.evaluate(async (i) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(i);
    }, idx);

    // The space count grew by one and the newly created space is the active one.
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.spaces.list()).spaces.length;
        }),
      )
      .toBe(beforeCount + 1);

    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    expect(after.spaces.length).toBe(beforeCount + 1);
    // The active space is the new one (not any that existed before).
    expect(beforeIds.has(after.activeSpaceId)).toBe(false);
    expect(after.spaces.some((s) => s.id === after.activeSpaceId)).toBe(true);
  });

  // §5 bullet 3 — with a single space, space.delete is disabled and therefore
  // excluded from suggestions: no `command` row for it exists.
  test("no delete-space command row is offered with a single space", async () => {
    // Fresh launch has exactly one space.
    const spaceCount = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.spaces.list()).spaces.length;
    });
    expect(spaceCount).toBe(1);

    // Open, query "delete space", read the authoritative main state directly
    // (setQuery resolves after main recomputes suggestions synchronously).
    const result = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("delete space");
      const st = await zeo.commandBar.state();
      return {
        query: st.query,
        hasDelete: st.suggestions.some(
          (s) => s.kind === "command" && s.id === "space.delete",
        ),
      };
    });
    expect(result.query).toBe("delete space");
    expect(result.hasDelete).toBe(false);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 4 — the commands bridge: `run("tab.close")` closes the active tab;
  // `run("tab.back")` on a fresh tab with no history REJECTS (disabled in context).
  test("commands.run closes the active tab and rejects a command disabled in context", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      // A second tab so the active one can be closed while a fresh, history-less
      // tab remains for the tab.back rejection.
      const created = await zeo.tabs.create("example.net");
      const s = await zeo.tabs.list();
      return { createdId: created.id, count: s.tabs.length, activeId: s.activeTabId };
    });
    // create activates the new tab, so it is the one tab.close will close.
    expect(setup.count).toBe(2);
    expect(setup.activeId).toBe(setup.createdId);

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commands.run("tab.close");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return (await zeo.tabs.list()).tabs.length;
        }),
      )
      .toBe(1);
    const afterClose = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.list();
    });
    expect(afterClose.tabs.some((t) => t.id === setup.createdId)).toBe(false);

    // The remaining (seeded) tab has no back-history, so tab.back is disabled and
    // the invoke must REJECT.
    const rejected = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.commands.run("tab.back");
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
  });

  // §5 bullet 5 — history refresh without retyping. With the bar open and "back"
  // typed, a fresh tab has no tab.back row and the View menu's Go Back item is
  // disabled. Navigating the tab IN PLACE creates back-history; refreshCommandState
  // (firing on did-navigate / did-finish-load while the bar is open) makes the
  // tab.back row appear AND the menu item enable WITHOUT retyping. Network-
  // dependent (a real navigation must load), so it polls generously.
  test("the Go Back row and menu item enable without retyping after an in-place navigation", async () => {
    // Fully load the seeded page (example.com) BEFORE opening the bar. The overlay
    // closes on ANY focus loss (its blur handler), and a page finishing load can
    // steal focus; doing the load now means the ONLY thing that happens with the
    // bar open is the focus-neutral hash change below, so the bar stays open.
    const tabView = await tabViewWindow(app, sidebar);
    await expect.poll(() => tabView.url(), { timeout: 30_000 }).toContain("example.com");
    await tabView.waitForLoadState("load").catch(() => {});

    // Open the bar and type "back". On a fresh tab there is no back-history.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("back");
    });
    const initialHasBack = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.back");
    });
    expect(initialHasBack).toBe(false);

    // Reads the View menu's "Go Back" item enabled flag from the main process.
    const goBackEnabled = (): Promise<boolean | null> =>
      app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        if (menu === null) {
          return null;
        }
        const viewMenu = menu.items.find((i) => i.label === "View");
        if (viewMenu?.submenu == null) {
          return null;
        }
        return viewMenu.submenu.items.find((i) => i.label === "Go Back")?.enabled ?? null;
      });
    expect(await goBackEnabled()).toBe(false);

    // Navigate the active tab IN PLACE via a same-document hash change, run in
    // the tab view's own context. This is deliberately NOT a full `tabs.navigate`
    // reload: a fresh page load focuses the tab's WebContentsView, which would blur
    // and close the overlay — so the row could never appear while the bar is shut.
    // A hash change instead adds a real back-history entry (canGoBack → true) and
    // fires `did-navigate-in-page` WITHOUT reloading or refocusing the view, so the
    // overlay stays open and refreshCommandState re-ranks its suggestions live.
    await tabView.evaluate(() => {
      window.location.hash = "#zeo-back";
    });

    // WITHOUT retyping, the tab.back row appears (refreshCommandState re-ran the
    // bar's suggestions on the navigation event).
    await expect
      .poll(
        async () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const st = await zeo.commandBar.state();
            return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.back");
          }),
        { message: "expected the tab.back row to appear without retyping", timeout: 30_000 },
      )
      .toBe(true);

    // And the View menu's Go Back item is now enabled.
    await expect
      .poll(goBackEnabled, {
        message: "expected the View menu Go Back item to become enabled",
        timeout: 30_000,
      })
      .toBe(true);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 6 — stale dispatch. With two spaces, open the bar and query
  // "delete space", capturing the space.delete row index and the list revision.
  // Deleting the OTHER space over the bridge bumps the revision (and drops the
  // context to one space), so accepting the captured row with the STALE revision
  // is rejected by the revision guard (and executeCommand's re-check); the
  // remaining space survives.
  test("a stale space.delete accept is rejected and the remaining space survives", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const before = await zeo.spaces.list();
      const activeId = before.activeSpaceId;
      // create does not steal focus, so `activeId` stays active and "Doomed" is
      // the non-active space we delete out from under the captured row.
      const other = await zeo.spaces.create("Doomed");
      return { activeId, otherId: other.id };
    });

    const captured = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("delete space");
      const st = await zeo.commandBar.state();
      return {
        index: st.suggestions.findIndex(
          (s) => s.kind === "command" && s.id === "space.delete",
        ),
        revision: st.revision,
      };
    });
    // With two spaces, space.delete is enabled, so its row exists.
    expect(captured.index).toBeGreaterThanOrEqual(0);

    // Delete the OTHER (non-active) space over the bridge: mutates the store and
    // (bar open) bumps the revision, so `captured.revision` is now stale.
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.delete(id);
    }, setup.otherId);

    // Accept the captured row with the STALE revision: main rejects (throws), so
    // the invoke rejects and no delete runs.
    const rejected = await sidebar.evaluate(
      async ({ index, revision }) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.commandBar.accept(index, revision);
          return false;
        } catch {
          return true;
        }
      },
      captured,
    );
    expect(rejected).toBe(true);

    // The remaining (active) space survives: exactly one space left, and it is the
    // one that was active.
    const after = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.list();
    });
    expect(after.spaces.length).toBe(1);
    expect(after.spaces[0].id).toBe(setup.activeId);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 7 — the pin/unpin pair collapses to exactly ONE Tabs submenu item
  // carrying CmdOrCtrl+Shift+P; its label follows the enabled member: "Pin Tab"
  // on a fresh (unpinned) active tab, "Unpin Tab" after pinning. Reads the menu
  // from the main process (label + accelerator), never a keychord.
  test("the Tabs menu has exactly one Cmd+Shift+P item whose label follows the pin state", async () => {
    const activeId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const s = await zeo.tabs.list();
      return s.activeTabId ?? s.tabs[0].id;
    });

    // Reads { count, label } for the CmdOrCtrl+Shift+P Tabs items from main.
    const pinItem = (): Promise<{ count: number; label: string | null }> =>
      app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        if (menu === null) {
          throw new Error("no application menu installed");
        }
        const tabsMenu = menu.items.find((i) => i.label === "Tabs");
        if (tabsMenu?.submenu == null) {
          throw new Error('no "Tabs" submenu');
        }
        const matches = tabsMenu.submenu.items.filter(
          (i) => i.accelerator === "CmdOrCtrl+Shift+P",
        );
        return { count: matches.length, label: matches[0]?.label ?? null };
      });

    // Fresh unpinned active tab: one item, "Pin Tab".
    expect(await pinItem()).toEqual({ count: 1, label: "Pin Tab" });

    // Pin the active tab; the menu rebuilds (refreshCommandState) and the single
    // Cmd+Shift+P item relabels to "Unpin Tab".
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.pin(id);
    }, activeId);
    await expect.poll(pinItem).toEqual({ count: 1, label: "Unpin Tab" });
  });

  // §5 bullet 8 — reload via the bar. Set a page-side marker on the active view,
  // accept the tab.reload command row, then poll (re-acquiring the tab view, since
  // reload tears down and recreates the page context) until the marker is gone —
  // proving the active view actually reloaded. Network-dependent, so it polls
  // generously.
  test("a command row reloads the active view", async () => {
    const tabView = await tabViewWindow(app, sidebar);
    // Set a distinctive page-side marker; confirm it took.
    await tabView.evaluate(() => {
      (window as unknown as { __zeoReloadMarker?: boolean }).__zeoReloadMarker = true;
    });
    const markerSet = await tabView.evaluate(
      () => (window as unknown as { __zeoReloadMarker?: boolean }).__zeoReloadMarker === true,
    );
    expect(markerSet).toBe(true);

    // Open the bar, query "reload", accept the tab.reload command row.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("reload");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.reload");
        }),
      )
      .toBe(true);
    const reloadIndex = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.findIndex((s) => s.kind === "command" && s.id === "tab.reload");
    });
    await sidebar.evaluate(async (i) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(i);
    }, reloadIndex);

    // Reload destroys/recreates the page context, so re-acquire the tab view each
    // pass and poll until the marker is gone.
    await expect
      .poll(
        async () => {
          const view = await tabViewWindow(app, sidebar);
          return view
            .evaluate(
              () =>
                (window as unknown as { __zeoReloadMarker?: boolean }).__zeoReloadMarker ===
                undefined,
            )
            .catch(() => false);
        },
        { message: "expected the active view to reload and clear the marker", timeout: 30_000 },
      )
      .toBe(true);
  });

  // --- PRD 4.4 — command mode (the third bar mode, Cmd+K). ------------------------
  // These drive the `commands` bar mode over the sidebar bridge and assert on the
  // BROADCAST STATE (`commandBar.state()`, `tabs.list()`) exactly like the PRD 4.3
  // command tests above. In a fresh launch (one seeded open tab, one space
  // "Personal", tab unpinned, no history) the EXACT set of commands that are both
  // enabled AND not `bar.open-commands`, in registry order, is this list. The
  // COMMANDS-order cross-check inside the first test locks the ORDER to the registry
  // itself so a registry reorder is caught here without hand-maintaining this array.
  const EXPECTED_COMMANDS_MODE_IDS = [
    "tab.new",
    "tab.close",
    "tab.pin",
    "tab.archive",
    "tab.copy-url",
    "tab.reload",
    "space.new",
    "space.rename",
    "bar.open-location",
    "blocking.toggle",
  ];

  // §5 bullet 1 — commands mode opens empty, lists only enabled command rows in
  // registry order (no navigate/search/tab/space rows, and never bar.open-commands),
  // and the overlay input shows the "Run a command" placeholder with an empty value.
  test("commands mode lists only enabled commands in registry order, empty with the Run a command placeholder", async () => {
    const st = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("commands");
      return zeo.commandBar.state();
    });
    expect(st.open).toBe(true);
    expect(st.mode).toBe("commands");
    expect(st.query).toBe("");
    expect(st.initialText).toBe("");

    // Every row is a `command` row; no address/search/tab/space/archived-tab row.
    expect(st.suggestions.every((s) => s.kind === "command")).toBe(true);
    expect(
      st.suggestions.some((s) =>
        ["navigate", "search", "tab", "space", "archived-tab"].includes(s.kind),
      ),
    ).toBe(false);

    // The ids are exactly the expected enabled set in registry order, and equal the
    // registry-derived cross-check (so this cannot drift from COMMANDS' order).
    const ids = st.suggestions.map((s) => (s.kind === "command" ? s.id : ""));
    expect(ids).toEqual(EXPECTED_COMMANDS_MODE_IDS);
    expect(ids).toEqual(
      COMMANDS.map((c) => c.id).filter((id) => EXPECTED_COMMANDS_MODE_IDS.includes(id)),
    );
    expect(ids).not.toContain("bar.open-commands");

    // The overlay input reflects the commands-mode placeholder and stays empty
    // (web-first matchers retry through the state push + re-render).
    const overlay = await commandBarWindow(app);
    await expect(overlay.getByTestId("command-bar-input")).toHaveAttribute(
      "placeholder",
      "Run a command",
    );
    await expect(overlay.getByTestId("command-bar-input")).toHaveValue("");

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 2 — typing "pin" in commands mode yields EXACTLY the tab.pin command
  // row (no tab row, no disabled tab.unpin); accepting it pins the active tab and
  // closes the bar.
  test("typing pin in commands mode yields exactly the tab.pin command row, and accepting pins the active tab and closes the bar", async () => {
    const activeId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.tabs.list()).activeTabId;
    });
    expect(activeId).not.toBeNull();

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("commands");
      await zeo.commandBar.setQuery("pin");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.pin");
        }),
      )
      .toBe(true);

    // Exactly one row, the tab.pin command — no tab row despite the seeded tab, and
    // no tab.unpin (disabled while unpinned).
    const rows = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.map((s) => ({ kind: s.kind, id: s.kind === "command" ? s.id : null }));
    });
    expect(rows).toEqual([{ kind: "command", id: "tab.pin" }]);

    const pinIndex = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.findIndex((s) => s.kind === "command" && s.id === "tab.pin");
    });
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    await sidebar.evaluate(async (i) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.accept(i);
    }, pinIndex);

    // The active tab is now pinned.
    await expect
      .poll(async () =>
        sidebar.evaluate(async (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const s = await zeo.tabs.list();
          return s.tabs.find((t) => t.id === id)?.pinned ?? null;
        }, activeId),
      )
      .toBe(true);

    // Accepting a command row in commands mode closes the bar.
    const open = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.commandBar.state()).open;
    });
    expect(open).toBe(false);
  });

  // §5 bullet 3 — modes stay independent. A non-active tab titled "pinboard" matches
  // "pin", but commands mode never shows a tab row; new-tab mode still does.
  test("commands mode never shows a tab row even when a tab title matches, but new-tab mode does", async () => {
    const pb = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const seededId = (await zeo.tabs.list()).activeTabId;
      // create activates the new tab; re-activate the seeded tab so the pinboard tab
      // is NOT active (the active tab is excluded from suggestions).
      const created = await zeo.tabs.create("pinboard.example");
      if (seededId !== null) {
        await zeo.tabs.activate(seededId);
      }
      return { id: created.id, seededId };
    });
    expect(pb.seededId).not.toBeNull();

    // commands mode: querying "pin" surfaces command rows only — never a tab row,
    // even though the "pinboard" tab title matches.
    const commandsKinds = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("commands");
      await zeo.commandBar.setQuery("pin");
      const st = await zeo.commandBar.state();
      return st.suggestions.map((s) => s.kind);
    });
    expect(commandsKinds).not.toContain("tab");

    // new-tab mode: the same query brings the tab row back (modes are independent).
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
      await zeo.commandBar.setQuery("pin");
    });
    await expect
      .poll(async () =>
        sidebar.evaluate(async (pbId) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.commandBar.state();
          return st.suggestions.some((s) => s.kind === "tab" && s.tabId === pbId);
        }, pb.id),
      )
      .toBe(true);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 4 — Cmd+K toggles the palette (bar.open-commands): a run opens it in
  // commands mode, a second run closes it, and a run while the bar is open in
  // navigate mode switches it into commands with an empty query.
  test("commands.run(bar.open-commands) toggles the palette and switches into it from navigate mode", async () => {
    const opened = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commands.run("bar.open-commands");
      return zeo.commandBar.state();
    });
    expect(opened.open).toBe(true);
    expect(opened.mode).toBe("commands");

    const closed = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commands.run("bar.open-commands");
      return zeo.commandBar.state();
    });
    expect(closed.open).toBe(false);

    // Open in navigate mode (prefilled with the active tab url), then toggle: the
    // handler switches an open navigate bar into commands with a reset query.
    const nav = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("navigate");
      return zeo.commandBar.state();
    });
    expect(nav.open).toBe(true);
    expect(nav.mode).toBe("navigate");
    expect(nav.query.length).toBeGreaterThan(0);

    const switched = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commands.run("bar.open-commands");
      return zeo.commandBar.state();
    });
    expect(switched.open).toBe(true);
    expect(switched.mode).toBe("commands");
    expect(switched.query).toBe("");

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 5 — accepting the bar.open-commands row from new-tab and navigate modes
  // runs its handler, which leaves the bar OPEN switched into commands mode with an
  // empty query and the full command list (it joins tab.new/bar.open-location as an
  // accept exception).
  test("accepting the bar.open-commands row from new-tab and navigate modes leaves the bar open in commands mode", async () => {
    for (const mode of ["new-tab", "navigate"] as const) {
      await sidebar.evaluate(async (m) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open(m);
        await zeo.commandBar.setQuery("command");
      }, mode);
      await expect
        .poll(async () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const st = await zeo.commandBar.state();
            return st.suggestions.some((s) => s.kind === "command" && s.id === "bar.open-commands");
          }),
        )
        .toBe(true);

      const idx = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const st = await zeo.commandBar.state();
        return st.suggestions.findIndex(
          (s) => s.kind === "command" && s.id === "bar.open-commands",
        );
      });
      expect(idx).toBeGreaterThanOrEqual(0);
      await sidebar.evaluate(async (i) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.accept(i);
      }, idx);

      const after = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const st = await zeo.commandBar.state();
        return {
          open: st.open,
          mode: st.mode,
          query: st.query,
          ids: st.suggestions.map((s) => (s.kind === "command" ? s.id : "")),
        };
      });
      expect(after.open).toBe(true);
      expect(after.mode).toBe("commands");
      expect(after.query).toBe("");
      expect(after.ids).toEqual(EXPECTED_COMMANDS_MODE_IDS);

      // Hygiene between iterations: close the bar before the next mode.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.close();
      });
    }
  });

  // §5 bullet 6 — commands mode has no text action: submit REJECTS and changes
  // nothing, both with an explicit "commands" mode argument and with no argument
  // while the bar is open in commands mode.
  test("submit rejects in commands mode and leaves the bar unchanged", async () => {
    const before = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("commands");
      return zeo.commandBar.state();
    });
    expect(before.open).toBe(true);
    expect(before.mode).toBe("commands");

    // Explicit "commands" mode argument rejects; state is unchanged.
    const rejectedExplicit = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.commandBar.submit("example.org", "commands");
        return false;
      } catch {
        return true;
      }
    });
    expect(rejectedExplicit).toBe(true);
    const afterExplicit = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.commandBar.state();
    });
    expect(afterExplicit).toEqual(before);

    // No mode argument (bar open in commands mode) rejects the same way, unchanged.
    const rejectedImplicit = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.commandBar.submit("example.org");
        return false;
      } catch {
        return true;
      }
    });
    expect(rejectedImplicit).toBe(true);
    const afterImplicit = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.commandBar.state();
    });
    expect(afterImplicit).toEqual(before);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });

  // §5 bullet 7 — enablement refresh in commands mode without retyping. With the bar
  // open in commands mode and "back" typed, a fresh tab has no tab.back row. An
  // IN-PLACE hash navigation (focus-neutral, keeps the overlay open) adds back-history
  // and refreshCommandState re-ranks the live suggestions, so the tab.back row appears
  // WITHOUT retyping. Network-dependent (the seeded page must load first), so it polls
  // generously.
  test("commands mode refreshes enablement without retyping: the Go Back row appears after an in-place navigation", async () => {
    // Fully load the seeded page BEFORE opening the bar so the only thing happening
    // with the bar open is the focus-neutral hash change (a load can steal focus and
    // close the overlay).
    const tabView = await tabViewWindow(app, sidebar);
    await expect.poll(() => tabView.url(), { timeout: 30_000 }).toContain("example.com");
    await tabView.waitForLoadState("load").catch(() => {});

    // Open commands mode and type "back": on a fresh tab there is no back-history, so
    // no tab.back command row.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("commands");
      await zeo.commandBar.setQuery("back");
    });
    const initialHasBack = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const st = await zeo.commandBar.state();
      return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.back");
    });
    expect(initialHasBack).toBe(false);

    // Navigate the active tab IN PLACE via a same-document hash change in the tab
    // view's own context: adds a real back-history entry (canGoBack → true) and fires
    // did-navigate-in-page WITHOUT reloading or refocusing the view, so the overlay
    // stays open and refreshCommandState re-ranks its suggestions live.
    await tabView.evaluate(() => {
      window.location.hash = "#zeo-cmdback";
    });

    // WITHOUT retyping, the tab.back row appears.
    await expect
      .poll(
        async () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const st = await zeo.commandBar.state();
            return st.suggestions.some((s) => s.kind === "command" && s.id === "tab.back");
          }),
        {
          message: "expected the tab.back row to appear in commands mode without retyping",
          timeout: 30_000,
        },
      )
      .toBe(true);

    // Hygiene: close the bar.
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.close();
    });
  });
});
