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
// (e2e is ESM, so no __dirname). Layout mirrors persistence.spec.ts / app.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// history tests touch (structurally compatible with @zeo/core's ZeoApi). Only the
// fields we assert on are load-bearing.
interface BridgeTab {
  id: string;
  url: string;
  title?: string;
}
interface BridgeTabsState {
  tabs: BridgeTab[];
  activeTabId: string | null;
}
// PRD 6.1 §1 — the two persisted history shapes, redeclared here (import-free of
// @zeo/core like the rest of this bridge). A search returns aggregated ENTRIES
// (one row per url with a lifetime `visitCount`); `recent` returns individual
// VISITS (one row per navigation).
interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}
interface HistoryVisit {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}
// PRD 4.2/6.1 — one command-bar suggestion row. The real @zeo/core `Suggestion`
// is a discriminated union; we key assertions off `kind` and (for the history and
// tab arms) the optional `url`. Redeclared minimal, url/title OPTIONAL.
interface BridgeSuggestion {
  kind: string;
  url?: string;
  title?: string;
}
interface CommandBarStateShape {
  open: boolean;
  mode: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    navigate(id: string, url: string): Promise<void>;
    close(id: string): Promise<void>;
    list(): Promise<BridgeTabsState>;
  };
  // PRD 6.1 §4 — the history query surface. `search`/`recent` clamp `limit` in
  // main; `deleteUrl` removes one entry (visits cascade); `clear` empties both.
  history: {
    search(query: string, limit?: number): Promise<HistoryEntry[]>;
    recent(limit?: number): Promise<HistoryVisit[]>;
    deleteUrl(url: string): Promise<void>;
    clear(): Promise<void>;
  };
  commandBar: {
    open(mode: string): Promise<void>;
    setQuery(text: string): Promise<void>;
    state(): Promise<CommandBarStateShape>;
    accept(index?: number, revision?: number): Promise<void>;
    close(): Promise<void>;
  };
  // PRD 4.3/6.1 — dispatches a registry command through main's single checked
  // boundary. `history.open` opens the bar in history mode (Cmd+Y is a NATIVE menu
  // accelerator that Playwright's synthetic keys cannot fire, so we run the command
  // directly instead).
  commands: {
    run(id: string): Promise<void>;
  };
}

/** A running loopback fixture server plus a promisified close. */
interface HistoryFixtureServer {
  base: string;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port serving the PRD
 * 6.1 §6 history fixtures, all `text/html; charset=utf-8`:
 *   - `/a.html`      `<title>Alpha page</title>`
 *   - `/b.html`      `<title>Beta page</title>`
 *   - `/notitle.html` valid HTML with NO `<title>` element
 * A `/a.html#x` request never reaches the server: the browser drops the fragment
 * before requesting, so it arrives here as `/a.html` (served as Alpha), which is
 * exactly the historyKey collapse the fragment case exercises. Loopback only, so
 * every recording is network-independent.
 */
async function startHistoryFixtureServer(): Promise<HistoryFixtureServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    const sendHtml = (markup: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(markup);
    };
    if (pathname === "/a.html") {
      sendHtml("<!doctype html><meta charset=utf-8><title>Alpha page</title><p>alpha</p>");
      return;
    }
    if (pathname === "/b.html") {
      sendHtml("<!doctype html><meta charset=utf-8><title>Beta page</title><p>beta</p>");
      return;
    }
    if (pathname === "/notitle.html") {
      // Valid HTML with NO <title> element: the recorded title must therefore be
      // url-derived (titleForUrl), never the previous page's title.
      sendHtml("<!doctype html><meta charset=utf-8><p>no title here</p>");
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
    throw new Error("history fixture server did not bind to an inet address");
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

/**
 * The renderer window that hosts the React sidebar. Copied from
 * persistence.spec.ts: `firstWindow()` cannot be trusted because each tab is a
 * separate WebContentsView that may also surface as a window, so poll every open
 * window for the one exposing the sidebar, guarding a navigating view's destroyed
 * execution context with try/catch.
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
 * The renderer window that hosts the command-bar overlay. Mirrors app.spec.ts:
 * poll every open window for the one exposing data-testid="command-bar". The
 * overlay page always renders (main drives visibility by showing/hiding its
 * hosting view), so its DOM is queryable whether or not the bar is open — which is
 * what lets us drive `Cmd+Backspace` as a real DOM key event into its input.
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
        // A navigating WebContentsView can momentarily lose its execution context.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="command-bar" was found within 15s');
}

/**
 * Launch the packaged Electron build against a temp userData dir. Mirrors
 * persistence.spec.ts's `launch`: empty ELECTRON_RENDERER_URL forces main's
 * production loadFile path, ZEO_E2E=1 puts main in headless test mode, and
 * --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs as root).
 * History needs no adblock filters, so this launch omits them.
 */
async function launch(
  userDataDir: string,
): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
    args: [
      mainPath,
      "--user-data-dir=" + userDataDir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/** The active tab's id (falling back to the first tab on a fresh launch). */
function activeTabId(sidebar: Page): Promise<string> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const st = await zeo.tabs.list();
    return st.activeTabId ?? st.tabs[0].id;
  });
}

