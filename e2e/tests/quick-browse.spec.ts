import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
// PRD 9.1 — shared view-URL poll helper (VIEW_POLL_TIMEOUT_MS-bounded).
import { waitForViewUrl } from "./helpers/view";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts / settings.spec.ts /
// persistence.spec.ts: e2e/tests -> repo root is two levels up, then the desktop
// app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// PRD 7.2 quick-browse tests touch (structurally compatible with @zeo/core's ZeoApi).
// Only the fields we assert on are load-bearing.
interface QuickBrowseEntry {
  url: string;
  title: string;
}
interface BridgeTab {
  id: string;
  url: string;
  title?: string;
}
// PRD 6.5/7.2 — main attaches the current `settings` to the full snapshot returned
// by `tabs.list()`; `quickBrowseExternal` gates the external-link handoff.
interface BridgeSettings {
  searchEngine: string;
  quickBrowseExternal: boolean;
}
// PRD 7.2 — main attaches `quickBrowse` (the singleton entry, null when no
// quick-browse window is open) and `isDefaultBrowser` to the full snapshot.
interface BridgeState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  activeSpaceId: string;
  settings: BridgeSettings;
  quickBrowse: QuickBrowseEntry | null;
  isDefaultBrowser: boolean;
}
interface BridgeSpace {
  id: string;
  name: string;
}
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
}
// PRD 5.2 — the content-blocking slice, only the fields these tests read.
interface BlockingStateShape {
  enabled: boolean;
  allowlist: string[];
}
// PRD 4.2/7.2 — one command-bar suggestion row. The real @zeo/core `Suggestion`
// is a discriminated union; the `promote`-mode picker Test B drives lists only
// `{ kind: "space"; spaceId; name }` rows, so we redeclare a minimal structural
// view keying off `kind` and the optional `spaceId`/`name` (mirrors the same
// pattern in history.spec.ts).
interface BridgeSuggestion {
  kind: string;
  spaceId?: string;
  name?: string;
}
// PRD 4.2/7.2 — the command-bar state main broadcasts, redeclared as a structural
// slice of @zeo/core's `CommandBarState`. `revision` is the monotonic id of the
// current `suggestions` list: an accept that echoes the revision it read is
// rejected by main when the list has since changed (the staleness guard), so Test
// B reads it alongside the row index and passes it back exactly as the renderer does.
interface CommandBarStateShape {
  open: boolean;
  mode: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
  revision: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    navigate(id: string, url: string): Promise<void>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  settings: {
    get(): Promise<BridgeSettings>;
    setQuickBrowseExternal(enabled: boolean): Promise<void>;
  };
  quickBrowse: {
    state(): Promise<QuickBrowseEntry | null>;
    promote(): Promise<void>;
    dismiss(): Promise<void>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
  // PRD 4.2/7.2 — the command-bar surface Test B drives to pick a promote target.
  // `state()` reads back the pushed bar state; `accept(index, revision)` performs
  // the row at `index`, rejecting when `revision` no longer matches main's current
  // list (the clicked-row staleness guard). Only the two methods Test B uses are
  // declared; the shape is a structural view of @zeo/core's `CommandBarApi`.
  commandBar: {
    state(): Promise<CommandBarStateShape>;
    accept(index?: number, revision?: number): Promise<void>;
  };
  blocking: {
    allowSite(host: string): Promise<void>;
    state(): Promise<BlockingStateShape>;
  };
}

// A hardcoded 1x1 PNG (PNG signature, IHDR width=1 height=1) served for BOTH the
// allowed and the blocked image, so a loaded <img> yields naturalWidth === 1. The
// blocked request never reaches the server when the blocker is on (dropped in
// Electron before the fetch), so the same bytes prove "load" only when it is off.
// Copied from blocking.spec.ts's fixture.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

// The blocking fixture page (served at /page.html): two same-origin images plus
// load/error probes main can read. `allowed` should always load; `blocked` matches
// the fixture filter and loads ONLY when blocking is off (or the host is
// allowlisted). Both srcs are absolute paths on the fixture origin, so a missing
// /blocked/pixel.png request can ONLY mean the blocker dropped it. Mirrors
// blocking.spec.ts.
const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>zeo-quick-browse-block-fixture</title>
<img id="allowed" src="/allowed/ok.png">
<img id="blocked" src="/blocked/pixel.png">
<script>
  window.__img = { allowed: null, blocked: null };
  for (const key of ["allowed","blocked"]) {
    const el = document.getElementById(key);
    el.addEventListener("load", () => { window.__img[key] = "load"; });
    el.addEventListener("error", () => { window.__img[key] = "error"; });
  }
</script>`;

// A subresource-free page served at every OTHER *.html path — the non-blocking
// scenarios only observe the quick-browse url/window, never a subresource.
const SIMPLE_HTML = `<!doctype html><meta charset=utf-8><title>zeo-quick-browse-fixture</title><h1>zeo quick-browse fixture</h1>`;

// The PRD 5.1 §5 fixture filter: block any `/blocked/*` image request. Handed to
// the app via ZEO_ADBLOCK_FILTERS, which main's startup gate builds a fixture
// engine from (no cache/fetch/refresh — a fully offline, deterministic block list).
const FIXTURE_FILTER = "/blocked/*$image\n";

/** A running loopback fixture server plus the paths it has been asked for. */
interface FixtureServer {
  base: string;
  /** Every request path received (query stripped), in arrival order. */
  paths: string[];
  /** Count of recorded `/blocked/pixel.png` requests — proof the drop failed. */
  blockedHits(): number;
  /** Count of recorded `/allowed/ok.png` requests. */
  allowedHits(): number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port. Every request path
 * (query stripped) is recorded so a MISSING `/blocked/pixel.png` proves the blocker
 * dropped it before the fetch, and a PRESENT one proves it reached the server
 * (blocking off / allowlisted). `/page.html` serves the image-bearing blocking
 * fixture; every other `*.html` path serves the subresource-free page. Mirrors
 * blocking.spec.ts's loopback fixture.
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const paths: string[] = [];
  const png = Buffer.from(PNG_1X1_BASE64, "base64");
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    // Record BEFORE routing: a blocked request that reaches here must be counted.
    paths.push(pathname);
    if (pathname === "/allowed/ok.png" || pathname === "/blocked/pixel.png") {
      // no-store so a reload of the same URL always re-fetches (the allowlist
      // re-open scenario relies on repeated loads reaching here rather than
      // Chromium's HTTP cache).
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(png);
      return;
    }
    if (pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE_HTML);
      return;
    }
    if (pathname.endsWith(".html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(SIMPLE_HTML);
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
    paths,
    blockedHits: () => paths.filter((p) => p === "/blocked/pixel.png").length,
    allowedHits: () => paths.filter((p) => p === "/allowed/ok.png").length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Write the fixture filter list to a fresh temp dir; returns the file path. */
function writeFilterFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zeo-qb-filters-"));
  const file = join(dir, "filters.txt");
  writeFileSync(file, FIXTURE_FILTER, "utf8");
  return { file, dir };
}

/**
 * The renderer window that hosts the React sidebar. Copied from blocking.spec.ts /
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
 * The settings {@link Page}: main mounts the settings surface in its own
 * `WebContentsView` loaded with `?view=settings`, which surfaces as its own
 * Playwright window. Mirrors settings.spec.ts / blocking.spec.ts.
 */
async function settingsWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes("view=settings")) {
          return w;
        }
      } catch {
        // A loading WebContentsView's context can be momentarily destroyed; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    'No settings WebContentsView window whose url includes "view=settings" was found within 20s',
  );
}

