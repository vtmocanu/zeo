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
// (e2e is ESM, so no __dirname). Same layout as blocking.spec.ts / app.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// zoom tests touch (structurally compatible with @zeo/core's ZeoApi). Only the
// fields we assert on are load-bearing.
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<{ id: string; url: string }>;
    activate(id: string): Promise<void>;
    list(): Promise<{ tabs: { id: string }[]; activeTabId: string | null }>;
  };
  zoom: {
    zoomIn(): Promise<void>;
    zoomOut(): Promise<void>;
    reset(): Promise<void>;
    state(): Promise<{ byHost: Record<string, number> }>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
  onStateChange(listener: (state: unknown) => void): () => void;
}

// The zoom fixture page: a trivial same-origin document with no images and no
// adblock dependency. `no-store` so a re-navigation always re-fetches rather than
// serving Chromium's HTTP cache.
const PAGE_HTML =
  "<!doctype html><meta charset=utf-8><title>zeo-zoom-fixture</title><p>zoom fixture</p>";

/** A running loopback fixture server serving the trivial zoom page. */
interface FixtureServer {
  base: string;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port, serving the zoom
 * fixture page at `/page.html`. No images, no filters — zoom is host-keyed and
 * needs only a same-host document. Because zoom keys off the port-less host, every
 * ephemeral port shares the single `127.0.0.1` host key.
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
    throw new Error("zoom fixture server did not bind to an inet address");
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
 * The renderer window that hosts the React sidebar. Copied from blocking.spec.ts:
 * `firstWindow()` cannot be trusted because each tab is a separate
 * WebContentsView that may also surface as a window, so poll every open window for
 * the one exposing the sidebar, guarding a navigating view's destroyed execution
 * context with try/catch.
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
 * The tab-view page whose url includes `urlSubstring`. A tab renders in its own
 * WebContentsView that surfaces as its own Playwright Page; we identify it by a
 * unique in-url probe token. Mirrors {@link sidebarWindow}: poll every open
 * window, guarding `url()` with try/catch since a navigating view's context can be
 * momentarily destroyed. The sidebar loads the renderer (never the 127.0.0.1
 * fixture), so it can never match a fixture url.
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

/**
 * Launch the packaged Electron build against a temp userData dir. Like
 * blocking.spec.ts's `launch` but WITHOUT any adblock filter wiring: empty
 * ELECTRON_RENDERER_URL (production loadFile path), ZEO_E2E=1 (headless test
 * mode), and --no-sandbox gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs as
 * root). Zoom needs no fixture filters.
 */
async function launch(userDataDir: string): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
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
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/** Create a tab at `url` over the sidebar bridge and return its bridge record. */
function createTab(sidebar: Page, url: string): Promise<{ id: string; url: string }> {
  return sidebar.evaluate((u) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.create(u);
  }, url);
}

/** Activate tab `id` over the sidebar bridge. */
function activateTab(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((tabId) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.activate(tabId);
  }, id);
}

/** Step the active tab's host one rung up the zoom ladder over the bridge. */
function zoomIn(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.zoom.zoomIn();
  });
}

/** Step the active tab's host one rung DOWN the zoom ladder over the bridge. */
function zoomOut(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.zoom.zoomOut();
  });
}

/** Reset the active tab's host to actual size (1.0) over the bridge. */
function zoomReset(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.zoom.reset();
  });
}

/** Read the current {@link ZoomState} (`{ byHost }`) over the bridge. */
function zoomState(sidebar: Page): Promise<{ byHost: Record<string, number> }> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.zoom.state();
  });
}

/** The tab page's `window.devicePixelRatio` (scales with the applied zoom factor). */
function readDpr(page: Page): Promise<number> {
  return page.evaluate(() => window.devicePixelRatio);
}

/**
 * Poll the tab page's `window.devicePixelRatio` until it lands within 0.02 of
 * `expected`. Zoom is applied on the tab's `did-navigate`, which can land a tick
 * after the page window appears, so we poll rather than read once.
 */
async function waitForDpr(page: Page, expected: number, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (target) => Math.abs(window.devicePixelRatio - target) < 0.02,
    expected,
    { timeout },
  );
}