/** Navigate a tab over the sidebar bridge (records synchronously in did-navigate). */
function navigate(sidebar: Page, id: string, url: string): Promise<void> {
  return sidebar.evaluate(
    async (args) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.navigate(args.id, args.url);
    },
    { id, url },
  );
}

/**
 * Navigate a history url and WAIT until its visit has been recorded before
 * returning. `tabs.navigate` resolves as soon as loadURL is CALLED, not when the
 * load commits, and firing the next navigation cancels a still-in-flight one
 * before its `did-navigate` fires — so back-to-back navigations would under-record.
 * Recording happens in main's did-navigate handler after the load commits, so we
 * poll `recent()` until it reaches the expected running visit count. Use this for
 * every recording navigation in a sequence; use plain `navigate` for non-history
 * urls (about:blank/data:) that record nothing.
 */
async function navigateAndRecord(
  sidebar: Page,
  id: string,
  url: string,
  expectedRecentLen: number,
): Promise<void> {
  await navigate(sidebar, id, url);
  await expect
    .poll(async () => (await recent(sidebar)).length, {
      message: `expected ${expectedRecentLen} recorded visit(s) after navigating ${url}`,
    })
    .toBe(expectedRecentLen);
}

/** `history.recent()` over the sidebar bridge. */
function recent(sidebar: Page): Promise<HistoryVisit[]> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.recent();
  });
}

/** `history.search(query)` over the sidebar bridge. */
function search(sidebar: Page, query: string): Promise<HistoryEntry[]> {
  return sidebar.evaluate(async (q) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.search(q);
  }, query);
}

/** `history.clear()` over the sidebar bridge. */
function clearHistory(sidebar: Page): Promise<void> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    await zeo.history.clear();
  });
}

/** The command-bar state over the sidebar bridge. */
function barState(sidebar: Page): Promise<CommandBarStateShape> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

/**
 * Return the active tab to a pristine, empty-history baseline: navigate it to
 * about:blank (a non-history url that records nothing and clears the tab's
 * last-key state) and then clear history. The seeded tab points at
 * https://example.com, which — if it ever commits under CI — would record a stray
 * visit; navigating away cancels that load and the clear removes any visit that
 * committed first, so every test starts from an empty, deterministic history.
 * Returns the active tab id for the test to drive.
 */
async function freshHistory(app: ElectronApplication, sidebar: Page): Promise<string> {
  const id = await activeTabId(sidebar);
  await navigate(sidebar, id, "about:blank");
  // Wait until the tab's WebContentsView has COMMITTED about:blank before
  // clearing. `tabs.navigate` resolves when loadURL is CALLED (not when it
  // commits) and the stored url is set optimistically, so neither confirms the
  // commit; the seeded https://example.com load could otherwise fire
  // did-navigate AFTER the clear and leave a stray visit. A recent()===0 poll
  // cannot fix this because it can pass before that delayed event runs. The tab
  // view surfaces as its own Playwright Page and only the seeded tab is ever
  // sent to about:blank (the app renderers are file://), so poll app.windows()
  // for a window whose committed url is exactly about:blank.
  await expect
    .poll(() => {
      for (const w of app.windows()) {
        try {
          if (w.url() === "about:blank") {
            return true;
          }
        } catch {
          // A navigating WebContentsView can momentarily lose its context.
        }
      }
      return false;
    })
    .toBe(true);
  await clearHistory(sidebar);
  expect(await recent(sidebar)).toEqual([]);
  return id;
}