/**
 * The tab-view page whose url includes `urlSubstring`. A tab (and the untrusted
 * quick-browse page view) renders in its own WebContentsView that surfaces as its
 * own Playwright Page; we identify it by a unique in-url probe token. Mirrors
 * blocking.spec.ts: poll every open window, guarding `url()` with try/catch since a
 * navigating view's context can be momentarily destroyed. The sidebar, settings
 * view, and quick-browse chrome load the renderer bundle (never the 127.0.0.1
 * fixture), so they can never match a fixture url.
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
    `No WebContentsView window whose url includes "${urlSubstring}" was found within 20s`,
  );
}

/**
 * Count the open quick-browse CHROME windows: the frameless renderer surface main
 * loads with `?view=quick-browse` (distinct from the untrusted page view, which
 * loads the fixture url). Guards a still-loading window's `url()` with try/catch.
 * Exactly one exists while a quick-browse window is open; zero when none is.
 */
function quickBrowseChromeCount(app: ElectronApplication): number {
  let count = 0;
  for (const w of app.windows()) {
    try {
      if (w.url().includes("view=quick-browse")) {
        count++;
      }
    } catch {
      // A loading WebContentsView's context can be momentarily destroyed; skip it.
    }
  }
  return count;
}

/** Poll until exactly one quick-browse chrome window exists, then return it. */
async function waitForQuickBrowseChrome(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() => quickBrowseChromeCount(app), {
      message: "expected exactly one quick-browse chrome window (view=quick-browse)",
      timeout: 20_000,
    })
    .toBe(1);
  for (const w of app.windows()) {
    try {
      if (w.url().includes("view=quick-browse")) {
        return w;
      }
    } catch {
      // fall through to the throw
    }
  }
  throw new Error("quick-browse chrome window vanished after the count poll");
}