/** A real-timer sleep (settle waits for persistence flush / broadcast arrival). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each test manages its OWN temp userData dir and fixture server and tears them
// down in `finally`. Cold Electron starts are expensive under xvfb/docker, so the
// first test folds the zoom-in / inheritance / reset / idempotent-reset assertions
// into one launch; the relaunch test needs two launches by construction.
test.describe("PRD 6.4 zoom (offline)", () => {
  // (A) zoom in twice + devicePixelRatio + second-tab inheritance, then
  // (B) reset deletes the row and the badge disappears, then
  // (C) a second reset is a full no-op with no further broadcast — all one launch.
  test("zooms a site in, inherits on a second tab on the same host, then resets idempotently", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-zoom-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      // --- (A) zoom the fixture host in twice from tab1. ---
      const tab1 = await createTab(sidebar, `${server.base}/page.html?probe=t1`);
      const page1 = await tabWindow(app, "probe=t1");
      await activateTab(sidebar, tab1.id);

      // Baseline dpr at the un-zoomed factor (byHost is empty, so factor 1.0). The
      // environment's base deviceScaleFactor need not be exactly 1, so every later
      // assertion is relative to this baseline.
      const baseline = await readDpr(page1);

      // Two rungs above 1.0 on the Chromium ladder: 1.0 -> 1.1 -> 1.25. The active
      // tab is tab1, so both steps land on the fixture host.
      await zoomIn(sidebar);
      await zoomIn(sidebar);
      expect((await zoomState(sidebar)).byHost["127.0.0.1"]).toBe(1.25);

      // devicePixelRatio scales with the applied factor (pinch-zoom is disabled, so
      // visualViewport.scale would stay 1 regardless — devicePixelRatio is the
      // observable the PRD asserts).
      await waitForDpr(page1, baseline * 1.25);

      // --- Second tab on the SAME host inherits the factor from its first commit,
      // with no zoom command run against it. ---
      const tab2 = await createTab(sidebar, `${server.base}/page.html?probe=t2`);
      const page2 = await tabWindow(app, "probe=t2");
      await waitForDpr(page2, baseline * 1.25);
      expect(tab2.id).toBeTruthy();

      // --- Zoom OUT one rung from tab1 (1.25 -> 1.1), exercising the wired-but-
      // otherwise-untested zoomOut path end to end: bridge state AND rendered scale.
      await activateTab(sidebar, tab1.id);
      await zoomOut(sidebar);
      expect((await zoomState(sidebar)).byHost["127.0.0.1"]).toBe(1.1);
      await waitForDpr(page1, baseline * 1.1);

      // --- (B) reset the fixture host from tab1 (now at 1.1): the row is deleted
      // and the sidebar badge disappears. ---
      // The badge renders on the active tab at a non-default factor.
      await expect
        .poll(() => sidebar.getByTestId("tab-zoom").count(), {
          message: "expected the active tab's zoom badge to render at 1.1",
        })
        .toBeGreaterThan(0);

      await zoomReset(sidebar);
      // The host key is gone from the in-memory state...
      expect((await zoomState(sidebar)).byHost["127.0.0.1"]).toBeUndefined();
      // ...and the badge disappears through the stateChange re-render (web-first
      // retrying matcher).
      await expect(sidebar.getByTestId("tab-zoom")).toHaveCount(0);
      // ...and the active Chromium view factor itself returns to actual size (the
      // relative DPR oracle, not merely state/badge clearing).
      await waitForDpr(page1, baseline);

      // --- (C) reset again with the host already at the default factor: the
      // no-persist / no-view-update / no-broadcast idempotent path. ---
      // Count only broadcasts whose zoom slice actually differs from the baseline
      // captured just before the second reset. A global `onStateChange` counter is
      // flaky: unrelated background broadcasts (title/favicon/store settle) can land
      // in the settle window. The idempotent reset-at-default path changes no zoom
      // state, so this slice-scoped counter stays 0 even when other broadcasts fire.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const g = globalThis as unknown as {
          __zoomChanges: number;
          __baselineZoom: string;
          __unsub: () => void;
        };
        const current = await zeo.zoom.state();
        g.__baselineZoom = JSON.stringify(current.byHost ?? {});
        g.__zoomChanges = 0;
        g.__unsub = zeo.onStateChange((state) => {
          const s = state as { zoom?: { byHost?: Record<string, number> } };
          if (JSON.stringify(s.zoom?.byHost ?? {}) !== g.__baselineZoom) {
            g.__zoomChanges += 1;
          }
        });
      });

      await zoomReset(sidebar);
      // Give any (unexpected) zoom-slice broadcast time to arrive before asserting none did.
      await sleep(600);

      expect((await zoomState(sidebar)).byHost["127.0.0.1"]).toBeUndefined();
      const zoomChanges = await sidebar.evaluate(
        () => (globalThis as unknown as { __zoomChanges: number }).__zoomChanges,
      );
      expect(zoomChanges).toBe(0);

      await sidebar.evaluate(() => {
        (globalThis as unknown as { __unsub: () => void }).__unsub();
      });
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // (D) relaunch persists the factor. TWO launches, same userData dir, one fixture
  // server kept open across both. Because zoom keys off the port-less host, the
  // relaunch tab need not reuse the same port — keeping one server is simplest.
  test("persists a site's zoom factor across a relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-zoom-"));
    const server = await startFixtureServer();
    // Captured un-zoomed in launch #1, reused for the relative assertion in launch
    // #2; deviceScaleFactor is environment-fixed and stable across relaunches.
    // Definite-assignment: set in launch #1 before launch #2's read (which only
    // runs if launch #1 succeeded), so no useless initializer.
    let baseline!: number;
    try {
      // --- Launch #1: zoom the fixture host to 1.25, then close. ---
      const first = await launch(userDataDir);
      try {
        const tab = await createTab(first.sidebar, `${server.base}/page.html?probe=r1`);
        const page1 = await tabWindow(first.app, "probe=r1");
        await activateTab(first.sidebar, tab.id);
        baseline = await readDpr(page1);
        await zoomIn(first.sidebar);
        await zoomIn(first.sidebar);
        expect((await zoomState(first.sidebar)).byHost["127.0.0.1"]).toBe(1.25);
        // upsertSiteZoom is synchronous, but let any pending work settle first.
        await sleep(300);
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same userData dir; a FRESH tab on the host loads at the
      // persisted factor with no zoom interaction. ---
      const second = await launch(userDataDir);
      try {
        await createTab(second.sidebar, `${server.base}/page.html?probe=r2`);
        const page = await tabWindow(second.app, "probe=r2");

        // The load-bearing persistence proof: the factor is seeded from site_zoom
        // at startup, before any interaction.
        expect((await zoomState(second.sidebar)).byHost["127.0.0.1"]).toBe(1.25);

        // The fresh tab's on-screen factor reflects the persisted 1.25 (applied on
        // first commit): devicePixelRatio reaches the un-zoomed baseline * 1.25, a
        // relative oracle that cannot pass vacuously at default zoom on high-DPI.
        await waitForDpr(page, baseline * 1.25);
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