// Each test owns its temp userData dir and loopback fixture server, torn down in
// `finally`. The config gives 60s per test; each cold Electron start under
// xvfb/docker is slow, so tests use a single launch except the relaunch case which
// needs two by construction. History writes are SYNCHRONOUS in the did-navigate
// handler (not the debounced state save), but recording happens on the navigation
// EVENT after a load commits, so assertions poll `recent()`/`search()` until they
// reflect the expected state rather than assuming a navigate() resolves instantly.
test.describe("PRD 6.1 history", () => {
  // §6 bullet 1: three navigations record three visits; the fragment collapses to
  // one entry (visitCount 2) at the fragment-stripped url; a `%` term is escaped.
  test("records visits, collapses a fragment to one entry, and escapes LIKE wildcards", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);
      // The fragment is dropped by the browser before the request; historyKey
      // strips it too, so this is a re-visit of /a.html, not a new url.
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html#x`, 3);

      // Three visits total (a, b, a) once the did-navigate events have all fired.
      expect((await recent(sidebar)).length).toBe(3);

      // One aggregated entry for alpha: visitCount 2, the page's real title, and
      // the url WITHOUT the fragment. Poll because the title lands via the async
      // page-title-updated event after the #x load commits.
      await expect
        .poll(
          async () => {
            const rows = await search(sidebar, "alpha");
            if (rows.length !== 1) {
              return null;
            }
            const row = rows[0];
            return { count: row.visitCount, title: row.title, url: row.url };
          },
          { message: "expected one alpha entry, visitCount 2, title 'Alpha page', no fragment" },
        )
        .toEqual({ count: 2, title: "Alpha page", url: `${server.base}/a.html` });

      // The LIKE-escape guarantee: a bare `%` term matches a LITERAL `%`, which no
      // recorded url/title contains, so the search is empty (not "match all").
      expect(await search(sidebar, "%")).toEqual([]);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 2: a navigate-mode history row navigates the active tab; once the
  // url is open in a tab the same query shows the tab row and dedupes the history
  // row for that url away.
  test("a navigate-mode history row navigates the active tab and then dedupes against the open tab", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      // Record an alpha visit, then move the active tab OFF /a.html (to
      // about:blank) so /a.html is not open — the history row must show, not be
      // deduped. Keeping the tab (rather than closing it) preserves an active tab,
      // so openCommandBar("navigate") stays in navigate mode instead of falling
      // back to new-tab mode (its no-active-tab downgrade). See the report note.
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      // Wait for the async page-title-updated to land the real title on the entry,
      // so the "alpha" query (which matches the title, not the loopback url) hits.
      await expect.poll(async () => (await search(sidebar, "alpha")).length).toBe(1);
      await navigate(sidebar, tabId, "about:blank");

      // Open navigate mode, type `alpha`, and locate the history row in the state.
      const opened = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("navigate");
        await zeo.commandBar.setQuery("alpha");
        const st = await zeo.commandBar.state();
        return {
          mode: st.mode,
          historyIndex: st.suggestions.findIndex((s) => s.kind === "history"),
        };
      });
      expect(opened.mode).toBe("navigate");
      expect(opened.historyIndex).toBeGreaterThanOrEqual(0);

      // The overlay actually rendered a data-kind="history" row.
      const cmd = await commandBarWindow(app);
      await expect(cmd.locator('[data-kind="history"]')).toHaveCount(1);

      // Accept the history row: in navigate mode it navigates the active tab.
      await sidebar.evaluate(async (idx) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.accept(idx);
      }, opened.historyIndex);

      await expect
        .poll(
          async () => {
            const st = await sidebar.evaluate(async () => {
              const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
              return zeo.tabs.list();
            });
            const active = st.tabs.find((t) => t.id === st.activeTabId);
            return active?.url ?? "";
          },
          { message: "expected accepting the history row to navigate the active tab to /a.html" },
        )
        .toContain("/a.html");

      // Make /a.html a BACKGROUND tab. The active tab is excluded from suggestions
      // (pre-existing suggest behavior — you are already there), so create another
      // tab to leave /a.html open but non-active. Wait for its real title so the
      // "alpha" query (matching the title, not the loopback url) hits the tab row.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.create("about:blank");
      });
      await expect
        .poll(
          async () => {
            const st = await sidebar.evaluate(async () => {
              const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
              return zeo.tabs.list();
            });
            return st.tabs.find((t) => t.url.includes("/a.html"))?.title ?? null;
          },
          { message: "expected the background /a.html tab to report its 'Alpha page' title" },
        )
        .toBe("Alpha page");

      // With /a.html now OPEN as a background tab, the same query shows the tab row
      // and NO history row for that url (the open tab wins the dedupe).
      const dedupe = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("navigate");
        await zeo.commandBar.setQuery("alpha");
        const st = await zeo.commandBar.state();
        return {
          hasTabForUrl: st.suggestions.some(
            (s) => s.kind === "tab" && (s.url ?? "").includes("/a.html"),
          ),
          hasHistoryForUrl: st.suggestions.some(
            (s) => s.kind === "history" && (s.url ?? "").includes("/a.html"),
          ),
        };
      });
      expect(dedupe.hasTabForUrl).toBe(true);
      expect(dedupe.hasHistoryForUrl).toBe(false);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 3: history mode lists recent entries with no navigate row 0, and
  // Cmd+Backspace on the selected row deletes that url while the bar stays open.
  test("history mode omits row 0 and Cmd+Backspace deletes the selected row", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);

      // Open history mode by RUNNING the command (Cmd+Y is a native accelerator
      // Playwright cannot fire); read back the pushed state.
      const opened = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commands.run("history.open");
        const st = await zeo.commandBar.state();
        const idx = st.selectedIndex >= 0 ? st.selectedIndex : 0;
        return {
          open: st.open,
          mode: st.mode,
          count: st.suggestions.length,
          allHistory: st.suggestions.every((s) => s.kind === "history"),
          anyNavigate: st.suggestions.some((s) => s.kind === "navigate"),
          selectedUrl: st.suggestions[idx]?.url ?? null,
        };
      });
      expect(opened.open).toBe(true);
      expect(opened.mode).toBe("history");
      expect(opened.count).toBe(2);
      // Only history rows, and no row-0 navigate/search action.
      expect(opened.allHistory).toBe(true);
      expect(opened.anyNavigate).toBe(false);
      expect(opened.selectedUrl).not.toBeNull();
      const selectedUrl = opened.selectedUrl as string;

      // Cmd+Backspace on the selected history row IS a DOM key event in the
      // overlay input (CommandBar.tsx onKeyDown), so Playwright CAN drive it. Wait
      // for the rows to render, focus the input, and press the chord. Row 0 is
      // selected by default (main set selectedIndex to 0).
      const cmd = await commandBarWindow(app);
      await expect(cmd.locator('[data-kind="history"]')).toHaveCount(2);
      await cmd.getByTestId("command-bar-input").focus();
      await cmd.keyboard.press("Meta+Backspace");

      // The selected url is gone from history...
      await expect
        .poll(async () => (await search(sidebar, "")).some((e) => e.url === selectedUrl), {
          message: "expected Cmd+Backspace to delete the selected history url",
        })
        .toBe(false);
      // ...and the bar stayed open (delete + re-query, not close).
      expect((await barState(sidebar)).open).toBe(true);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 4: recorded history survives a relaunch against the same userData
  // dir. History tables live outside writeState, so no debounce wait is needed —
  // but poll that the visits landed before closing launch #1.
  test("recorded history survives a relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    try {
      // --- Launch #1: record two visits, then park the tab on about:blank so the
      // restored tab in launch #2 records nothing on materialize. ---
      const first = await launch(userDataDir);
      try {
        const tabId = await freshHistory(first.app, first.sidebar);
        await navigateAndRecord(first.sidebar, tabId, `${server.base}/a.html`, 1);
        await navigateAndRecord(first.sidebar, tabId, `${server.base}/b.html`, 2);
        await navigate(first.sidebar, tabId, "about:blank");
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dir; the visits are still queryable. ---
      const second = await launch(userDataDir);
      try {
        // Assert by presence (not exact count): a restored tab that re-records a
        // url would only bump its visitCount, never lose the entry.
        await expect
          .poll(async () => (await search(second.sidebar, "alpha")).length, {
            message: "expected the alpha entry to survive relaunch",
          })
          .toBe(1);
        expect((await search(second.sidebar, "beta")).length).toBe(1);
        expect((await recent(second.sidebar)).length).toBeGreaterThanOrEqual(2);
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 5: clear() empties both recent() and search("").
  test("clear empties recent and search", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);

      await clearHistory(sidebar);
      expect(await recent(sidebar)).toEqual([]);
      expect(await search(sidebar, "")).toEqual([]);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Clearing history invalidates the per-tab record cache: an open tab whose
  // current url was just wiped re-records on the next same-key navigation
  // instead of being skipped by the last-key dedupe in recordNavigation.
  test("clearing history lets an open tab re-record its current url", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await clearHistory(sidebar);
      expect(await recent(sidebar)).toEqual([]);
      // The tab still displays /a.html; navigating to it again is a same-key
      // load. Without cache invalidation this would be skipped and recent()
      // would stay empty (the poll in navigateAndRecord would time out).
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 6: about:blank and data: navigations record nothing, and a return to
  // /a.html across those non-history hops records a NEW visit (the hop cleared the
  // tab's last-key state).
  test("about:blank and data navigations record nothing and a return records a fresh visit", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigate(sidebar, tabId, `${server.base}/a.html`);
      await expect
        .poll(async () => (await search(sidebar, "alpha"))[0]?.visitCount ?? 0)
        .toBe(1);

      // Neither of these is a history url: both record nothing AND clear the tab's
      // last recorded key, so the return below is a fresh visit rather than a skip.
      await navigate(sidebar, tabId, "about:blank");
      await navigate(sidebar, tabId, "data:text/html,<title>Data</title>hi");

      await navigate(sidebar, tabId, `${server.base}/a.html`);
      await expect
        .poll(async () => (await search(sidebar, "alpha"))[0]?.visitCount ?? 0, {
          message: "expected the return across about:blank/data: to record a new /a.html visit",
        })
        .toBe(2);

      // Exactly the two /a.html visits were recorded — the about:blank and data:
      // hops left no rows of their own.
      const visits = await recent(sidebar);
      expect(visits.length).toBe(2);
      expect(visits.every((v) => v.url === `${server.base}/a.html`)).toBe(true);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 7: a re-visit updates its OWN visit and the shared entry keeps the
  // current document's title (a.html -> b.html -> a.html).
  test("a re-visit updates its own visit and keeps the current title", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 3);

      await expect
        .poll(
          async () => {
            const rows = await search(sidebar, "alpha");
            if (rows.length !== 1 || rows[0].title !== "Alpha page") {
              return null;
            }
            return rows[0].visitCount;
          },
          { message: "expected the alpha entry at visitCount 2 with the current 'Alpha page' title" },
        )
        .toBe(2);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §6 bullet 8: a history->history navigation from a titled page to a title-less
  // page records the SECOND page's url-derived title, never the first page's title
  // (did-navigate clears hasRealTitle before recordNavigation reads it).
  test("a titled-to-titleless navigation records the second page's url-derived title", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-history-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      // /a.html emits its own title, setting the tab's hasRealTitle flag. Wait for
      // the real title to be recorded before navigating on.
      await navigate(sidebar, tabId, `${server.base}/a.html`);
      await expect
        .poll(async () => (await search(sidebar, "alpha"))[0]?.title ?? "")
        .toBe("Alpha page");

      // /notitle.html has no <title>, so its recorded title must be url-derived,
      // NOT the stale "Alpha page".
      await navigate(sidebar, tabId, `${server.base}/notitle.html`);
      const notitleUrl = `${server.base}/notitle.html`;
      await expect
        .poll(async () => (await recent(sidebar)).some((v) => v.url === notitleUrl), {
          message: "expected the /notitle.html visit to be recorded",
        })
        .toBe(true);

      const entries = await search(sidebar, "notitle");
      expect(entries.length).toBe(1);
      const title = entries[0].title;
      // The core PRD guarantee: the title-less page did NOT inherit the previous
      // page's title.
      expect(title).not.toBe("Alpha page");
      expect(title).not.toBe("Beta page");
      // It is url-derived. titleForUrl(key) returns `new URL(key).hostname`, i.e.
      // "127.0.0.1"; if Chromium instead emits a url-derived default for the
      // title-less document it still carries the host or the "notitle" path. Accept
      // any of those url-derived forms (never the previous page's title).
      expect(
        title === "127.0.0.1" || title.includes("127.0.0.1") || title.includes("notitle"),
      ).toBe(true);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
