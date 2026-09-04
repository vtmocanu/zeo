import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page, Frame } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice
// these blocking tests touch (structurally compatible with @zeo/core's ZeoApi).
// Only the fields we assert on are load-bearing.
interface BridgeTab {
  id: string;
  url: string;
}
interface BridgeState {
  tabs: { id: string }[];
  activeTabId: string | null;
  activeSpaceId: string;
}
interface BridgeSpace {
  id: string;
  profileId: string;
}
interface BridgeSpacesState {
  spaces: { id: string; profileId: string }[];
  activeSpaceId: string;
}
interface BridgeProfile {
  id: string;
}
// PRD 5.1 — the content-blocking slice, exactly as main returns it over
// IPC.blockingState (fullSnapshot().blocking): the enabled flag, the live list
// version, the per-tab blocked-request counts keyed by tab id, and the count of
// blocks not attributable to a tab. Redeclared here like the rest of this bridge.
interface BlockingStateShape {
  enabled: boolean;
  listVersion: string;
  blockedByTab: Record<string, number>;
  blockedUnattributed: number;
}
// PRD 4.2/4.3 — one command-bar suggestion row. The real @zeo/core `Suggestion`
// is a discriminated union; only the `command` arm carries `id`/`title`, so we
// redeclare a minimal view with `id`/`title` OPTIONAL and key the assertions off
// `kind === "command"` + `id`. (Verified against packages/core/src/suggest.ts:17
// and command-bar.ts:20 — the command arm is
// `{ kind: "command"; id: CommandId; title: string; accelerator: string | null }`.)
interface BridgeSuggestion {
  kind: string;
  id?: string;
  title?: string;
}
interface CommandBarStateShape {
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    navigate(id: string, url: string): Promise<void>;
    close(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    activate(id: string): Promise<void>;
    setProfile(spaceId: string, profileId: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  profiles: {
    create(name: string): Promise<BridgeProfile>;
  };
  blocking: {
    setEnabled(enabled: boolean): Promise<void>;
    state(): Promise<BlockingStateShape>;
  };
  commandBar: {
    open(mode: string): Promise<void>;
    setQuery(text: string): Promise<void>;
    state(): Promise<CommandBarStateShape>;
    accept(index?: number): Promise<void>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
}

// A hardcoded 1x1 PNG (verified: PNG signature, IHDR width=1 height=1) served
// for BOTH the allowed and the blocked image, so a loaded <img> yields
// naturalWidth === 1. The blocked request never reaches the server when the
// blocker is on (it is dropped in Electron before the fetch), so the same bytes
// prove "load" only when blocking is off.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

// The fixture page: two same-origin images plus load/error probes main can read.
// `allowed` should always load; `blocked` matches the fixture filter and loads
// ONLY when blocking is off. Both srcs are absolute paths on the fixture origin,
// so a missing `/blocked/pixel.png` request can ONLY mean the blocker dropped it.
const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>zeo-adblock-fixture</title>
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

// The PRD 5.1 §5 fixture filter: block any `/blocked/*` image request. Written to
// a temp file and handed to the app via ZEO_ADBLOCK_FILTERS, which main's startup
// gate builds a fixture engine from (no cache/fetch/refresh — a fully offline,
// deterministic block list).
const FIXTURE_FILTER = "/blocked/*$image\n";

/** A running loopback fixture server plus the paths it has been asked for. */
interface FixtureServer {
  base: string;
  /** Every request path received (query string stripped), in arrival order. */
  paths: string[];
  /** Count of recorded `/blocked/pixel.png` requests — proof the drop failed. */
  blockedHits(): number;
  /** Count of recorded `/allowed/ok.png` requests. */
  allowedHits(): number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port. Every request
 * path (query stripped) is recorded so a MISSING `/blocked/pixel.png` proves the
 * blocker dropped it before the fetch, and a PRESENT one proves it reached the
 * server (blocking off). Both images return the same real 1x1 PNG.
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const paths: string[] = [];
  const png = Buffer.from(PNG_1X1_BASE64, "base64");
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    // Record BEFORE routing: a blocked request that reaches here must be counted
    // (it means the drop failed), and the allowed request is counted too.
    paths.push(pathname);
    if (pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    if (pathname === "/allowed/ok.png" || pathname === "/blocked/pixel.png") {
      // no-store so a reload of the same URL always re-fetches (the toggle-off
      // and re-enable scenarios below rely on repeated loads reaching here
      // rather than Chromium's HTTP cache).
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(png);
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
  const dir = mkdtempSync(join(tmpdir(), "zeo-adblock-filters-"));
  const file = join(dir, "filters.txt");
  writeFileSync(file, FIXTURE_FILTER, "utf8");
  return { file, dir };
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
 * The tab-view page whose url includes `urlSubstring`. A tab renders in its own
 * WebContentsView that surfaces as its own Playwright Page; we identify it by a
 * unique in-url probe token. Mirrors {@link sidebarWindow}: poll every open
 * window, guarding `url()` with try/catch since a navigating view's context can
 * be momentarily destroyed. The sidebar and command-bar overlay load the
 * renderer (never the 127.0.0.1 fixture), so they can never match a fixture url.
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

/** The observed <img> load/error probes for a tab page. */
interface ImageProbes {
  allowed: string | null;
  blocked: string | null;
  allowedNaturalWidth: number;
}

/**
 * Wait until BOTH images on the tab page have settled (fired load or error),
 * then read the probes plus the allowed image's naturalWidth. Runs in the tab
 * view's own page context.
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
 * Launch the packaged Electron build against a temp userData dir, with the
 * fixture filter list wired via ZEO_ADBLOCK_FILTERS. Extends persistence.spec.ts's
 * `launch`: same empty ELECTRON_RENDERER_URL (production loadFile path), ZEO_E2E=1
 * (headless test mode), and --no-sandbox gated on ZEO_E2E_NO_SANDBOX (the docker
 * sidecar runs as root), plus the filters env the blocking startup gate reads.
 */
async function launch(
  userDataDir: string,
  filtersFile: string,
): Promise<{ app: ElectronApplication; sidebar: Page }> {
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
      ZEO_ADBLOCK_FILTERS: filtersFile,
    },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/** Read the blocking slice over the sidebar bridge (a live invoke round trip). */
function blockingState(sidebar: Page): Promise<BlockingStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.blocking.state();
  });
}

// Each test manages its OWN temp userData dir, filter file, and fixture server,
// so recorded-path assertions stay per-test clean. The config gives 60s per test;
// tests are grouped to keep cold starts (expensive under xvfb/docker) to one
// launch each, except the relaunch test which needs two by construction.
test.describe("PRD 5.1 §5 content blocking (offline)", () => {
  // Case A (blocks + allows + attribution) folded with Case B (close-tab
  // attribution cleanup): both act on a single launch, and B naturally continues
  // from A's state (close A's tab, open a fresh one).
  test("blocks and allows with per-tab attribution, and cleans up on close", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-block-"));
    const filters = writeFilterFile();
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, filters.file);
    try {
      // --- Case A: create a tab pointed at the fixture page (blocking on). ---
      const urlA = `${server.base}/page.html?probe=a`;
      const tabA = await sidebar.evaluate(async (url) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create(url);
      }, urlA);

      const pageA = await tabWindow(app, "probe=a");
      const probesA = await readImageProbes(pageA);
      expect(probesA.allowed).toBe("load");
      expect(probesA.allowedNaturalWidth).toBe(1);
      expect(probesA.blocked).toBe("error");

      // The server saw the allowed request but NEVER the blocked one — the drop
      // happened in Electron before the fetch (both are same-origin, so a missing
      // /blocked request cannot be DNS/network).
      expect(server.allowedHits()).toBeGreaterThanOrEqual(1);
      expect(server.blockedHits()).toBe(0);

      // Attribution: exactly one block, credited to tab A, none unattributed.
      await expect
        .poll(async () => (await blockingState(sidebar)).blockedByTab[tabA.id] ?? 0, {
          message: "expected the blocked request to be attributed to tab A",
        })
        .toBe(1);
      expect((await blockingState(sidebar)).blockedUnattributed).toBe(0);

      // --- Case B: close tab A, open a fresh tab; A's id must drop out. ---
      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.close(id);
      }, tabA.id);

      const urlB = `${server.base}/page.html?probe=b`;
      const tabB = await sidebar.evaluate(async (url) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create(url);
      }, urlB);

      const pageB = await tabWindow(app, "probe=b");
      const probesB = await readImageProbes(pageB);
      expect(probesB.blocked).toBe("error");

      await expect
        .poll(async () => (await blockingState(sidebar)).blockedByTab[tabB.id] ?? 0, {
          message: "expected the new tab B to accrue its own block",
        })
        .toBe(1);
      const afterClose = await blockingState(sidebar);
      // The closed tab's attribution entry is gone (closeTab drops it)...
      expect(tabA.id in afterClose.blockedByTab).toBe(false);
      // ...and nothing leaked into the unattributed bucket.
      expect(afterClose.blockedUnattributed).toBe(0);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });

  // Case C: toggle blocking off and back on WITHOUT relaunching — the same
  // profile session must stop and resume filtering.
  test("toggling blocking off then on takes effect on the same session without relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-block-"));
    const filters = writeFilterFile();
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, filters.file);
    try {
      // Blocking on by default: first load drops the blocked image.
      const tab = await sidebar.evaluate(async (url) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create(url);
      }, `${server.base}/page.html?probe=on1`);

      const page1 = await tabWindow(app, "probe=on1");
      const probes1 = await readImageProbes(page1);
      expect(probes1.blocked).toBe("error");
      expect(probes1.allowed).toBe("load");
      expect(server.blockedHits()).toBe(0);
      await expect
        .poll(async () => (await blockingState(sidebar)).blockedByTab[tab.id] ?? 0)
        .toBe(1);

      // --- Toggle OFF, then re-navigate the SAME tab (same origin, so the count
      // is NOT reset). Both images now load; the server sees the blocked request. ---
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.blocking.setEnabled(false);
      });
      const blockedBeforeOff = server.blockedHits();
      await sidebar.evaluate(
        async (args) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.tabs.navigate(args.id, args.url);
        },
        { id: tab.id, url: `${server.base}/page.html?probe=off1` },
      );

      const pageOff = await tabWindow(app, "probe=off1");
      const probesOff = await readImageProbes(pageOff);
      expect(probesOff.allowed).toBe("load");
      // Blocking is off: the previously-blocked image now loads.
      expect(probesOff.blocked).toBe("load");
      // The blocked request now reached the server (drop is disabled).
      expect(server.blockedHits()).toBeGreaterThan(blockedBeforeOff);
      expect(server.allowedHits()).toBeGreaterThanOrEqual(2);
      // No NEW block was recorded while disabled (same origin -> no reset; count
      // does not increase because nothing was blocked).
      expect((await blockingState(sidebar)).blockedByTab[tab.id]).toBe(1);

      // --- Toggle ON again, re-navigate: blocking resumes on the SAME session. ---
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.blocking.setEnabled(true);
      });
      const blockedBeforeOn = server.blockedHits();
      await sidebar.evaluate(
        async (args) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.tabs.navigate(args.id, args.url);
        },
        { id: tab.id, url: `${server.base}/page.html?probe=on2` },
      );

      const pageOn = await tabWindow(app, "probe=on2");
      const probesOn = await readImageProbes(pageOn);
      expect(probesOn.blocked).toBe("error");
      // The blocked request was dropped again — the server saw no new one.
      expect(server.blockedHits()).toBe(blockedBeforeOn);
      // And the tab's block count increased on the same session (no relaunch).
      await expect
        .poll(async () => (await blockingState(sidebar)).blockedByTab[tab.id] ?? 0, {
          message: "expected blocking to resume and increment the count on the same session",
        })
        .toBe(2);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });

  // Case D: a second profile's `persist:<id>` session must also be filtered —
  // proving the blocker attaches to profiles created at runtime, not just startup.
  test("a second profile's session also blocks", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-block-"));
    const filters = writeFilterFile();
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, filters.file);
    try {
      // Create a second profile + space, point the space at it, and activate it.
      const space = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const profile = await zeo.profiles.create("ProfileTwo");
        const created = await zeo.spaces.create("SpaceTwo");
        await zeo.spaces.setProfile(created.id, profile.id);
        await zeo.spaces.activate(created.id);
        return created;
      });
      expect(space.id).toBeTruthy();

      // A tab in the second space is created on persist:<profileTwo>. Its blocked
      // image must be dropped too.
      const tab = await sidebar.evaluate(async (url) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create(url);
      }, `${server.base}/page.html?probe=d`);

      const page = await tabWindow(app, "probe=d");
      const probes = await readImageProbes(page);
      expect(probes.allowed).toBe("load");
      // The blocker attached to the second profile's session, so the block fired.
      expect(probes.blocked).toBe("error");
      await expect
        .poll(async () => (await blockingState(sidebar)).blockedByTab[tab.id] ?? 0, {
          message: "expected the second profile's session to block and attribute the request",
        })
        .toBe(1);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });

  // Case E: the disabled flag is written synchronously to sqlite by setEnabled, so
  // a relaunch against the same userData dir restores blocking as disabled.
  test("a disabled blocking flag persists across relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-block-"));
    const filters = writeFilterFile();
    try {
      // --- Launch #1: disable blocking, then close. ---
      const first = await launch(userDataDir, filters.file);
      try {
        await first.sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.blocking.setEnabled(false);
        });
        expect((await blockingState(first.sidebar)).enabled).toBe(false);
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dir; blocking restored as disabled. ---
      const second = await launch(userDataDir, filters.file);
      try {
        expect((await blockingState(second.sidebar)).enabled).toBe(false);
      } finally {
        await second.app.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });

  // Case F: the command bar exposes a "Toggle Content Blocking" command that
  // flips the enabled flag. Driven entirely over the bridge (not the keyboard) to
  // avoid the overlay blur-close race noted in repo memory.
  test("the command bar can toggle content blocking", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-block-"));
    const filters = writeFilterFile();
    const { app, sidebar } = await launch(userDataDir, filters.file);
    try {
      // Open the bar and search for the command by a keyword ("ads").
      const barState = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("navigate");
        await zeo.commandBar.setQuery("ads");
        return zeo.commandBar.state();
      });

      const index = barState.suggestions.findIndex(
        (s) => s.kind === "command" && s.id === "blocking.toggle",
      );
      expect(
        index,
        "expected a blocking.toggle command suggestion for query 'ads'",
      ).toBeGreaterThanOrEqual(0);
      expect(barState.suggestions[index]?.title).toBe("Toggle Content Blocking");

      const before = (await blockingState(sidebar)).enabled;

      // Accept the command row by its index (the bridge, not a keystroke).
      await sidebar.evaluate(async (idx) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.accept(idx);
      }, index);

      // blocking.toggle dispatches setBlockingEnabled asynchronously, so poll.
      await expect
        .poll(async () => (await blockingState(sidebar)).enabled, {
          message: "expected the command-bar toggle to flip the blocking enabled flag",
        })
        .toBe(!before);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(filters.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// PRD 5.3 — CSP injection + cosmetic filtering (offline)
// ===========================================================================
// These fixtures are SEPARATE from the PRD 5.1 §5 network-blocking block above
// (different pages, different filter list, its own dual-name server). They must
// NOT touch the PRD 5.1 helpers/FIXTURE_FILTER/PAGE_HTML, which stay as-is.

// The PRD 5.3 fixture filter list, one rule per line:
//   - `##.zeo-ad-slot`               generic element-hiding (host-independent).
//   - `/csp.html$csp=script-src 'none'` inject a CSP that forbids scripts on the
//     csp.html document, so its inline <script> never runs.
//   - `localhost##+js(zeo-mark)`     a scriptlet scoped to the `localhost` host
//     ONLY, resolved from the resources file below. Its host scope is the whole
//     point of the cross-origin frame case: it runs on localhost frames, not on
//     127.0.0.1 frames.
const COSMETIC_FILTER =
  ["##.zeo-ad-slot", "/csp.html$csp=script-src 'none'", "localhost##+js(zeo-mark)"].join("\n") +
  "\n";

// The library resources.txt payload defining the `zeo-mark` scriptlet: a header
// line `name type`, then the body, blocks separated by a blank line. main hands
// this to createBlockerFromFilters via ZEO_ADBLOCK_RESOURCES so `##+js(zeo-mark)`
// resolves. The body stamps a dataset marker on <html> so a frame can prove the
// scriptlet executed in it.
const COSMETIC_RESOURCES =
  'zeo-mark.js application/javascript\n(function() { document.documentElement.dataset.zeoScriptlet = "ran"; })();\n';

/** A running dual-name (127.0.0.1 + localhost) fixture server for PRD 5.3 pages. */
interface CosmeticFixtureServer {
  /** The `http://127.0.0.1:<port>` origin — host is NOT in the scriptlet scope. */
  base: string;
  /** The `http://localhost:<port>` origin — host IS in the scriptlet scope. */
  localhostBase: string;
  /** Every request path received (query stripped), in arrival order. */
  paths: string[];
  close(): Promise<void>;
}

/**
 * Start an HTTP server on an ephemeral port bound with NO host argument, so Node
 * binds all interfaces and BOTH `http://127.0.0.1:<port>` and
 * `http://localhost:<port>` reach it. Serves three no-store HTML pages used by
 * the cosmetic/CSP cases: `/cosmetic.html` (an ad slot above a marker),
 * `/csp.html` (an inline script that renames the title, plus a marker, and NO
 * CSP header of its own), and `/frame.html` (a localhost child iframe next to a
 * marker). `no-store` forces every re-navigation to re-fetch rather than serve
 * Chromium's HTTP cache.
 */
async function startCosmeticFixtureServer(): Promise<CosmeticFixtureServer> {
  const paths: string[] = [];
  // Resolved after listen(); the frame.html iframe src needs the live port to
  // point at the localhost origin (a different host than the 127.0.0.1 parent).
  let port = 0;
  const page = (body: string): string => `<!doctype html><meta charset=utf-8>${body}`;
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    paths.push(pathname);
    const sendHtml = (markup: string): void => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(markup);
    };
    if (pathname === "/cosmetic.html") {
      sendHtml(
        page(
          '<title>zeo-cosmetic-fixture</title><div class="zeo-ad-slot">ad slot</div><p id="marker">marker visible</p>',
        ),
      );
      return;
    }
    if (pathname === "/csp.html") {
      // The inline script sets the title to "scripted"; under the injected
      // `script-src 'none'` it never runs, so the title stays the default below.
      sendHtml(
        page(
          '<title>zeo-csp-fixture</title><script>document.title = "scripted";</script><p id="marker">marker visible</p>',
        ),
      );
      return;
    }
    if (pathname === "/frame.html") {
      // The parent is served from whichever host the tab navigated to; the child
      // iframe is ALWAYS the localhost origin, so the scriptlet (localhost-scoped)
      // runs in the child but not in a 127.0.0.1 parent.
      sendHtml(
        page(
          `<title>zeo-frame-fixture</title><iframe src="http://localhost:${port}/cosmetic.html"></iframe><p id="marker">marker visible</p>`,
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    // No host arg: Node binds all interfaces so both loopback names connect.
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("cosmetic fixture server did not bind to an inet address");
  }
  port = (address as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    localhostBase: `http://localhost:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Write the PRD 5.3 filter list + scriptlet resources to a fresh temp dir. */
function writeCosmeticFixtureFiles(): { filters: string; resources: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zeo-adblock-cosmetic-"));
  const filters = join(dir, "filters.txt");
  const resources = join(dir, "resources.txt");
  writeFileSync(filters, COSMETIC_FILTER, "utf8");
  writeFileSync(resources, COSMETIC_RESOURCES, "utf8");
  return { filters, resources, dir };
}

/**
 * Launch the packaged build like {@link launch}, additionally wiring the
 * scriptlet resources via ZEO_ADBLOCK_RESOURCES (read by main on the fixture
 * path alongside ZEO_ADBLOCK_FILTERS). `filtersFile` MAY be a non-existent path
 * (the failure-state case), which main's startup gate must degrade past.
 */
async function launchWithResources(
  userDataDir: string,
  filtersFile: string,
  resourcesFile: string,
): Promise<{ app: ElectronApplication; sidebar: Page }> {
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
      ZEO_ADBLOCK_FILTERS: filtersFile,
      ZEO_ADBLOCK_RESOURCES: resourcesFile,
    },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/** Create a tab at `url` over the sidebar bridge and return its bridge record. */
function createTab(sidebar: Page, url: string): Promise<BridgeTab> {
  return sidebar.evaluate((u) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.create(u);
  }, url);
}

/**
 * Computed `display` of the first `.zeo-ad-slot` in `target`'s document, or the
 * sentinel `"missing"` when the element is absent. `target` is a tab {@link Page}
 * or a child {@link Frame}; both expose `evaluate`. Reads run in that document's
 * own context, so a still-parsing page yields `"missing"` until the node exists.
 */
function adSlotDisplay(target: Page | Frame): Promise<string> {
  return target.evaluate(() => {
    const el = document.querySelector(".zeo-ad-slot");
    return el === null ? "missing" : getComputedStyle(el).display;
  });
}

/** Whether the `zeo-mark` scriptlet ran in `target` (its `<html>` dataset flag). */
function scriptletRan(target: Page | Frame): Promise<boolean> {
  return target.evaluate(() => document.documentElement.dataset.zeoScriptlet === "ran");
}

/** Computed `display` of `#marker` in `target`, or `"missing"` when absent. */
function markerDisplay(target: Page | Frame): Promise<string> {
  return target.evaluate(() => {
    const el = document.getElementById("marker");
    return el === null ? "missing" : getComputedStyle(el).display;
  });
}

/**
 * Poll `target` until its `#marker` has rendered (its computed `display` is a
 * real value, not the `"missing"` sentinel). Proves the page finished parsing —
 * and since the marker is authored AFTER any inline script, that the script's
 * run-or-blocked decision has already happened by the time this resolves.
 */
async function waitForMarker(target: Page | Frame): Promise<void> {
  await expect
    .poll(() => markerDisplay(target), { message: "expected #marker to render" })
    .not.toBe("missing");
}

/**
 * The child frame whose url includes `/cosmetic.html`, inside the tab `page`.
 * The cross-origin iframe surfaces as one of `page.frames()`; poll for it,
 * guarding a navigating frame's momentary context loss with try/catch (mirrors
 * {@link tabWindow}).
 */
async function childCosmeticFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        if (f.url().includes("/cosmetic.html")) {
          return f;
        }
      } catch {
        // A navigating frame's context can be momentarily destroyed; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No child frame whose url includes "/cosmetic.html" was found within 20s');
}

/** The active space's profileId, read over the sidebar bridge. */
function activeProfileId(sidebar: Page): Promise<string> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const state = await zeo.spaces.list();
    const active = state.spaces.find((s) => s.id === state.activeSpaceId);
    if (active === undefined) {
      throw new Error("no active space in spaces.list()");
    }
    return active.profileId;
  });
}

