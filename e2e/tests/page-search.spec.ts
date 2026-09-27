import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CommandBarMode,
  CommandBarState,
  FindState,
  Rect,
  Tab,
  TabsState,
  ZeoApi,
} from "@zeo/core";
// PRD 10.6 — the find pill geometry main applies; the assertions compare the
// live overlay bounds against these helpers, never a copied formula.
import {
  FIND_BAR_HEIGHT,
  FIND_BAR_SHADOW_MARGIN,
  contentRect,
  findAnchorRect,
  findBarBounds,
  splitPaneBounds,
} from "@zeo/core";
// PRD 9.1 — shared view-URL poll helper (VIEW_POLL_TIMEOUT_MS-bounded).
import { VIEW_POLL_TIMEOUT_MS, waitForViewUrl, waitForViewsIdle } from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts / app.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "commandBar" | "find" | "commands" | "chrome" | "splitView">;

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
function findState(sidebar: Page): Promise<FindState> {
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

function commandBarState(sidebar: Page): Promise<CommandBarState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

function openCommandBar(sidebar: Page, mode: CommandBarMode): Promise<void> {
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

function createTab(sidebar: Page, url: string): Promise<Tab> {
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
  await waitForViewUrl(app, String(port));
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
    // ...and the command bar must NOT have blur-closed itself: its input holds
    // focus and the bar is (still) open.
    await expect(overlay.getByTestId("command-bar-input")).toBeFocused();
    expect((await commandBarState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).open).toBe(false);

    // --- Reverse: with the command bar open, open find. ---
    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    await expect(overlay.getByTestId("find-input")).toBeFocused();
    expect((await commandBarState(sidebar)).open).toBe(false);
    expect((await findState(sidebar)).open).toBe(true);
  });
});

// --- PRD 10.6 find pill ----------------------------------------------------------

/** Launch against a fresh temp userData dir (mirrors the 6.3 suite's beforeAll). */
async function launch(dir: string): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
    args: [
      mainPath,
      "--user-data-dir=" + dir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

function tabsState(sidebar: Page): Promise<TabsState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd as Parameters<ZeoBridge["commands"]["run"]>[0]);
  }, id);
}

function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0].getContentSize();
    return { width, height };
  });
}

function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

/** The overlay child view's native bounds (located by its `view=command-bar` url). */
function overlayBounds(app: ElectronApplication): Promise<Rect | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (const child of win.contentView.children) {
      const wc = (child as { webContents?: { getURL(): string } }).webContents;
      if (wc != null && wc.getURL().includes("view=command-bar")) {
        const b = child.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
    return null;
  });
}

/**
 * The overlay rect main should apply for the LIVE state: the pill's
 * `findBarBounds` around the card that owns `state.find.tabId`.
 */
async function expectedFindBounds(app: ElectronApplication, sidebar: Page): Promise<Rect> {
  const [{ width, height }, state] = await Promise.all([contentSize(app), tabsState(sidebar)]);
  return findBarBounds(findAnchorRect(width, height, state.chrome, state.layout, state.find.tabId));
}

/** Poll until the overlay's native bounds equal {@link expectedFindBounds}; return them. */
async function expectFindBoundsMatch(
  app: ElectronApplication,
  sidebar: Page,
  message: string,
): Promise<Rect> {
  await expect
    .poll(
      async () => {
        const [bounds, want] = await Promise.all([
          overlayBounds(app),
          expectedFindBounds(app, sidebar),
        ]);
        return want.width > 0 && JSON.stringify(bounds) === JSON.stringify(want)
          ? "ok"
          : { bounds, want };
      },
      { message },
    )
    .toBe("ok");
  return (await overlayBounds(app))!;
}

/** The overlay page's find pill rect, its viewport, and its page background. */
function pillLook(overlay: Page): Promise<{
  pill: Rect;
  innerWidth: number;
  innerHeight: number;
  html: string;
  body: string;
}> {
  return overlay.getByTestId("find-bar").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      pill: { x: r.x, y: r.y, width: r.width, height: r.height },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/** A window whose url includes `sub` (the divider view), polled like tabWindow. */
async function windowByUrl(app: ElectronApplication, sub: string): Promise<Page> {
  const deadline = Date.now() + VIEW_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(sub)) {
          return w;
        }
      } catch {
        // Navigating view; retry next pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No window whose url includes "${sub}" was found`);
}

/**
 * Drag the split divider by `dx` px and return the new ratio. The same
 * renderer-acknowledged gesture as split.spec.ts's `dragDivider`: settle moves
 * repeat until the divider's `__zeoDivider` probe reports a ratio past the start
 * in the drag direction, then main's layout is polled to follow.
 */
