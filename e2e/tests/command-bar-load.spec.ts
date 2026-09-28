// Issue #179 — a background tab's load must not disturb an open command bar.
//
// While the bar is open, a tab view's `did-finish-load` (and the url/title
// broadcasts around it) re-ranks the bar through `onStateApplied`. Before the
// fix that re-rank reset `selectedIndex` to 0, so a row the user had arrowed to
// was silently lost, and a loading view could steal native focus so the overlay
// blur handler closed the bar outright. The fix keeps the selected row by
// IDENTITY (`suggestionKey`) across a re-rank and keeps the bar open; a row
// click rendered against a list a background re-rank superseded (main keeps up to
// MAX_PREVIOUS_SUGGESTION_LISTS of them) is remapped to where that row now sits
// instead of being rejected as stale.
//
// The ACTIVE tab's view is visible under the overlay, so its load is the one
// that could steal native focus; the ACTIVE-tab test pins the contract for that case
// (bar open, overlay focused, same row, typing lands in the input). CDP key
// events reach the overlay page regardless of OS focus, and under xvfb a page's
// load may not take native focus at all, so that test does NOT guard the steal logic
// itself: command-bar-focus.test.ts does.
//
// These tests deliberately overlap a slow load with bar interaction (no
// waitForViewsIdle between opening the bar and the load finishing): a local
// loopback server holds `/slow` for SLOW_DELAY_MS so the load is provably in
// flight while the selection moves.
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Suggestion, ZeoApi } from "@zeo/core";
// PRD 9.1 — shared view poll helpers (VIEW_POLL_TIMEOUT_MS-bounded).
import {
  commandBarWindow,
  VIEW_POLL_TIMEOUT_MS,
  waitForViewUrl,
  waitForViewsIdle,
} from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname): e2e/tests -> repo root is two levels up.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "commandBar">;

/** How long the fixture server holds a `/slow` response before answering. */
const SLOW_DELAY_MS = 3_000;
/** The `<title>` the slow page commits with; the re-rank is keyed off it. */
const SLOW_TITLE = "Slow Loaded";

/** A running loopback fixture server. */
interface FixtureServer {
  base: string;
  close(): Promise<void>;
}

/**
 * Start an HTTP server on 127.0.0.1 (ephemeral port), modeled on
 * page-search.spec.ts's `startFixtureServer`. `/fast?n=X` answers immediately
 * with `<title>Fast X</title>` (distinct per tab, so every row is
 * distinguishable); `/slow` answers with `<title>Slow Loaded</title>` only after
 * {@link SLOW_DELAY_MS}. `no-store` so a navigation always re-fetches.
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const timers = new Set<NodeJS.Timeout>();
  const page = (title: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    };
    if (url.pathname === "/fast") {
      res.writeHead(200, headers);
      res.end(page(`Fast ${url.searchParams.get("n") ?? ""}`));
      return;
    }
    if (url.pathname === "/slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, headers);
        res.end(page(SLOW_TITLE));
      }, SLOW_DELAY_MS);
      timers.add(timer);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        // A held /slow request would otherwise keep close() waiting.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * The renderer window that hosts the React sidebar (where `window.zeo` drives
 * the store). Copied from app.spec.ts: `firstWindow()` cannot be trusted because
 * each tab view and the overlay surface as their own windows.
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
        // A navigating view's execution context can be momentarily destroyed.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/** The tab id of a `tab` suggestion, or null for any other row kind. */
function tabIdOf(s: Suggestion | undefined): string | null {
  return s !== undefined && s.kind === "tab" ? s.tabId : null;
}

/** How long a post-load state must hold, sampled every HOLD_SAMPLE_MS. */
const HOLD_MS = 500;
const HOLD_SAMPLE_MS = 50;

/**
 * Assert `read()` equals `expected` on every sample across {@link HOLD_MS}: a
 * one-shot read taken just before a deferred close (the overlay blur check runs
 * a `setTimeout(0)` later) would otherwise pass.
 */
async function expectHolds<T>(read: () => Promise<T>, expected: T, what: string): Promise<void> {
  const deadline = Date.now() + HOLD_MS;
  do {
    expect((await read()) as unknown, `${what} (must hold for ${HOLD_MS}ms)`).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, HOLD_SAMPLE_MS));
  } while (Date.now() < deadline);
}