/**
 * Emit the macOS default-browser handoff from the RUNNING app: synthesizes the
 * `open-url` event main listens for (PRD 7.2). The synthetic event carries a
 * `preventDefault` because main's handler calls it. Dispatched in the main process
 * so it goes through the exact same handoff path a real deep link would.
 */
async function emitOpenUrl(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, u) => {
    electronApp.emit("open-url", { preventDefault() {} }, u);
  }, url);
}

/** Read the singleton quick-browse entry (null when closed) over the sidebar bridge. */
function quickBrowseState(sidebar: Page): Promise<QuickBrowseEntry | null> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.quickBrowse.state();
  });
}

/** The full `tabs.list()` snapshot over the sidebar bridge. */
function tabsList(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

/** Read the current command-bar state over the sidebar bridge (PRD 4.2/7.2). */
function commandBarState(sidebar: Page): Promise<CommandBarStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

/** The observed <img> load/error probes for a blocking-fixture page. */
interface ImageProbes {
  allowed: string | null;
  blocked: string | null;
  allowedNaturalWidth: number;
}

/**
 * Wait until BOTH images on a `/page.html` fixture view have settled (fired load or
 * error), then read the probes plus the allowed image's naturalWidth. Runs in the
 * view's own page context. Mirrors blocking.spec.ts.
 */
async function readImageProbes(page: Page): Promise<ImageProbes> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __img?: { allowed: string | null; blocked: string | null } };
      return w.__img != null && w.__img.allowed !== null && w.__img.blocked !== null;
    },
    undefined,
    { timeout: 20_000 },
  );
  return page.evaluate(() => {
    const w = window as unknown as { __img: { allowed: string | null; blocked: string | null } };
    const el = document.getElementById("allowed") as HTMLImageElement | null;
    return {
      allowed: w.__img.allowed,
      blocked: w.__img.blocked,
      allowedNaturalWidth: el?.naturalWidth ?? -1,
    };
  });
}

/**
 * Launch the packaged Electron build against a temp userData dir. Mirrors
 * blocking.spec.ts / settings.spec.ts: empty ELECTRON_RENDERER_URL forces main's
 * production loadFile path, ZEO_E2E=1 puts main in headless test mode, and
 * --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs as root).
 * `extraEnv` threads the per-scenario hooks (ZEO_ADBLOCK_FILTERS, ZEO_QUICK_BROWSE_URL).
 */