async function dragDivider(divider: Page, sidebar: Page, dx: number): Promise<number> {
  const ratioOf = async (): Promise<number> => {
    const layout = (await tabsState(sidebar)).layout;
    if (layout.mode !== "split") {
      throw new Error(`expected a split layout, got ${layout.mode}`);
    }
    return layout.ratio;
  };
  const before = await ratioOf();
  const handle = divider.getByTestId("divider-handle");
  await handle.waitFor({ state: "visible" });
  const box = await handle.boundingBox();
  if (box === null) {
    throw new Error("divider handle had no bounding box");
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const dir = dx >= 0 ? 1 : -1;
  const seen = (): Promise<number | null> =>
    divider.evaluate(
      () => (globalThis as { __zeoDivider?: { ratio: number } }).__zeoDivider?.ratio ?? null,
    );
  for (let gesture = 0; gesture < 5; gesture += 1) {
    await divider.evaluate(() => {
      delete (globalThis as { __zeoDivider?: unknown }).__zeoDivider;
    });
    await divider.mouse.move(startX, startY);
    await divider.mouse.down();
    await divider.mouse.move(startX + dir * 4, startY, { steps: 3 });
    await divider.mouse.move(startX + dx, startY, { steps: 12 });
    let acknowledged = false;
    for (let attempt = 0; attempt < 20 && !acknowledged; attempt += 1) {
      await divider.mouse.move(startX + dx, startY);
      const ratio = await seen();
      acknowledged = ratio !== null && (dir > 0 ? ratio > before : ratio < before);
    }
    await divider.mouse.up();
    if (acknowledged) {
      await expect
        .poll(async () => {
          const r = await ratioOf();
          return dir > 0 ? r > before : r < before;
        })
        .toBe(true);
      return ratioOf();
    }
  }
  throw new Error(`divider drag was never acknowledged (start ratio ${before}, dx ${dx})`);
}

test.describe("PRD 10.6 find pill", () => {
  let app: ElectronApplication;
  let sidebar: Page;
  let server: FixtureServer | undefined;
  let dir: string | undefined;
  let launched = false;

  test.beforeEach(async () => {
    launched = false;
    server = await startFixtureServer();
    dir = mkdtempSync(join(tmpdir(), "zeo-find-pill-"));
    ({ app, sidebar } = await launch(dir));
    launched = true;
  });

  test.afterEach(async () => {
    if (launched) {
      await app.close();
    }
    await server?.close();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the overlay is findBarBounds(findAnchorRect(...)), the pill is inset on a transparent page, and it follows the sidebar", async () => {
    const overlay = await overlayWindow(app);
    const tab = await createTab(sidebar, `${server!.base}/page.html?probe=pill`);
    await activateTab(sidebar, tab.id);
    await waitForViewUrl(app, "probe=pill");
    await waitForViewsIdle(app);

    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(tab.id);
    const wide = await expectFindBoundsMatch(app, sidebar, "find bounds at the default chrome");

    // In the overlay page the pill is the view minus the shadow margin, 38 tall,
    // and the page itself paints nothing.
    await expect(overlay.getByTestId("find-bar")).toBeVisible();
    await expect
      .poll(async () => {
        const look = await pillLook(overlay);
        return look.innerWidth === wide.width && look.innerHeight === wide.height
          ? look
          : { stale: look, wide };
      })
      .toEqual({
        pill: {
          x: FIND_BAR_SHADOW_MARGIN,
          y: FIND_BAR_SHADOW_MARGIN,
          width: wide.width - 2 * FIND_BAR_SHADOW_MARGIN,
          height: FIND_BAR_HEIGHT,
        },
        innerWidth: wide.width,
        innerHeight: wide.height,
        html: "rgba(0, 0, 0, 0)",
        body: "rgba(0, 0, 0, 0)",
      });
    // The literal PRD shape: {16, 16, innerWidth − 32, 38}.
    const look = await pillLook(overlay);
    expect(look.pill).toEqual({ x: 16, y: 16, width: look.innerWidth - 32, height: 38 });

    // A narrow window with the widest sidebar: the card is narrower than the
    // 360 px pill plus its insets, so the pill shrinks to fit (the bounds now
    // depend on the chrome, which the collapse below then changes).
    await setContentSize(app, 640, 400);
    await sidebar.evaluate(() =>
      (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.setSidebarWidth(360),
    );
    const narrow = await expectFindBoundsMatch(app, sidebar, "find bounds after resize + width");
    expect((await tabsState(sidebar)).chrome.sidebarWidth).toBe(360);
    expect(narrow).not.toEqual(wide);

    await runCommand(sidebar, "view.toggleSidebar");
    expect((await tabsState(sidebar)).chrome.sidebarCollapsed).toBe(true);
    const collapsed = await expectFindBoundsMatch(app, sidebar, "find bounds after collapse");
    // The collapse widened the card, so the pill grew back: the relayout ran.
    expect(collapsed.width).toBeGreaterThan(narrow.width);
    expect((await findState(sidebar)).open).toBe(true);
  });

  test("in split, find anchors to the focused pane's card and follows a divider drag", async () => {
    // 900 wide: each pane is narrower than the pill plus insets, so a pane
    // anchor and the whole-content anchor give different bounds.
    await setContentSize(app, 900, 600);
    await expect.poll(() => contentSize(app)).toEqual({ width: 900, height: 600 });
    const left = await createTab(sidebar, "data:text/html,ZEOPILL_LEFT needle");
    const right = await createTab(sidebar, "data:text/html,ZEOPILL_RIGHT needle");
    await activateTab(sidebar, left.id);
    await sidebar.evaluate(
      (id) => (globalThis as unknown as { zeo: ZeoBridge }).zeo.splitView.splitWith(id),
      right.id,
    );
    await waitForViewUrl(app, "view=divider");
    await runCommand(sidebar, "view.focusOtherPane");
    let state = await tabsState(sidebar);
    if (state.layout.mode !== "split") {
      throw new Error(`expected a split layout, got ${state.layout.mode}`);
    }
    expect(state.layout.focused).toBe("right");
    expect(state.layout.right).toBe(right.id);
    await waitForViewsIdle(app);

    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(right.id);
    const before = await expectFindBoundsMatch(app, sidebar, "find bounds on the right pane");
    const { width: W, height: H } = await contentSize(app);
    const panes = splitPaneBounds(W, H, state.chrome, state.layout.ratio);
    expect(before).toEqual(findBarBounds(panes.right));
    expect(before).not.toEqual(findBarBounds(contentRect(W, H, state.chrome)));

    // Drag the divider right: the right pane narrows and the pill follows it.
    const divider = await windowByUrl(app, "view=divider");
    const ratio = await dragDivider(divider, sidebar, 100);
    expect(ratio).toBeGreaterThan(state.layout.ratio);
    const after = await expectFindBoundsMatch(app, sidebar, "find bounds after the divider drag");
    state = await tabsState(sidebar);
    if (state.layout.mode !== "split") {
      throw new Error(`expected a split layout, got ${state.layout.mode}`);
    }
    expect(after).toEqual(
      findBarBounds(splitPaneBounds(W, H, state.chrome, state.layout.ratio).right),
    );
    expect(after).not.toEqual(before);
    expect((await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(right.id);

    // Close find, focus the left pane, reopen: the pill sits on the left card.
    // (Whether a focus change closes find by itself is the next test's subject.)
    await closeFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(false);
    await runCommand(sidebar, "view.focusOtherPane");
    await waitForViewsIdle(app);
    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(left.id);
    const onLeft = await expectFindBoundsMatch(app, sidebar, "find bounds on the left pane");
    expect(onLeft).toEqual(
      findBarBounds(splitPaneBounds(W, H, state.chrome, state.layout.ratio).left),
    );
    expect(onLeft.x).toBeLessThan(after.x);
  });
  // PRD 10.6 §4 relies on "focus-pane changes already close find through
  // setActive", so the pill never outlives the card it belongs to. Pin it.
  test("focusing the other split pane closes an open find session", async () => {
    const left = await createTab(sidebar, "data:text/html,ZEOPILL_FOCUS_LEFT");
    const right = await createTab(sidebar, "data:text/html,ZEOPILL_FOCUS_RIGHT");
    await activateTab(sidebar, left.id);
    await sidebar.evaluate(
      (id) => (globalThis as unknown as { zeo: ZeoBridge }).zeo.splitView.splitWith(id),
      right.id,
    );
    await waitForViewUrl(app, "view=divider");
    await waitForViewsIdle(app);
    const layout = (await tabsState(sidebar)).layout;
    expect(layout.mode === "split" ? layout.focused : layout.mode).toBe("left");

    await openFind(sidebar);
    await expect.poll(async () => (await findState(sidebar)).open).toBe(true);
    expect((await findState(sidebar)).tabId).toBe(left.id);

    await runCommand(sidebar, "view.focusOtherPane");
    expect((await tabsState(sidebar)).activeTabId).toBe(right.id);
    await expect
      .poll(async () => (await findState(sidebar)).open, {
        message: "expected a pane-focus change to close the find session bound to the other pane",
      })
      .toBe(false);
  });
});