/** Whether the live view whose url contains `sub` is currently loading. */
function viewLoading(app: ElectronApplication, sub: string): Promise<boolean | null> {
  return app.evaluate(({ webContents }, s) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(s));
    return wc === undefined || wc.isDestroyed() ? null : wc.isLoading();
  }, sub);
}

test.describe("command bar vs background load (#179)", () => {
  let app!: ElectronApplication;
  let sidebar!: Page;
  let server: FixtureServer | undefined;
  let userDataDir: string | undefined;

  /** Every tab created by {@link setUpTabs}, in creation order. */
  interface CreatedTab {
    id: string;
    url: string;
  }

  const barState = () =>
    sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.commandBar.state();
    });

  const activeTabId = () =>
    sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return (await zeo.tabs.list()).activeTabId;
    });

  /**
   * Create three fast tabs (the last one ends up active) and settle every load
   * BEFORE the bar opens: this is the deliberate pre-bar settle, not the race
   * under test. Returns the created tabs in creation order.
   */
  async function setUpTabs(): Promise<CreatedTab[]> {
    const base = server!.base;
    const created: CreatedTab[] = [];
    for (const n of [1, 2, 3]) {
      const url = `${base}/fast?n=${n}`;
      const tab = await sidebar.evaluate(async (u) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create(u);
      }, url);
      await waitForViewUrl(app, url);
      created.push({ id: tab.id, url });
    }
    await waitForViewsIdle(app);
    // tabs.create activates the new tab, so the last one is active and the
    // other two are background tabs.
    expect(await activeTabId()).toBe(created[2]!.id);
    return created;
  }

  /**
   * Open the bar in new-tab mode (empty query: recent NON-active open tabs,
   * most recently active first, no row 0) and wait for at least two rows.
   */
  async function openBar(): Promise<Page> {
    const overlay = await commandBarWindow(app);
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.open("new-tab");
    });
    await expect
      .poll(async () => (await barState()).suggestions.length, { timeout: VIEW_POLL_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);
    const rows = overlay.getByTestId("command-bar-suggestion");
    await expect
      .poll(() => rows.count(), { timeout: VIEW_POLL_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);
    return overlay;
  }

  /**
   * Start a navigation of the view whose url contains `sub` to `url`, from main,
   * WITHOUT awaiting it; then poll until that view reports `isLoading()` so the
   * caller provably overlaps the load. Works for a background or the active
   * (visible) view alike.
   */
  async function startLoad(sub: string, url: string): Promise<void> {
    await app.evaluate(
      ({ webContents }, [s, u]) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(s));
        if (wc === undefined) {
          throw new Error(`live view for ${s} not found`);
        }
        void wc.loadURL(u).catch(() => {});
      },
      [sub, url] as const,
    );
    await expect
      .poll(() => viewLoading(app, sub), {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: `expected the view ${sub} to be loading`,
      })
      .toBe(true);
  }

  test.beforeEach(async () => {
    server = await startFixtureServer();
    userDataDir = mkdtempSync(join(tmpdir(), "zeo-e2e-"));
    // Containerized (root) runs opt into --no-sandbox; the CI path is unchanged.
    const baseArgs = [mainPath, "--user-data-dir=" + userDataDir];
    const launchArgs =
      process.env.ZEO_E2E_NO_SANDBOX === "1" ? [...baseArgs, "--no-sandbox"] : baseArgs;
    app = await electron.launch({
      args: launchArgs,
      // Empty string forces main's production loadFile path; ZEO_E2E=1 is the
      // headless test mode.
      env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
    });
    sidebar = await sidebarWindow(app);
    // Deliberate: settle the seeded startup tab so the ONLY load in flight while
    // the bar is open is the one each test starts.
    await waitForViewsIdle(app);
  });

  test.afterEach(async () => {
    await app?.close();
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = undefined;
    }
  });

  test("a background load finishing keeps the bar open with the arrowed-to row selected", async () => {
    const tabs = await setUpTabs();
    const overlay = await openBar();
    const rows = overlay.getByTestId("command-bar-suggestion");

    // Recent order: fast 2 (row 0), fast 1 (row 1), then the seeded tab.
    const opened = await barState();
    expect(opened.open).toBe(true);
    expect(opened.selectedIndex).toBe(0);
    expect(tabIdOf(opened.suggestions[0])).toBe(tabs[1]!.id);
    expect(tabIdOf(opened.suggestions[1])).toBe(tabs[0]!.id);
    await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");

    // Slow-load the BACKGROUND tab at row 0 (fast 2). Keeping the selection on a
    // DIFFERENT row (row 1) makes a reset-to-0 observable: it would land on the
    // reloaded tab, not the kept one.
    const loadingSub = "/fast?n=2";
    await startLoad(loadingSub, `${server!.base}/slow`);

    // Arrow to row 1 in the overlay while the load is in flight.
    await overlay.getByTestId("command-bar-input").press("ArrowDown");
    await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
    const selectedText = (await rows.nth(1).textContent()) ?? "";
    expect(selectedText).toContain("Fast 1");

    const moved = await barState();
    expect(moved.selectedIndex).toBe(1);
    const keptTabId = tabIdOf(moved.suggestions[1]);
    expect(keptTabId).toBe(tabs[0]!.id);
    // Still overlapping: the selection moved BEFORE the load finished.
    expect(await viewLoading(app, loadingSub)).toBe(true);

    // Let the load finish: the view settles on the slow page and its title.
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("/slow"));
            return wc === undefined || wc.isDestroyed()
              ? null
              : { loading: wc.isLoading(), title: wc.getTitle() };
          }),
        { timeout: VIEW_POLL_TIMEOUT_MS, message: "expected the slow load to finish" },
      )
      .toEqual({ loading: false, title: SLOW_TITLE });

    // The re-rank ran: the bar's list now carries the reloaded tab's new title.
    await expect
      .poll(
        async () =>
          (await barState()).suggestions.some(
            (s) => s.kind === "tab" && s.tabId === tabs[1]!.id && s.title.includes(SLOW_TITLE),
          ),
        {
          timeout: VIEW_POLL_TIMEOUT_MS,
          message: "expected the bar to re-rank with the new title",
        },
      )
      .toBe(true);
    await expect(overlay.getByText(SLOW_TITLE)).toBeVisible();

    // The bar is still open and still on the SAME row by identity.
    const after = await barState();
    expect(after.open).toBe(true);
    const keptIndex = after.suggestions.findIndex((s) => tabIdOf(s) === keptTabId);
    expect(keptIndex).toBeGreaterThanOrEqual(0);
    expect(after.selectedIndex).toBe(keptIndex);
    expect(tabIdOf(after.suggestions[after.selectedIndex])).toBe(keptTabId);
    // ...and the overlay's highlighted row is that row.
    const selectedRow = overlay.locator(
      '[data-testid="command-bar-suggestion"][aria-selected="true"]',
    );
    await expect(selectedRow).toHaveCount(1);
    await expect(rows.nth(keptIndex)).toHaveAttribute("aria-selected", "true");
    await expect(selectedRow).toHaveText(selectedText);

    // Enter (keyboard accept, no revision) acts on the kept row: fast 1 becomes
    // active and the bar closes.
    await overlay.getByTestId("command-bar-input").press("Enter");
    await expect.poll(activeTabId, { timeout: VIEW_POLL_TIMEOUT_MS }).toBe(keptTabId);
    await expect
      .poll(async () => (await barState()).open, { timeout: VIEW_POLL_TIMEOUT_MS })
      .toBe(false);
  });

  test("an ACTIVE tab's load finishing keeps the overlay focused, the arrowed-to row selected, and typing in the bar", async () => {
    // The test above slow-loads a HIDDEN background tab, which can never take
    // native focus. The ACTIVE tab's view is visible under the overlay, so its
    // load is the one that could steal focus and blur-close the bar on a
    // desktop. This pins the CONTRACT only (bar open, overlay focused, same row,
    // typing lands in the input); it does not guard the steal logic: under xvfb
    // a page's load may not take native focus, and Playwright's keyboard goes over
    // CDP straight to the overlay page regardless of OS focus. The unit tests in
    // command-bar-focus.test.ts guard the steal logic.
    const tabs = await setUpTabs();
    const overlay = await openBar();
    const rows = overlay.getByTestId("command-bar-suggestion");
    const input = overlay.getByTestId("command-bar-input");

    // Recent order: fast 2 (row 0), fast 1 (row 1), then the seeded tab. Fast 3
    // is the active tab, so new-tab mode excludes it.
    const opened = await barState();
    expect(opened.open).toBe(true);
    expect(opened.selectedIndex).toBe(0);
    expect(tabIdOf(opened.suggestions[0])).toBe(tabs[1]!.id);
    expect(tabIdOf(opened.suggestions[1])).toBe(tabs[0]!.id);

    // Arrow to row 1 (fast 1) so a reset-to-0 would be observable.
    await input.press("ArrowDown");
    await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
    const selectedText = (await rows.nth(1).textContent()) ?? "";
    expect(selectedText).toContain("Fast 1");
    const moved = await barState();
    expect(moved.selectedIndex).toBe(1);
    const keptRow = moved.suggestions[1]!;
    expect(keptRow.kind).toBe("tab");
    const keptTabId = tabIdOf(keptRow);
    expect(keptTabId).toBe(tabs[0]!.id);

    // Slow-load the ACTIVE tab (fast 3) from main, not through the bar. The
    // distinguishing query string keeps this view's url unique while it loads.
    // Until the held response commits, the view still reports its old url, so
    // the in-flight checks locate it by that one.
    const activeSub = "/fast?n=3";
    const activeSlowSub = "/slow?active=3";
    expect(await activeTabId()).toBe(tabs[2]!.id);
    await startLoad(activeSub, `${server!.base}${activeSlowSub}`);
    // Still overlapping: the bar is open while the active view is still loading.
    expect((await barState()).open).toBe(true);
    expect(await viewLoading(app, activeSub)).toBe(true);

    // Let the load finish: the active view settles on the slow page and title.
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }, sub) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(sub));
            return wc === undefined || wc.isDestroyed()
              ? null
              : { loading: wc.isLoading(), title: wc.getTitle() };
          }, activeSlowSub),
        { timeout: VIEW_POLL_TIMEOUT_MS, message: "expected the active tab's slow load to finish" },
      )
      .toEqual({ loading: false, title: SLOW_TITLE });

    // Wait for MAIN to have processed the load: the store's active tab is still
    // fast 3 and now carries the slow page's title.
    await expect
      .poll(
        () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const st = await zeo.tabs.list();
            const active = st.tabs.find((t) => t.id === st.activeTabId);
            return { id: st.activeTabId, title: active?.title ?? null };
          }),
        {
          timeout: VIEW_POLL_TIMEOUT_MS,
          message: "expected main to record the active tab's new title",
        },
      )
      .toEqual({ id: tabs[2]!.id, title: SLOW_TITLE });

    // The overlay (located by its `view=command-bar` url, as page-search.spec.ts
    // does) holds native focus, not the page view that just finished loading.
    const overlayFocused = () =>
      app.evaluate(({ webContents }) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && w.getURL().includes("view=command-bar"));
        return wc === undefined ? null : wc.isFocused();
      });
    // The bar is open, on the kept row (kind + tab id), with the overlay focused.
    // The active tab is not a bar row, so its load does not reorder the list and
    // this cannot tell identity from index; the background-load tests cover the
    // identity remap. Settle first, then require it to HOLD so a deferred
    // blur-close cannot slip past a single read.
    const settled = async () => {
      const st = await barState();
      const sel = st.suggestions[st.selectedIndex];
      return {
        open: st.open,
        kind: sel?.kind ?? null,
        tabId: tabIdOf(sel),
        overlayFocused: await overlayFocused(),
      };
    };
    const expectedSettled = {
      open: true,
      kind: keptRow.kind,
      tabId: keptTabId,
      overlayFocused: true,
    };
    await expect
      .poll(settled, { timeout: VIEW_POLL_TIMEOUT_MS, message: "expected the bar to settle" })
      .toEqual(expectedSettled);
    await expectHolds(settled, expectedSettled, "bar open, kept row selected, overlay focused");
    const after = await barState();
    await expect(rows.nth(after.selectedIndex)).toHaveAttribute("aria-selected", "true");
    await expect(
      overlay.locator('[data-testid="command-bar-suggestion"][aria-selected="true"]'),
    ).toHaveText(selectedText);

    // Keystrokes sent to the overlay page reach the bar input: main's query and
    // the input's DOM value both carry them, and the bar stays open and focused.
    await expect(input).toBeFocused();
    await overlay.keyboard.type("fa");
    await expect(input).toHaveValue("fa");
    await expect
      .poll(async () => (await barState()).query, { timeout: VIEW_POLL_TIMEOUT_MS })
      .toBe("fa");
    const typed = async () => ({
      open: (await barState()).open,
      overlayFocused: await overlayFocused(),
    });
    await expectHolds(
      typed,
      { open: true, overlayFocused: true },
      "bar open and focused after typing",
    );
  });

  test("a row click rendered before a background load reorders the rows activates the clicked row by identity", async () => {
    const tabs = await setUpTabs();
    const overlay = await openBar();
    const rows = overlay.getByTestId("command-bar-suggestion");

    // Type "fast": row 0 is the search action, then the two NON-active fast tabs.
    // Both titles start with the term (tier 1), so recency breaks the tie:
    // [search, Fast 2, Fast 1]. (Fast 3 is active and excluded; the seeded tab
    // does not match; history rows for these urls are deduped by the open tabs.)
    await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.commandBar.setQuery("fast");
    });
    await expect
      .poll(async () => (await barState()).suggestions.map((s) => tabIdOf(s) ?? s.kind), {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: "expected [search, Fast 2, Fast 1] for the query",
      })
      .toEqual(["search", tabs[1]!.id, tabs[0]!.id]);
    await expect(rows).toHaveCount(3);

    const opened = await barState();
    const oldRevision = opened.revision;
    // Click target in the OLD list: row 1, Fast 2 — the tab about to reload.
    const clickedIndex = 1;
    const clickedTabId = tabIdOf(opened.suggestions[clickedIndex]);
    expect(clickedTabId).toBe(tabs[1]!.id);

    // Slow-load Fast 2 to a page whose TITLE no longer starts with "fast" (only
    // its url still contains it), so it drops to the substring tier and ranks
    // BELOW Fast 1. The real load re-ranks the open bar more than once (url
    // commit, title, finish); every one of those lists is background-superseded,
    // so the clicked revision stays remappable (MAX_PREVIOUS_SUGGESTION_LISTS).
    await startLoad("/fast?n=2", `${server!.base}/slow?fast=2`);
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("/slow"));
            return wc === undefined || wc.isDestroyed()
              ? null
              : { loading: wc.isLoading(), title: wc.getTitle() };
          }),
        { timeout: VIEW_POLL_TIMEOUT_MS, message: "expected the slow load to finish" },
      )
      .toEqual({ loading: false, title: SLOW_TITLE });

    // The re-rank REORDERED the rows: [search, Fast 1, Slow Loaded, ...]. (Fast
    // 2's old /fast?n=2 visit is no longer covered by an open tab, so a History
    // row for it may follow the Tabs group; only the leading rows are pinned.)
    // The old clickedIndex now points at a DIFFERENT tab (Fast 1), so resolving
    // the click by index would activate the wrong tab; only a remap by identity
    // is right.
    await expect
      .poll(
        async () => {
          const st = await barState();
          const reloaded = st.suggestions.find((s) => tabIdOf(s) === tabs[1]!.id);
          return {
            ids: st.suggestions.slice(0, 3).map((s) => tabIdOf(s) ?? s.kind),
            reloadedTitle: reloaded?.kind === "tab" ? reloaded.title : null,
          };
        },
        {
          timeout: VIEW_POLL_TIMEOUT_MS,
          message: "expected the background load to reorder the rows",
        },
      )
      .toEqual({ ids: ["search", tabs[0]!.id, tabs[1]!.id], reloadedTitle: SLOW_TITLE });
    const reranked = await barState();
    expect(reranked.open).toBe(true);
    expect(reranked.revision).not.toBe(oldRevision);
    expect(tabIdOf(reranked.suggestions[clickedIndex])).toBe(tabs[0]!.id);

    // The overlay accepts the old (index, revision) pair, exactly as a row click
    // rendered before the load would. It must RESOLVE, not reject as stale.
    const outcome = await overlay.evaluate(
      async ([index, revision]) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.commandBar.accept(index, revision);
          return "resolved";
        } catch (err) {
          return `rejected: ${String(err)}`;
        }
      },
      [clickedIndex, oldRevision] as const,
    );
    expect(outcome).toBe("resolved");

    // The row that was at clickedIndex in the OLD list (Fast 2) is the one
    // activated, not Fast 1, which sits at that index now.
    await expect.poll(activeTabId, { timeout: VIEW_POLL_TIMEOUT_MS }).toBe(clickedTabId);
    await expect
      .poll(async () => (await barState()).open, { timeout: VIEW_POLL_TIMEOUT_MS })
      .toBe(false);
  });
});