// Each test owns its temp userData dir, fixture files, and dual-name server, and
// tears them down in `finally`. Cold starts are expensive under xvfb/docker, so
// each test uses a single launch except the two-phase cases that need two.
test.describe("PRD 5.3 CSP + cosmetic filtering (offline)", () => {
  // Case 1: element-hiding + host-scoped scriptlet on a localhost page. Neither
  // is a network block, so the tab accrues NO blocked-request attribution.
  test("hides ad slots and runs the host-scoped scriptlet on a localhost page", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      const tab = await createTab(sidebar, `${server.localhostBase}/cosmetic.html?probe=cos`);
      const page = await tabWindow(app, "probe=cos");

      // Element-hiding injection follows document-start, so poll for it.
      await expect
        .poll(() => adSlotDisplay(page), { message: "expected .zeo-ad-slot to be hidden" })
        .toBe("none");
      // The marker is left visible — only the ad slot is hidden.
      expect(await markerDisplay(page)).not.toBe("none");
      // The localhost-scoped scriptlet ran in this localhost frame.
      await expect
        .poll(() => scriptletRan(page), { message: "expected the zeo-mark scriptlet to run" })
        .toBe(true);

      // Cosmetic hiding + CSP are NOT counted as network blocks: no per-tab
      // attribution entry and nothing in the unattributed bucket.
      const state = await blockingState(sidebar);
      expect(tab.id in state.blockedByTab).toBe(false);
      expect(state.blockedUnattributed).toBe(0);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 2: the injected `script-src 'none'` CSP blocks the page's inline script.
  test("injects a CSP that blocks the page's inline script", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      await createTab(sidebar, `${server.base}/csp.html?probe=csp`);
      const page = await tabWindow(app, "probe=csp");
      await waitForMarker(page);

      // The inline script would rename the title to "scripted"; the injected CSP
      // forbade it, so the title stays the served default and the marker renders.
      expect(await page.title()).not.toBe("scripted");
      expect(await markerDisplay(page)).not.toBe("none");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 3: toggle blocking off then on WITHOUT relaunch — cosmetic hiding, the
  // scriptlet, and CSP injection all stop and then resume on the same session.
  test("toggling blocking off then on stops and resumes cosmetic + CSP effects", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      // --- Blocking OFF: new tabs see NO cosmetic/scriptlet/CSP effects. ---
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.blocking.setEnabled(false);
      });

      await createTab(sidebar, `${server.localhostBase}/cosmetic.html?probe=off-cos`);
      const offCosmetic = await tabWindow(app, "probe=off-cos");
      await waitForMarker(offCosmetic);
      // The ad slot renders (a bare <div> defaults to block) and the scriptlet
      // did not run.
      expect(await adSlotDisplay(offCosmetic)).not.toBe("none");
      expect(await scriptletRan(offCosmetic)).toBe(false);

      await createTab(sidebar, `${server.base}/csp.html?probe=off-csp`);
      const offCsp = await tabWindow(app, "probe=off-csp");
      await waitForMarker(offCsp);
      // No CSP injected, so the inline script ran and renamed the title.
      expect(await offCsp.title()).toBe("scripted");

      // --- Blocking ON again (no relaunch): all three effects return. ---
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.blocking.setEnabled(true);
      });

      await createTab(sidebar, `${server.localhostBase}/cosmetic.html?probe=on-cos`);
      const onCosmetic = await tabWindow(app, "probe=on-cos");
      await expect
        .poll(() => adSlotDisplay(onCosmetic), {
          message: "expected hiding to resume after re-enable",
        })
        .toBe("none");
      await expect
        .poll(() => scriptletRan(onCosmetic), {
          message: "expected the scriptlet to run after re-enable",
        })
        .toBe(true);

      await createTab(sidebar, `${server.base}/csp.html?probe=on-csp`);
      const onCsp = await tabWindow(app, "probe=on-csp");
      await waitForMarker(onCsp);
      expect(await onCsp.title()).not.toBe("scripted");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 4: a second profile's `persist:<id>` session is filtered too — the
  // cosmetic preload attaches to profiles created at runtime, not just startup.
  test("a second profile's session also hides ad slots and runs the scriptlet", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      const space = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const profile = await zeo.profiles.create("ProfileTwo");
        const created = await zeo.spaces.create("SpaceTwo");
        await zeo.spaces.setProfile(created.id, profile.id);
        await zeo.spaces.activate(created.id);
        return created;
      });
      expect(space.id).toBeTruthy();

      await createTab(sidebar, `${server.localhostBase}/cosmetic.html?probe=p2`);
      const page = await tabWindow(app, "probe=p2");
      await expect
        .poll(() => adSlotDisplay(page), {
          message: "expected the second profile to hide the ad slot",
        })
        .toBe("none");
      await expect
        .poll(() => scriptletRan(page), {
          message: "expected the second profile to run the scriptlet",
        })
        .toBe(true);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 5: cross-origin child frame. The parent (127.0.0.1) is out of the
  // scriptlet's `localhost` scope; the child iframe (localhost) is in it. Generic
  // element-hiding is host-independent, so the child's ad slot is hidden either
  // way.
  test("filters a cross-origin child frame, scoping the scriptlet by host", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      await createTab(sidebar, `${server.base}/frame.html?probe=frame`);
      const page = await tabWindow(app, "probe=frame");
      const child = await childCosmeticFrame(page);

      // Child (localhost): ad slot hidden AND the localhost-scoped scriptlet ran.
      await expect
        .poll(() => adSlotDisplay(child), {
          message: "expected the child frame ad slot to be hidden",
        })
        .toBe("none");
      await expect
        .poll(() => scriptletRan(child), {
          message: "expected the scriptlet to run in the localhost child",
        })
        .toBe(true);

      // Top (127.0.0.1): its own marker stays visible and the scriptlet did NOT
      // run there — it is scoped to the child's host only.
      expect(await markerDisplay(page)).not.toBe("none");
      expect(await scriptletRan(page)).toBe(false);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 6: failure state. A missing filter file must not brick the app; the
  // startup gate degrades and no real filtering happens (blocker stays null). A
  // relaunch with a valid file over the SAME userData dir recovers filtering.
  //
  // Asserts the strict PRD 5.3 §3 contract: with no engine attached the app
  // reports `blockingState.enabled === false` for the launch, and `setEnabled(true)`
  // REJECTS while the blocker is null (changing nothing). The persisted flag is
  // left untouched, so launch #2 with a valid file retries and recovers.
  test("a missing filter file degrades gracefully and a valid relaunch recovers", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const missingFilters = join(fx.dir, "does-not-exist.txt");
    try {
      // --- Launch #1: filter file is absent — the read throws and is caught. ---
      const first = await launchWithResources(userDataDir, missingFilters, fx.resources);
      try {
        // With no engine attached the app reports blocking disabled for this
        // launch (PRD 5.3 §3), even though the persisted flag stays true.
        expect((await blockingState(first.sidebar)).enabled).toBe(false);

        // Enabling blocking with a null blocker REJECTS and changes nothing.
        await expect(
          first.sidebar.evaluate(() => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            return zeo.blocking.setEnabled(true);
          }),
        ).rejects.toThrow();
        expect((await blockingState(first.sidebar)).enabled).toBe(false);

        // The blocker is null, so NO filtering happens: a cosmetic.html tab keeps
        // its ad slot visible and the scriptlet never runs.
        await createTab(first.sidebar, `${server.localhostBase}/cosmetic.html?probe=fail`);
        const page = await tabWindow(first.app, "probe=fail");
        await waitForMarker(page);
        expect(await adSlotDisplay(page)).not.toBe("none");
        expect(await scriptletRan(page)).toBe(false);
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same userData dir, a VALID filter file — filtering back. ---
      const second = await launchWithResources(userDataDir, fx.filters, fx.resources);
      try {
        expect((await blockingState(second.sidebar)).enabled).toBe(true);
        await createTab(second.sidebar, `${server.localhostBase}/cosmetic.html?probe=recover`);
        const page = await tabWindow(second.app, "probe=recover");
        await expect
          .poll(() => adSlotDisplay(page), {
            message: "expected filtering to recover after a valid relaunch",
          })
          .toBe("none");
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Case 7: session isolation. The cosmetic preload is registered ONLY on profile
  // partition sessions, never the default session that hosts the sidebar/overlay.
  test("registers the cosmetic preload only on the profile session, not the default session", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-cosmetic-"));
    const fx = writeCosmeticFixtureFiles();
    const server = await startCosmeticFixtureServer();
    const { app, sidebar } = await launchWithResources(userDataDir, fx.filters, fx.resources);
    try {
      await createTab(sidebar, `${server.localhostBase}/cosmetic.html?probe=iso`);
      const page = await tabWindow(app, "probe=iso");
      await expect
        .poll(() => adSlotDisplay(page), {
          message: "expected the profile tab ad slot to be hidden",
        })
        .toBe("none");

      const profileId = await activeProfileId(sidebar);

      // Count cosmetic-preload registrations per session in the MAIN process. The
      // filename is `cosmetic-preload.cjs` (NOT `adblocker-electron-preload`).
      const whileEnabled = await app.evaluate(({ session }, pid) => {
        const cosmetic = (s: Electron.Session): number =>
          s.getPreloadScripts().filter((p) => p.filePath.includes("cosmetic-preload")).length;
        return {
          defaultCount: cosmetic(session.defaultSession),
          profileCount: cosmetic(session.fromPartition("persist:" + pid)),
        };
      }, profileId);
      // The default session (sidebar/overlay) has no cosmetic preload; the active
      // profile session has exactly one.
      expect(whileEnabled.defaultCount).toBe(0);
      expect(whileEnabled.profileCount).toBe(1);

      // The sidebar renderer has no cosmetic preload, so a sentinel ad-slot node
      // appended to its own document is NOT hidden — while the profile tab's node
      // (same class) IS hidden (asserted above).
      const sidebarSentinelDisplay = await sidebar.evaluate(() => {
        const el = document.createElement("div");
        el.className = "zeo-ad-slot";
        document.body.appendChild(el);
        return getComputedStyle(el).display;
      });
      expect(sidebarSentinelDisplay).not.toBe("none");

      // After disabling blocking, the profile session's cosmetic preload is gone.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.blocking.setEnabled(false);
      });
      const afterDisable = await app.evaluate(({ session }, pid) => {
        return session
          .fromPartition("persist:" + pid)
          .getPreloadScripts()
          .filter((p) => p.filePath.includes("cosmetic-preload")).length;
      }, profileId);
      expect(afterDisable).toBe(0);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
