import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
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

  throw new Error(`No tab WebContentsView window whose url includes "${urlSubstring}" was found within 20s`);
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
      expect(index, "expected a blocking.toggle command suggestion for query 'ads'").toBeGreaterThanOrEqual(0);
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
