import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// PRD 10.4 — every expected size and color comes from the same @zeo/core
// constant or function the renderer uses, never a copied literal.
import {
  BOTTOM_BAR_HEIGHT,
  FAVORITE_TILE_HEIGHT,
  FAVORITES_MAX,
  TAB_ROW_HEIGHT,
  URL_PILL_HEIGHT,
  spaceDotColor,
} from "@zeo/core";
import type {
  CommandBarMode,
  FavoriteContextMenuResult,
  SpaceTheme,
  TabContextMenuResult,
  TabsState,
  ZeoApi,
} from "@zeo/core";
import { waitForViewUrl, waitForViewsIdle } from "./helpers/view";

// Absolute path to the built Electron main entry (same layout as app.spec.ts).
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "spaces" | "commandBar" | "commands" | "favorites">;

/**
 * The renderer window that hosts the React sidebar. Copied from app.spec.ts:
 * each tab and the overlay surface as their own windows, so poll every open
 * window for the one exposing the sidebar.
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
        // A navigating WebContentsView can momentarily lose its execution
        // context; skip it this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/** A running loopback page server plus a promisified close. */
interface LocalPageServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Loopback HTTP server serving a trivial page at `/page.html` (the
 * app.spec.ts pattern): an ephemeral 127.0.0.1 port, so the tab commits
 * offline and its URL has the host the URL pill must show.
 */
async function startLocalPageServer(): Promise<LocalPageServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>zeo-e2e-sidebar</title>");
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
    throw new Error("local page server did not bind to an inet address");
  }
  const port = (address as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** The full broadcast state over the sidebar bridge. */
function readState(sidebar: Page): Promise<TabsState> {
  return sidebar.evaluate(() => (globalThis as unknown as { zeo: ZeoBridge }).zeo.tabs.list());
}

/** `{ open, mode }` of the command bar, read by an invoke round trip. */
function barState(sidebar: Page): Promise<{ open: boolean; mode: CommandBarMode }> {
  return sidebar.evaluate(async () => {
    const st = await (globalThis as unknown as { zeo: ZeoBridge }).zeo.commandBar.state();
    return { open: st.open, mode: st.mode };
  });
}

function closeBar(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => (globalThis as unknown as { zeo: ZeoBridge }).zeo.commandBar.close());
}

/** Creates a `data:` tab in the active space and returns its id. */
function createDataTab(sidebar: Page, token: string): Promise<string> {
  return sidebar.evaluate(async (tok) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.tabs.create("data:text/html,<title>" + tok + "</title>" + tok)).id;
  }, token);
}

/** Adds tab `tabId` (in the active space) to favorites; returns the favorite id. */
function addFavorite(sidebar: Page, tabId: string): Promise<string> {
  return sidebar.evaluate(async (id) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.favorites.add(id)).id;
  }, tabId);
}

/** Current favorite ids in display order. */
async function favoriteIds(sidebar: Page): Promise<string[]> {
  return (await readState(sidebar)).favorites.map((f) => f.id);
}

/**
 * Evaluates `fn` in the sidebar and resolves to the rejection message, or
 * `null` when the call resolved. Used for "this bridge call rejects".
 */
function rejection(sidebar: Page, body: string, arg: string): Promise<string | null> {
  return sidebar.evaluate(
    async ({ body: which, arg: value }) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        switch (which) {
          case "favorites.add":
            await zeo.favorites.add(value);
            break;
          case "tabs.archive":
            await zeo.tabs.archive(value);
            break;
          case "commands.run":
            await zeo.commands.run(value as Parameters<ZeoBridge["commands"]["run"]>[0]);
            break;
          default:
            throw new Error("unknown call " + which);
        }
        return null;
      } catch (err: unknown) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    { body, arg },
  );
}

/** Tab ids of the rows rendered inside section `testId`, in DOM order. */
function rowIds(sidebar: Page, testId: "unpinned-section" | "pinned-section"): Promise<string[]> {
  return sidebar
    .getByTestId(testId)
    .getByTestId("tab-item")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-tab-id") ?? ""));
}

function tile(sidebar: Page, favoriteId: string): Locator {
  return sidebar.locator(`[data-testid="favorite-tile"][data-favorite-id="${favoriteId}"]`);
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("element has no bounding box");
  }
  return box;
}