async function launch(
  userDataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
    args: [
      mainPath,
      "--user-data-dir=" + userDataDir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1", ...extraEnv },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/**
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS so any debounced save
 * definitely lands on disk before a relaunch. A fixed sleep on a real debounce
 * timer is the correct instrument here, mirroring persistence.spec.ts.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

// Each test manages its OWN temp userData dir and loopback fixture server, so state
// never bleeds between scenarios. Every navigation is a loopback (127.0.0.1) fetch,
// so nothing reaches the network and the suite stays deterministic under headless
// xvfb with one worker. Assertions poll slice-specific state (quickBrowse.state(),
// tabs.list()) rather than a global broadcast counter, which unrelated pushes flake.
test.describe("PRD 7.2 quick-browse window (offline)", () => {
  // Scenario 1 (OPEN): the handoff opens exactly one quick-browse window on the
  // link, the pure entry reports the link, the untrusted page view loaded it, and
  // the chrome shows the untrusted url AS TEXT.
  test("open-url opens a single quick-browse window on the link and shows its url as text", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const fixtureA = `${server.base}/qb-open.html?probe=qb-open`;
      await emitOpenUrl(app, fixtureA);

      // Exactly ONE chrome window (view=quick-browse) appears.
      const chrome = await waitForQuickBrowseChrome(app);

      // The pure entry reports the link (poll: the initial open seeds the url and
      // the top-level commit confirms it — both equal fixtureA, no redirect).
      await expect
        .poll(async () => (await quickBrowseState(sidebar))?.url ?? null, {
          message: "expected quickBrowse.state().url === fixtureA",
        })
        .toBe(fixtureA);
      const entry = await quickBrowseState(sidebar);
      expect(entry).not.toBeNull();
      expect(typeof entry?.title).toBe("string");

      // The untrusted page view loaded fixtureA (its own WebContentsView surfaces
      // as a Page with the fixture url).
      const pageView = await tabWindow(app, "probe=qb-open");
      expect(pageView.url()).toContain("probe=qb-open");
      // waitForViewUrl polls the main process for the untrusted page view's live
      // url, bounded by the shared VIEW_POLL_TIMEOUT_MS (PRD 9.1).
      await waitForViewUrl(app, fixtureA);

      // The chrome renders the untrusted url as plain text (never an href/sink).
      await expect(chrome.getByTestId("quick-browse-url")).toHaveText(fixtureA, {
        timeout: 15_000,
      });
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 2 (REPLACE): a second link while a window is open replaces the url in
  // the SAME single window — no second window is stacked.
  test("a second open-url replaces the url in the single existing window", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const fixtureA = `${server.base}/qb-first.html?probe=qb-first`;
      const fixtureB = `${server.base}/qb-second.html?probe=qb-second`;

      await emitOpenUrl(app, fixtureA);
      await waitForQuickBrowseChrome(app);
      await expect.poll(async () => (await quickBrowseState(sidebar))?.url ?? null).toBe(fixtureA);

      // Replace: a different-path link navigates the existing window in place.
      await emitOpenUrl(app, fixtureB);
      await expect
        .poll(async () => (await quickBrowseState(sidebar))?.url ?? null, {
          message: "expected the single window's entry url to become fixtureB",
        })
        .toBe(fixtureB);

      // Still exactly ONE quick-browse window — no second window was created.
      expect(quickBrowseChromeCount(app)).toBe(1);
      // The untrusted page view navigated to fixtureB.
      const pageView = await tabWindow(app, "probe=qb-second");
      expect(pageView.url()).toContain("probe=qb-second");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 3 (TOGGLE OFF): with the setting off, an external link opens a normal
  // new tab in the active space instead of a quick-browse window.
  test("with quick-browse-external off, an external link opens a normal tab and no window", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      // Turn the toggle off and confirm it landed on the broadcast state before we
      // emit the link (serialize: the handoff branch reads settings.quickBrowseExternal).
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.settings.setQuickBrowseExternal(false);
      });
      await expect
        .poll(async () => (await tabsList(sidebar)).settings.quickBrowseExternal, {
          message: "expected settings.quickBrowseExternal to read false",
        })
        .toBe(false);

      const before = (await tabsList(sidebar)).tabs.length;
      const fixtureC = `${server.base}/qb-off.html?probe=qb-off`;
      await emitOpenUrl(app, fixtureC);

      // A new tab in the active space appears carrying the link.
      await expect
        .poll(async () => (await tabsList(sidebar)).tabs.some((t) => t.url.includes("probe=qb-off")), {
          message: "expected a normal tab carrying the external link",
        })
        .toBe(true);
      const after = await tabsList(sidebar);
      expect(after.tabs.length).toBe(before + 1);

      // No quick-browse window opened, and no pure entry exists. The tab's presence
      // proves the handoff branch already ran, so a zero count here is deterministic.
      expect(quickBrowseChromeCount(app)).toBe(0);
      expect(await quickBrowseState(sidebar)).toBeNull();
      // (No reset needed: this test does not reuse the app.)
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 4 (PROMOTE): promoting adopts the link into the active space as a
  // normal tab and tears the window down.
  test("promote adopts the link into the active space and closes the window", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const fixture = `${server.base}/qb-promote.html?probe=qb-promote`;
      await emitOpenUrl(app, fixture);
      await waitForQuickBrowseChrome(app);
      await expect.poll(async () => (await quickBrowseState(sidebar))?.url ?? null).toBe(fixture);

      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.quickBrowse.promote();
      });

      // A tab carrying the link exists in the active space.
      await expect
        .poll(async () => (await tabsList(sidebar)).tabs.some((t) => t.url.includes("probe=qb-promote")), {
          message: "expected a promoted tab carrying the link",
        })
        .toBe(true);
      // The window is gone and the pure entry is null.
      await expect
        .poll(() => quickBrowseChromeCount(app), {
          message: "expected the quick-browse window to close after promote",
        })
        .toBe(0);
      await expect.poll(() => quickBrowseState(sidebar)).toBeNull();
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 5 (DISMISS): dismissing throws the link away — no tab is created — and
  // a repeated dismiss is a safe, idempotent no-op.
  test("dismiss discards the link with no tab, and a repeated dismiss is a safe no-op", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const fixture = `${server.base}/qb-dismiss.html?probe=qb-dismiss`;
      await emitOpenUrl(app, fixture);
      await waitForQuickBrowseChrome(app);
      await expect.poll(async () => (await quickBrowseState(sidebar))?.url ?? null).toBe(fixture);

      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.quickBrowse.dismiss();
      });

      // The window is gone and the pure entry is null.
      await expect
        .poll(() => quickBrowseChromeCount(app), {
          message: "expected the quick-browse window to close after dismiss",
        })
        .toBe(0);
      await expect.poll(() => quickBrowseState(sidebar)).toBeNull();
      // No tab was created for the discarded link.
      expect((await tabsList(sidebar)).tabs.some((t) => t.url.includes("probe=qb-dismiss"))).toBe(
        false,
      );

      // Dismiss AGAIN: a safe, idempotent no-op — resolves without throwing and the
      // state stays null (exercises the single-flight/idempotent teardown observably).
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.quickBrowse.dismiss();
      });
      expect(await quickBrowseState(sidebar)).toBeNull();
      expect(quickBrowseChromeCount(app)).toBe(0);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 6 (RELAUNCH persistence): nothing quick-browse survives a relaunch —
  // no window, no tab, and a null entry.
  test("nothing quick-browse survives a relaunch with the same user-data-dir", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const fixture = `${server.base}/qb-relaunch.html?probe=qb-relaunch`;

    // --- Launch #1: open a quick-browse window, flush any debounced save, close. ---
    const first = await launch(userDataDir);
    try {
      await emitOpenUrl(first.app, fixture);
      await waitForQuickBrowseChrome(first.app);
      await expect
        .poll(async () => (await quickBrowseState(first.sidebar))?.url ?? null)
        .toBe(fixture);
      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    // --- Launch #2: same dir, no cold-launch drain env. Nothing quick-browse. ---
    const second = await launch(userDataDir);
    try {
      // No window, no persisted entry.
      expect(quickBrowseChromeCount(second.app)).toBe(0);
      expect(await quickBrowseState(second.sidebar)).toBeNull();
      // No tab was created for the quick-browse link (it was never promoted).
      expect(
        (await tabsList(second.sidebar)).tabs.some((t) => t.url.includes("probe=qb-relaunch")),
      ).toBe(false);
    } finally {
      await second.app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 7 (COLD-LAUNCH drain): a link queued before the window existed
  // (ZEO_QUICK_BROWSE_URL) drains once startup finishes, opening the window.
  test("a link queued at cold launch drains into a quick-browse window on startup", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const fixture = `${server.base}/qb-cold.html?probe=qb-cold`;
    // The e2e cold-launch hook (gated on ZEO_E2E === "1") pushes this url onto the
    // SAME pendingExternalLinks queue a pre-ready open-url would, drained after the
    // window and settings exist.
    const { app, sidebar } = await launch(userDataDir, { ZEO_QUICK_BROWSE_URL: fixture });
    try {
      await waitForQuickBrowseChrome(app);
      await expect
        .poll(async () => (await quickBrowseState(sidebar))?.url ?? null, {
          message: "expected the queued cold-launch link to open a quick-browse window",
        })
        .toBe(fixture);
      const pageView = await tabWindow(app, "probe=qb-cold");
      expect(pageView.url()).toContain("probe=qb-cold");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 8 (BLOCKING on the ephemeral session): the quick-browse page view is
  // filtered on its throwaway session exactly like a space tab, and allowlisting its
  // host + re-opening lets the previously-blocked pixel through — same allowlist
  // semantics. Deterministic: loopback origin, offline fixture engine, same probe
  // technique as blocking.spec.ts.
  test("content blocking applies to the quick-browse ephemeral session and honors the allowlist", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const filters = writeFilterFile();
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, { ZEO_ADBLOCK_FILTERS: filters.file });
    try {
      // Open a quick-browse window on the blocking fixture (blocking on by default).
      const urlBlocked = `${server.base}/page.html?probe=qb-block1`;
      await emitOpenUrl(app, urlBlocked);
      await waitForQuickBrowseChrome(app);
      const blockedPage = await tabWindow(app, "probe=qb-block1");
      const probesBlocked = await readImageProbes(blockedPage);
      // The blocked pixel was dropped on the ephemeral session; the allowed one loaded.
      expect(probesBlocked.allowed).toBe("load");
      expect(probesBlocked.allowedNaturalWidth).toBe(1);
      expect(probesBlocked.blocked).toBe("error");
      // The server never saw the same-origin blocked request — dropped in Electron.
      expect(server.allowedHits()).toBeGreaterThanOrEqual(1);
      expect(server.blockedHits()).toBe(0);

      // Allowlist the fixture host — the shared engine's bypass reads the live set,
      // and it is attached to the quick-browse ephemeral session too.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.blocking.allowSite("127.0.0.1");
      });
      expect((await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.blocking.state();
      })).allowlist).toContain("127.0.0.1");

      // Re-open the link in the SAME window (a second open-url reloads the page view
      // on the same ephemeral session): now allowlisted, the pixel loads through.
      const urlAllowed = `${server.base}/page.html?probe=qb-block2`;
      await emitOpenUrl(app, urlAllowed);
      const allowedPage = await tabWindow(app, "probe=qb-block2");
      const probesAllowed = await readImageProbes(allowedPage);
      expect(probesAllowed.allowed).toBe("load");
      expect(probesAllowed.blocked).toBe("load");
      // The blocked request now reached the server (the drop is bypassed).
      expect(server.blockedHits()).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });

  // Scenario 9 (SETTINGS UI): the General section reflects and drives the persisted
  // toggle, and the default-browser button reflects isDefaultBrowser (false in the
  // harness → an enabled "Set zeo as default browser" button).
  test("General settings reflect and drive the quick-browse toggle and the default-browser button", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      // Open settings straight to General.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commands.run("settings.openGeneral");
      });
      const settings = await settingsWindow(app);
      await expect(settings.getByTestId("settings")).toHaveCount(1);

      // The checkbox reflects the persisted value (true by default → checked).
      const checkbox = settings.getByTestId("settings-quick-browse-external");
      await expect(checkbox).toBeChecked();

      // Toggling it off updates the broadcast settings slice.
      await checkbox.click();
      await expect
        .poll(async () => (await tabsList(sidebar)).settings.quickBrowseExternal, {
          message: "expected the toggle click to flip settings.quickBrowseExternal to false",
        })
        .toBe(false);
      await expect(checkbox).not.toBeChecked();

      // The default-browser button exists and reflects isDefaultBrowser (false in
      // the harness → the "Set zeo as default browser" label, and NOT disabled). We
      // do NOT click it — setAsDefaultProtocolClient is environment-dependent.
      const defaultBtn = settings.getByTestId("settings-default-browser");
      await expect(defaultBtn).toHaveCount(1);
      expect((await tabsList(sidebar)).isDefaultBrowser).toBe(false);
      await expect(defaultBtn).toHaveText("Set zeo as default browser");
      await expect(defaultBtn).toBeEnabled();
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 10 (OPEN-IN-TAB): quickBrowse.openInTab keeps the link on a NEW
  // background tab in the ACTIVE space WITHOUT stealing activation, and LEAVES the
  // quick-browse window open. This is the distinguishing contract from promote
  // (which activates the new tab AND tears the window down): a background adopt.
  test("openInTab creates a background tab in the active space and leaves the window open", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const fixture = `${server.base}/qb-open-in-tab.html?probe=qb-open-in-tab`;
      await emitOpenUrl(app, fixture);
      await waitForQuickBrowseChrome(app);
      await expect
        .poll(async () => (await quickBrowseState(sidebar))?.url ?? null, {
          message: "expected quickBrowse.state().url === fixture before openInTab",
        })
        .toBe(fixture);

      // Snapshot the active-space tab set BEFORE the action: a fresh launch has one
      // seeded, active default tab. openInTab must add a tab without moving activation.
      const before = await tabsList(sidebar);
      const beforeActiveId = before.activeTabId;
      const beforeCount = before.tabs.length;

      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commands.run("quickBrowse.openInTab");
      });

      // A NEW tab carrying the link appears in the active space (poll: create + the
      // re-activation of the previous tab both complete before the broadcast).
      await expect
        .poll(
          async () => (await tabsList(sidebar)).tabs.some((t) => t.url.includes("probe=qb-open-in-tab")),
          { message: "expected a background tab carrying the quick-browse link" },
        )
        .toBe(true);
      const after = await tabsList(sidebar);
      // Exactly one tab was added...
      expect(after.tabs.length).toBe(beforeCount + 1);
      // ...and it did NOT steal activation: the pre-action active tab is still active.
      expect(after.activeTabId).toBe(beforeActiveId);

      // The quick-browse window STAYS open and the pure entry is still present — the
      // key distinction from promote/dismiss, which close the window. The probe tab
      // above already proves the handler ran and broadcast, so these are deterministic
      // (openInTab never touches the window).
      expect(quickBrowseChromeCount(app)).toBe(1);
      expect(await quickBrowseState(sidebar)).not.toBeNull();
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Scenario 11 (PROMOTE-TO-SPACE): quickBrowse.promoteToSpace opens the command
  // bar in "promote" mode (a space picker); accepting a chosen space row adopts the
  // link into THAT space (which becomes active) and tears the window down. A second,
  // non-active space is the target, so a link landing there proves promotion follows
  // the PICKED row, not merely the previously-active space.
  test("promoteToSpace adopts the link into the chosen space via the command bar and closes the window", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-qb-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      // A distinct promote target. spaces.create never switches the active space, so
      // the original stays active — a link landing in Target proves the picked row won.
      const target = await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("Target Space");
      });
      const originalActiveSpaceId = (await tabsList(sidebar)).activeSpaceId;
      expect(originalActiveSpaceId).not.toBe(target.id);

      const fixture = `${server.base}/qb-promote-space.html?probe=qb-promote-space`;
      await emitOpenUrl(app, fixture);
      await waitForQuickBrowseChrome(app);
      await expect
        .poll(async () => (await quickBrowseState(sidebar))?.url ?? null, {
          message: "expected quickBrowse.state().url === fixture before promoteToSpace",
        })
        .toBe(fixture);

      // Open the promote picker (openCommandBar ranks its suggestions synchronously).
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commands.run("quickBrowse.promoteToSpace");
      });

      // The bar is open in "promote" mode listing space-only rows for BOTH spaces.
      await expect
        .poll(
          async () => {
            const st = await commandBarState(sidebar);
            return (
              st.open &&
              st.mode === "promote" &&
              st.suggestions.length >= 2 &&
              st.suggestions.every((s) => s.kind === "space")
            );
          },
          { message: 'expected the command bar open in "promote" mode with space rows' },
        )
        .toBe(true);

      // Accept the Target Space row against the revision the state reports (mirrors
      // the renderer's clicked-row accept + staleness guard). Reading the state and
      // accepting in ONE evaluate keeps the revision from drifting between the two
      // invokes; in promote mode the space-only list is stable, so the guard passes.
      const acceptedIndex = await sidebar.evaluate((targetId) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commandBar.state().then((st) => {
          const index = st.suggestions.findIndex(
            (s) => s.kind === "space" && s.spaceId === targetId,
          );
          if (index === -1) {
            return -1;
          }
          return zeo.commandBar.accept(index, st.revision).then(() => index);
        });
      }, target.id);
      expect(acceptedIndex).toBeGreaterThanOrEqual(0);

      // The link landed in the TARGET space: promote-to-space makes it active, and
      // the snapshot's space-scoped `tabs` (the active space's set) carries the probe.
      await expect
        .poll(async () => (await tabsList(sidebar)).activeSpaceId, {
          message: "expected the target space to become active after promote-to-space",
        })
        .toBe(target.id);
      await expect
        .poll(
          async () => (await tabsList(sidebar)).tabs.some((t) => t.url.includes("probe=qb-promote-space")),
          { message: "expected the promoted tab to carry the link in the target space" },
        )
        .toBe(true);

      // The quick-browse window is gone and the pure entry is null.
      await expect
        .poll(() => quickBrowseChromeCount(app), {
          message: "expected the quick-browse window to close after promote-to-space",
        })
        .toBe(0);
      await expect.poll(() => quickBrowseState(sidebar)).toBeNull();
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
