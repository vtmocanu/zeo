import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts / app.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// find-in-page tests touch (structurally compatible with @zeo/core's ZeoApi).
interface BridgeTab {
  id: string;
  url: string;
}
interface BridgeState {
  tabs: { id: string }[];
  activeTabId: string | null;
}
// PRD 6.3 — the in-page find session slice, exactly as main returns it over
// IPC.findState (and rides TabsState.find on the stateChange broadcast). Only
// `open`/`activeMatch`/`matchCount`/`tabId` are load-bearing here; the full six
// fields are redeclared like the rest of this bridge.
interface FindStateShape {
  open: boolean;
  query: string;
  activeMatch: number;
  matchCount: number;
  tabId: string | null;
  activeRequestId: number | null;
}
// PRD 4.4 — only the `open` flag of the command-bar state is load-bearing for the
// find/command-bar mutual-exclusion case below.
interface CommandBarStateShape {
  open: boolean;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  commandBar: {
    open(mode: string): Promise<void>;
    close(): Promise<void>;
    state(): Promise<CommandBarStateShape>;
  };
  find: {
    open(): Promise<void>;
    setQuery(text: string): Promise<void>;
    next(): Promise<void>;
    previous(): Promise<void>;
    close(): Promise<void>;
    state(): Promise<FindStateShape>;
  };
}