/** `#rrggbb` → the `rgb(r, g, b)` form `getComputedStyle` reports. */
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

test.describe("PRD 10.4 sidebar", () => {
  // Fresh launch per test against its own userData dir, like app.spec.ts: one
  // seeded tab, one space, no favorites.
  let app!: ElectronApplication;
  let sidebar!: Page;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), "zeo-e2e-sidebar-"));
    app = await electron.launch({
      args: [
        mainPath,
        "--user-data-dir=" + userDataDir,
        ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
    });
    sidebar = await sidebarWindow(app);
  });

  test.afterEach(async () => {
    await app?.close();
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = undefined;
    }
  });

  // --- URL pill ---------------------------------------------------------------

  test("the URL pill shows the loopback domain; it and View > Open Location open navigate mode", async () => {
    const server = await startLocalPageServer();
    try {
      const token = "zeo-pill-probe";
      await sidebar.evaluate(async (url) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.create(url);
      }, `${server.base}/page.html?probe=${token}`);
      await waitForViewUrl(app, token);

      const pill = sidebar.getByTestId("sidebar-url-pill");
      // Domain only: no port, no path, no query.
      await expect(pill).toHaveText("127.0.0.1");
      await expect(pill).toHaveAttribute("title", new RegExp(`/page\\.html\\?probe=${token}$`));

      await pill.click();
      await expect.poll(() => barState(sidebar)).toEqual({ open: true, mode: "navigate" });
      await closeBar(sidebar);
      await expect.poll(async () => (await barState(sidebar)).open).toBe(false);

      // Open Location lives in the View menu (not Tabs), so drive that submenu.
      await app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        const view = menu?.items.find((item) => item.label === "View");
        const item = view?.submenu?.items.find((i) => i.label === "Open Location");
        if (item == null) {
          throw new Error('no View > "Open Location" menu item');
        }
        (item.click as () => void)();
      });
      await expect.poll(() => barState(sidebar)).toEqual({ open: true, mode: "navigate" });
      await closeBar(sidebar);
    } finally {
      await server.close();
    }
  });

  test("in an empty space the URL pill shows the placeholder and opens new-tab mode", async () => {
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.createAndActivate("Empty");
    });
    await expect.poll(async () => (await readState(sidebar)).tabs.length).toBe(0);
    const pill = sidebar.getByTestId("sidebar-url-pill");
    await expect(pill).toHaveText("Search or enter address");

    await pill.click();
    await expect.poll(() => barState(sidebar)).toEqual({ open: true, mode: "new-tab" });
    await closeBar(sidebar);
  });

  test("sidebar boxes: pill 34, tab row 34, tile 48, bottom bar 32, space item at least 28 x 28", async () => {
    const favTab = await createDataTab(sidebar, "zeo-box-fav");
    await addFavorite(sidebar, favTab);
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(1);

    const pill = await boxOf(sidebar.getByTestId("sidebar-url-pill"));
    const row = await boxOf(sidebar.getByTestId("unpinned-section").getByTestId("tab-item").first());
    const tileBox = await boxOf(sidebar.getByTestId("favorite-tile").first());
    const bar = await boxOf(sidebar.locator(".bottom-bar"));
    const item = await boxOf(sidebar.getByTestId("space-item").first());

    expect(Math.round(pill.height)).toBe(URL_PILL_HEIGHT);
    expect(Math.round(row.height)).toBe(TAB_ROW_HEIGHT);
    expect(Math.round(tileBox.height)).toBe(FAVORITE_TILE_HEIGHT);
    expect(Math.round(bar.height)).toBe(BOTTOM_BAR_HEIGHT);
    expect(item.width).toBeGreaterThanOrEqual(28);
    expect(item.height).toBeGreaterThanOrEqual(28);
  });

  // --- Favorites ----------------------------------------------------------------

  test("adding a favorite renders one active tile and removes the row; the tab menu offers favorite", async () => {
    const tabId = await createDataTab(sidebar, "zeo-fav-add");
    await expect(
      sidebar.getByTestId("unpinned-section").locator(`[data-tab-id="${tabId}"]`),
    ).toHaveCount(1);

    // The row's context menu offers "Add to Favorites" before it is one.
    const menuIds = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const res: TabContextMenuResult = await zeo.tabs.showContextMenu(id, 0, 0);
      return res.items.map((i) => ({ id: i.id, label: i.label, enabled: i.enabled }));
    }, tabId);
    expect(menuIds.map((i) => i.id)).toContain("favorite");
    expect(menuIds.find((i) => i.id === "favorite")).toEqual({
      id: "favorite",
      label: "Add to Favorites",
      enabled: true,
    });

    await expect(sidebar.getByTestId("favorites-grid")).toHaveCount(0);
    const favId = await addFavorite(sidebar, tabId);

    const tiles = sidebar.getByTestId("favorite-tile");
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toHaveAttribute("data-favorite-id", favId);
    await expect(tiles.first()).toHaveAttribute("aria-current", "true");
    await expect(tiles.first()).toHaveAttribute("data-open", "true");
    await expect(
      sidebar.getByTestId("unpinned-section").locator(`[data-tab-id="${tabId}"]`),
    ).toHaveCount(0);
    // Favorite tabs never render as rows anywhere in the sidebar.
    await expect(sidebar.locator(`[data-testid="tab-item"][data-tab-id="${tabId}"]`)).toHaveCount(0);

    const state = await readState(sidebar);
    expect(state.tabs.find((t) => t.id === tabId)?.favoriteId).toBe(favId);
    expect(state.activeTabId).toBe(tabId);
  });

  test("a tile opens its own tab in a second space; switching back activates the original", async () => {
    const tabId = await createDataTab(sidebar, "zeo-fav-spaces");
    const favId = await addFavorite(sidebar, tabId);
    const firstSpace = (await readState(sidebar)).activeSpaceId;

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.createAndActivate("Second");
    });
    await expect.poll(async () => (await readState(sidebar)).tabs.length).toBe(0);
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "false");
    await expect(tile(sidebar, favId)).not.toHaveAttribute("aria-current", "true");

    await tile(sidebar, favId).click();
    await expect
      .poll(async () => {
        const st = await readState(sidebar);
        return st.tabs.map((t) => ({ favoriteId: t.favoriteId, active: t.id === st.activeTabId }));
      })
      .toEqual([{ favoriteId: favId, active: true }]);
    const secondTabId = (await readState(sidebar)).activeTabId;
    expect(secondTabId).not.toBe(tabId);
    await expect(tile(sidebar, favId)).toHaveAttribute("aria-current", "true");
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "true");

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
    }, firstSpace);
    await expect.poll(async () => (await readState(sidebar)).activeTabId).toBe(tabId);
    await expect(tile(sidebar, favId)).toHaveAttribute("aria-current", "true");
  });

  test("closing a favorite tab keeps the tile; a click reopens it; archiving it rejects", async () => {
    const tabId = await createDataTab(sidebar, "zeo-fav-close");
    const favId = await addFavorite(sidebar, tabId);
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "true");

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.close(id);
    }, tabId);
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "false");
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(1);
    expect(await favoriteIds(sidebar)).toEqual([favId]);

    await tile(sidebar, favId).click();
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "true");
    await expect(tile(sidebar, favId)).toHaveAttribute("aria-current", "true");
    const reopened = await readState(sidebar);
    const reopenedTab = reopened.tabs.find((t) => t.favoriteId === favId);
    expect(reopenedTab).toBeDefined();
    expect(reopened.activeTabId).toBe(reopenedTab?.id);

    const archiveError = await rejection(sidebar, "tabs.archive", reopenedTab?.id ?? "");
    expect(archiveError).toContain("Cannot archive a favorite tab");
    expect((await readState(sidebar)).tabs.some((t) => t.id === reopenedTab?.id)).toBe(true);
  });

  test("favorites cap at 12: a 13th add and tab.favorite both reject", async () => {
    const created = await sidebar.evaluate(async (max) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const favs: string[] = [];
      for (let i = 0; i < max; i += 1) {
        const tab = await zeo.tabs.create(`data:text/html,<title>cap-${i}</title>cap-${i}`);
        favs.push((await zeo.favorites.add(tab.id)).id);
      }
      const extra = await zeo.tabs.create("data:text/html,<title>cap-extra</title>cap-extra");
      return { favs, extra: extra.id };
    }, FAVORITES_MAX);
    // Not a command-bar guard: let the 13 data: tabs finish loading so their
    // title/favicon updates have landed and the grid is in its final render
    // before the assertions below.
    await waitForViewsIdle(app);
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(FAVORITES_MAX);
    expect(await favoriteIds(sidebar)).toEqual(created.favs);
    expect((await readState(sidebar)).activeTabId).toBe(created.extra);

    expect(await rejection(sidebar, "favorites.add", created.extra)).toContain(
      `Favorites are full: ${FAVORITES_MAX}`,
    );
    expect(await rejection(sidebar, "commands.run", "tab.favorite")).toContain(
      "command disabled in current context",
    );
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(FAVORITES_MAX);
    const after = await readState(sidebar);
    expect(after.favorites).toHaveLength(FAVORITES_MAX);
    expect(after.tabs.find((t) => t.id === created.extra)?.favoriteId).toBeNull();
  });

  test("favorites.remove drops the grid and returns each space's tab to the end of today", async () => {
    const seeded = (await readState(sidebar)).tabs.map((t) => t.id);
    expect(seeded).toHaveLength(1);
    const favTab = await createDataTab(sidebar, "zeo-rm-fav");
    const other = await createDataTab(sidebar, "zeo-rm-other");
    const favId = await addFavorite(sidebar, favTab);
    const firstSpace = (await readState(sidebar)).activeSpaceId;
    await expect.poll(() => rowIds(sidebar, "unpinned-section")).toEqual([seeded[0], other]);

    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.createAndActivate("Second");
    });
    const secondOther = await createDataTab(sidebar, "zeo-rm-second");
    await tile(sidebar, favId).click();
    await expect(tile(sidebar, favId)).toHaveAttribute("data-open", "true");
    const secondFav = (await readState(sidebar)).tabs.find((t) => t.favoriteId === favId)?.id;
    expect(secondFav).toBeDefined();
    await expect.poll(() => rowIds(sidebar, "unpinned-section")).toEqual([secondOther]);

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.favorites.remove(id);
    }, favId);
    await expect(sidebar.getByTestId("favorites-grid")).toHaveCount(0);
    await expect.poll(() => rowIds(sidebar, "unpinned-section")).toEqual([secondOther, secondFav]);

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
    }, firstSpace);
    await expect
      .poll(() => rowIds(sidebar, "unpinned-section"))
      .toEqual([seeded[0], other, favTab]);
    const state = await readState(sidebar);
    expect(state.favorites).toEqual([]);
    expect(state.tabs.every((t) => t.favoriteId === null)).toBe(true);
  });

  test("dragging the third tile onto the first gives [c, a, b]; a drop over the tab list is ignored", async () => {
    const tabs: string[] = [];
    const favs: string[] = [];
    for (const token of ["zeo-drag-a", "zeo-drag-b", "zeo-drag-c"]) {
      const id = await createDataTab(sidebar, token);
      tabs.push(id);
      favs.push(await addFavorite(sidebar, id));
    }
    const [a, b, c] = favs;
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(3);
    // Not a command-bar guard: let every load finish (these data: tabs and the
    // seeded tab) before the drags, so no late title/favicon update re-renders
    // the grid or the rows between measuring a box and dropping on it.
    await waitForViewsIdle(app);
    const todayBefore = await rowIds(sidebar, "unpinned-section");
    expect(todayBefore).toHaveLength(1);

    const dropMarks = sidebar.locator(".favorite-tile--drop-before, .favorite-tile--drop-after");

    // --- Review regression: drag tile a out of the grid and release it over the
    // tab list. Mid-drag the grid is dragging but no tile shows a drop bar; the
    // release reorders nothing.
    const aBox = await boxOf(tile(sidebar, a));
    const rowBox = await boxOf(sidebar.getByTestId("unpinned-section").getByTestId("tab-item").first());
    await sidebar.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2);
    await sidebar.mouse.down();
    await sidebar.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, { steps: 12 });
    await expect(sidebar.locator(".favorites-grid--dragging")).toHaveCount(1);
    await expect(dropMarks).toHaveCount(0);
    await sidebar.mouse.up();
    await expect(sidebar.locator(".favorites-grid--dragging")).toHaveCount(0);
    // The renderer's reorder invoke (if any) is queued before this list call.
    expect(await favoriteIds(sidebar)).toEqual([a, b, c]);
    expect(await rowIds(sidebar, "unpinned-section")).toEqual(todayBefore);

    // --- Drag tile c onto the leading half of tile a: insertion slot 0.
    const aNow = await boxOf(tile(sidebar, a));
    const cBox = await boxOf(tile(sidebar, c));
    await sidebar.mouse.move(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
    await sidebar.mouse.down();
    await sidebar.mouse.move(aNow.x + 4, aNow.y + aNow.height / 2, { steps: 12 });
    await expect(tile(sidebar, a)).toHaveClass(/favorite-tile--drop-before/);
    await sidebar.mouse.up();

    // The out-of-grid drop is proven ignored by the order check above; this
    // in-grid drag gives [c, a, b].
    await expect.poll(() => favoriteIds(sidebar)).toEqual([c, a, b]);
    await expect
      .poll(() =>
        sidebar
          .getByTestId("favorite-tile")
          .evaluateAll((els) => els.map((e) => e.getAttribute("data-favorite-id"))),
      )
      .toEqual([c, a, b]);
    await expect(dropMarks).toHaveCount(0);
  });

  test("the favorite context menu offers open, copyUrl, close and remove", async () => {
    const tabId = await createDataTab(sidebar, "zeo-fav-menu");
    const favId = await addFavorite(sidebar, tabId);

    const lastMenu = (): Promise<FavoriteContextMenuResult | null> =>
      sidebar.evaluate(
        () =>
          (globalThis as unknown as { __zeoLastFavoriteContextMenu?: FavoriteContextMenuResult })
            .__zeoLastFavoriteContextMenu ?? null,
      );
    expect(await lastMenu()).toBeNull();

    await tile(sidebar, favId).click({ button: "right" });
    await expect.poll(lastMenu).not.toBeNull();
    const res = (await lastMenu()) as FavoriteContextMenuResult;
    expect(res.favoriteId).toBe(favId);
    expect(res.items.map((i) => i.id)).toEqual(["open", "copyUrl", "close", "remove"]);
    expect(res.items.map((i) => i.label)).toEqual(["Open", "Copy URL", "Close Tab", "Remove from Favorites"]);
    // The active space has the favorite's tab open, so Close Tab is enabled.
    expect(res.items.every((i) => i.enabled)).toBe(true);

    // With the tab closed, Close Tab disables (direct bridge call, no popup).
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.close(id);
    }, tabId);
    const closed = await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.favorites.showContextMenu(id, 0, 0);
    }, favId);
    expect(closed.items.find((i) => i.id === "close")?.enabled).toBe(false);
  });

  // --- Clear --------------------------------------------------------------------

  test("Clear archives today's tabs of the active space only", async () => {
    const setup = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const initial = await zeo.tabs.list();
      const p = initial.tabs[0].id;
      await zeo.tabs.pin(p);
      const a = (await zeo.tabs.create("data:text/html,<title>clear-a</title>a")).id;
      const b = (await zeo.tabs.create("data:text/html,<title>clear-b</title>b")).id;
      const f = (await zeo.tabs.create("data:text/html,<title>clear-f</title>f")).id;
      const fav = (await zeo.favorites.add(f)).id;
      const second = await zeo.spaces.createAndActivate("Second");
      const c = (await zeo.tabs.create("data:text/html,<title>clear-c</title>c")).id;
      await zeo.spaces.activate(initial.activeSpaceId);
      // The active tab is a today tab, so Clear must archive it too.
      await zeo.tabs.activate(a);
      return { p, a, b, f, fav, c, secondId: second.id };
    });
    // Not a command-bar guard: let the data: tabs finish loading so their
    // title/favicon updates have landed and the rows are in their final render
    // before the section assertions and the Clear click.
    await waitForViewsIdle(app);
    await expect.poll(() => rowIds(sidebar, "unpinned-section")).toEqual([setup.a, setup.b]);
    await expect.poll(() => rowIds(sidebar, "pinned-section")).toEqual([setup.p]);

    const clear = sidebar.getByTestId("clear-today-button");
    await expect(clear).toBeEnabled();
    await clear.click();

    await expect(sidebar.getByTestId("unpinned-section").getByTestId("tab-item")).toHaveCount(0);
    await expect.poll(() => rowIds(sidebar, "pinned-section")).toEqual([setup.p]);
    await expect(tile(sidebar, setup.fav)).toHaveAttribute("data-open", "true");
    await expect(sidebar.getByTestId("archived-toggle")).toHaveAttribute("title", "Archived (2)");
    await expect(clear).toBeDisabled();
    const state = await readState(sidebar);
    expect(state.tabs.map((t) => t.id).sort()).toEqual([setup.p, setup.f].sort());
    expect(state.archived.map((t) => t.id).sort()).toEqual([setup.a, setup.b].sort());
    expect(state.activeTabId === setup.p || state.activeTabId === setup.f).toBe(true);

    // Nothing left to clear in this space: the command rejects.
    expect(await rejection(sidebar, "commands.run", "tabs.clearToday")).toContain(
      "command disabled in current context",
    );

    // The other space's today tab is untouched.
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
    }, setup.secondId);
    await expect.poll(async () => (await readState(sidebar)).tabs.map((t) => t.id)).toEqual([setup.c]);
    await expect(sidebar.getByTestId("clear-today-button")).toBeEnabled();
  });

  // --- Space dots -----------------------------------------------------------------

  test("the active space item is raised and its dot takes the single-stop theme color", async () => {
    const { firstId, second } = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const before = await zeo.spaces.list();
      const created = await zeo.spaces.create("Second");
      return { firstId: before.activeSpaceId, second: created.id };
    });
    const activeItem = sidebar.locator(`[data-testid="space-item"][data-space-id="${firstId}"]`);
    const otherItem = sidebar.locator(`[data-testid="space-item"][data-space-id="${second}"]`);
    await expect(activeItem).toHaveAttribute("aria-current", "true");
    await expect(activeItem).toHaveClass(/space-item--active/);
    await expect(otherItem).not.toHaveAttribute("aria-current", "true");
    const shadowOf = (loc: Locator): Promise<string> =>
      loc.evaluate((el) => getComputedStyle(el).boxShadow);
    await expect.poll(() => shadowOf(activeItem)).not.toBe("none");
    expect(await shadowOf(otherItem)).toBe("none");

    const theme: SpaceTheme = { stops: ["teal"], intensity: 1 };
    await sidebar.evaluate(
      async ({ id, theme: t }) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.setTheme(id, t);
      },
      { id: firstId, theme },
    );
    const expected = spaceDotColor(theme);
    if (expected === null) {
      throw new Error("a single-stop, intensity-1 theme has a dot color");
    }
    const dot = activeItem.getByTestId("space-dot");
    await expect(dot).toHaveAttribute("data-hue", "teal");
    await expect
      .poll(() => dot.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(hexToRgb(expected));
    // The active dot is the larger, 10px one.
    await expect.poll(async () => Math.round((await boxOf(dot)).width)).toBe(10);
  });

  // The active item is revealed by scrolling the
  // strip only. NOTE: in every layout reachable here (even the 400px minimum
  // window with 12 favorites and the archived panel open, which shrinks) the
  // bottom bar stays inside `.sidebar`, so the pre-fix `scrollIntoView` also
  // leaves `.sidebar` at 0 — this test pins the strip behaviour end to end;
  // `nearestScrollLeft` in Sidebar.test.tsx is what discriminates the fix.
  test("switching to an off-strip space scrolls the strip to reveal the active item", async () => {
    const lastId = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      let id = "";
      for (let i = 0; i < 14; i += 1) {
        id = (await zeo.spaces.create(`Strip ${i}`)).id;
      }
      return id;
    });
    await expect(sidebar.getByTestId("space-item")).toHaveCount(15);
    const strip = sidebar.getByTestId("space-switcher");
    // The strip really overflows, so the last item starts off-strip.
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);

    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(id);
    }, lastId);
    const lastItem = sidebar.locator(`[data-testid="space-item"][data-space-id="${lastId}"]`);
    await expect(lastItem).toHaveAttribute("aria-current", "true");

    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const inView = await lastItem.evaluate((el) => {
      const s = el.parentElement?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return s !== undefined && r.left >= s.left - 0.5 && r.right <= s.right + 0.5;
    });
    expect(inView).toBe(true);
    const sidebarScroll = await sidebar
      .locator(".sidebar")
      .evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
    expect(sidebarScroll).toEqual({ top: 0, left: 0 });
  });
});