// The fixture page: its VISIBLE body contains the word `needle` EXACTLY three
// times and nowhere else — not in the <title>, an attribute, or a hidden node —
// so `webContents.findInPage("needle")` deterministically reports a total of 3.
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>find fixture</title></head>
<body><p>needle one</p><p>a needle in the haystack</p><div>third needle</div></body></html>`;

/** A running loopback fixture server serving the single find fixture page. */
interface FixtureServer {
  base: string;
  /** The bound ephemeral port; used to recognise the tab's committed url. */
  port: number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port, serving the find
 * fixture at `/page.html`. Modeled on blocking.spec.ts's `startFixtureServer`: a
 * fully offline, deterministic loopback origin (`no-store` so a re-navigation
 * always re-fetches rather than serving Chromium's HTTP cache).
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/page.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to an inet address");
  }
  const port = (address as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * The renderer window that hosts the React sidebar — the MAIN renderer Page,
 * WITHOUT a `?view=` param, so `window.zeo` lives there and drives find state.
 * Copied from blocking.spec.ts / app.spec.ts: `firstWindow()` cannot be trusted
 * because each tab and the overlay surface as their own windows, so poll every
 * open window for the one exposing the sidebar, guarding a navigating view's
 * momentarily-destroyed execution context with try/catch.
 */
async function sidebarWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.getByTestId("sidebar").count()) > 0) {
          return w;
        }
      } catch {
        // A tab's WebContentsView can surface as a window and, while navigating,
        // its execution context may be momentarily destroyed. Skip it this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/**
 * The overlay Page (the single WebContentsView PRD 4.1 mounts with
 * `?view=command-bar`). Located by its url — NOT by the `command-bar` testid:
 * while the find surface is active the overlay renders the FindBar and carries NO
 * `command-bar` testid, so a testid probe would never find it when find is open.
 * The sidebar (no `?view=`) and the settings view (`?view=settings`) load the
 * renderer at other urls, so `view=command-bar` uniquely identifies the overlay.
 */
async function overlayWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes("view=command-bar")) {
          return w;
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution
        // context; skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No overlay window whose url includes "view=command-bar" was found within 15s');
}

/**
 * The tab-view Page whose url includes `urlSubstring`. A tab renders in its own
 * WebContentsView that surfaces as its own Playwright Page. Mirrors
 * {@link sidebarWindow}: poll every open window, guarding a navigating view's
 * context with try/catch. The sidebar and overlay load the renderer (never the
 * 127.0.0.1 fixture), so they can never match a fixture url.
 */
async function tabWindow(app: ElectronApplication, urlSubstring: string): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(urlSubstring)) {
          return w;
        }
      } catch {
        // Navigating WebContentsView; retry next pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `No tab WebContentsView window whose url includes "${urlSubstring}" was found within 20s`,
  );
}

// --- Bridge helpers, each a live invoke round trip over the sidebar page. --------
// The cast helper is inlined at each call site because module-scope functions are
// not in scope in the serialized `page.evaluate` browser context.
function findState(sidebar: Page): Promise<FindStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.find.state();
  });
}

function openFind(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.find.open();
  });
}

function setFindQuery(sidebar: Page, text: string): Promise<void> {
  return sidebar.evaluate((t) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.find.setQuery(t);
  }, text);
}

function nextFind(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.find.next();
  });
}

function closeFind(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.find.close();
  });
}

function commandBarState(sidebar: Page): Promise<CommandBarStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

function openCommandBar(sidebar: Page, mode: string): Promise<void> {
  return sidebar.evaluate((m) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.open(m);
  }, mode);
}

function closeCommandBar(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.close();
  });
}

function createTab(sidebar: Page, url: string): Promise<BridgeTab> {
  return sidebar.evaluate((u) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.create(u);
  }, url);
}

function activateTab(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((tabId) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.activate(tabId);
  }, id);
}

/**
 * Poll the MAIN process until some WebContents has COMMITTED a url containing
 * `port` — i.e. the fixture tab's view has navigated to the loopback page.
 * `tabs.create`/`navigate` resolve pre-commit, so this gates find on a genuinely
 * loaded page rather than assuming the navigation finished.
 */
async function waitForFixtureCommit(app: ElectronApplication, port: number): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ webContents }, p) =>
            webContents.getAllWebContents().some((w) => w.getURL().includes(p)),
          String(port),
        ),
      { message: "expected the fixture tab's view to commit the loopback page" },
    )
    .toBe(true);
}

/** Give any async overlay focus/blur a chance to settle before a negative read. */
async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// A single Electron launch shared across the cases (cold start under xvfb/docker
// is expensive), plus one fixture tab pinned at the loopback page. The suite runs
// serially (workers: 1, describe.serial) and every case re-establishes its own
// precondition — fixture tab active, find and command bar closed — so no case
// leaks state into the next.
test.describe.serial("PRD 6.3 find in page (offline)", () => {
  let app!: ElectronApplication;
  let sidebar!: Page;
  let overlay!: Page;
  let server!: FixtureServer;
  let userDataDir!: string;
  let fixtureTabId!: string;
  let secondTabId: string | null = null;

  test.beforeAll(async () => {
    server = await startFixtureServer();
    userDataDir = mkdtempSync(join(tmpdir(), "zeo-find-"));
    // Mirror blocking.spec.ts / app.spec.ts: empty ELECTRON_RENDERER_URL forces
    // main's production loadFile path, ZEO_E2E=1 is headless test mode, and
    // --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs root).
    app = await electron.launch({
      args: [
        mainPath,
        "--user-data-dir=" + userDataDir,
        ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        ZEO_E2E: "1",
      },
    });
    sidebar = await sidebarWindow(app);
    overlay = await overlayWindow(app);

    const tab = await createTab(sidebar, `${server.base}/page.html`);
    fixtureTabId = tab.id;
    await activateTab(sidebar, fixtureTabId);
    await waitForFixtureCommit(app, server.port);
    // Belt-and-braces: confirm the fixture DOM is actually parsed (the marker text
    // is present) before any search runs, so the first findInPage cannot race the
    // parse and report a spurious 0.
    const tabPage = await tabWindow(app, String(server.port));
    await tabPage.getByText("needle").first().waitFor({ state: "attached", timeout: 20_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    await server?.close();
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  /**
   * Reset to a clean precondition for a case: close find and the command bar
   * (both idempotent) and re-activate the fixture tab, so each case starts with
   * the fixture tab active and both overlay surfaces closed regardless of what a
   * prior case left behind.
   */
  async function resetToFixture(): Promise<void> {
    await closeFind(sidebar);
    await closeCommandBar(sidebar);
    await activateTab(sidebar, fixtureTabId);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(false);
  }

  // Steps a–e: open, counter reports 1/3, next -> 2/3, previous -> 1/3, close.
  test("opens find, reports 1/3, cycles to 2/3 and back to 1/3, then closes", async () => {
    await resetToFixture();

    // a. Run find: the overlay shows the find input and the session is open.
    await openFind(sidebar);
    await expect(overlay.getByTestId("find-input")).toBeVisible();
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);

    // b. Commit the query `needle` through the main bridge (no debounce), then
    // select the first match with a directional search.
    //
    // NOTE on determinism: main's fresh search (`setQuery` -> findInPage with
    // `findNext:false`) does NOT emit a `found-in-page` event under this headless
    // xvfb Chromium (verified: it primes the find controller but reports no
    // count), whereas a directional search (findInPage with `findNext:true`, what
    // `next`/`previous` issue) reliably does. In the running app the user's
    // multi-keystroke typing issues several searches so the counter tracks live;
    // headlessly we drive the counter through the directional path, which
    // exercises the same found-in-page -> applyFindResult -> broadcast -> overlay
    // pipeline. The first `next` with no active match selects match 1 (1/3).
    await setFindQuery(sidebar, "needle");
    await nextFind(sidebar);
    await expect(overlay.getByTestId("find-count")).toHaveText("1/3");

    // c. Next (Enter on the find input -> the FindBar's onKeyDown -> find.next):
    // advances to the second match.
    await overlay.getByTestId("find-input").press("Enter");
    await expect(overlay.getByTestId("find-count")).toHaveText("2/3");

    // d. Previous (Shift+Enter -> find.previous): back to the first match.
    await overlay.getByTestId("find-input").press("Shift+Enter");
    await expect(overlay.getByTestId("find-count")).toHaveText("1/3");

    // e. Close (Escape -> find.close): the input is gone and the session closes.
    await overlay.getByTestId("find-input").press("Escape");
    await expect(overlay.getByTestId("find-input")).toHaveCount(0);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(false);
  });

  // Step f: switching to a different tab closes find (find never follows a switch).
  test("activating a different tab closes find", async () => {
    await resetToFixture();

    // A second tab to switch to. Creating it activates it, so re-activate the
    // fixture tab before opening find there — the switch that closes find is the
    // explicit tabs.activate below, not this setup.
    if (secondTabId === null) {
      const second = await createTab(sidebar, `${server.base}/page.html`);
      secondTabId = second.id;
    }
    await activateTab(sidebar, fixtureTabId);

    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(fixtureTabId);

    // Switch to the other tab: the session must close (no cross-tab find).
    await activateTab(sidebar, secondTabId);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(false);
    await expect(overlay.getByTestId("find-input")).toHaveCount(0);
  });

  // Step g: a query that appears nowhere on the page reads 0/0.
  test("a query with no matches reads 0/0", async () => {
    await resetToFixture();

    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);

    // First prove the pipeline is live with a real match total (3), so the 0/0
    // assertion below cannot pass vacuously off the fresh session's initial 0/0.
    // Counts are driven through the directional search (see the NOTE in the first
    // case). Assert the TOTAL, not the active ordinal: the Chromium find
    // controller's active-match cursor persists across sessions on the same
    // webContents, so the ordinal after the first `next` is order-dependent, but
    // the total for `needle` is always 3.
    await setFindQuery(sidebar, "needle");
    await nextFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).matchCount).toBe(3);

    // A query absent from the page: the directional search reports zero matches,
    // so both the ordinal and the total are 0 -> the counter reads 0/0.
    await setFindQuery(sidebar, "zzqqxx");
    await nextFind(sidebar);
    await expect(overlay.getByTestId("find-count")).toHaveText("0/0");
  });

  // Step h: the m2 find<->command-bar race. Opening the command bar closes find
  // WITHOUT the just-opened bar blur-closing itself; opening find closes the bar.
  test("opening the command bar closes find, and opening find closes the command bar", async () => {
    await resetToFixture();

    // --- Find open, then open the command bar over the same overlay. ---
    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);

    await openCommandBar(sidebar, "navigate");
    // Find closes on the surface switch...
    await expect.poll(async () => (await findState(sidebar)).open).toBe(false);
    // ...and the command bar must NOT have blur-closed itself. Let any async
    // overlay blur settle, then assert the bar is (still) open and find is closed.
    await settle(500);
    expect((await commandBarState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).open).toBe(false);

    // --- Reverse: with the command bar open, open find. ---
    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    await settle(500);
    expect((await commandBarState(sidebar)).open).toBe(false);
    expect((await findState(sidebar)).open).toBe(true);
    await expect(overlay.getByTestId("find-input")).toBeVisible();
  });
});
