import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// PRD 9.6 — in-app update check, driven end to end against a loopback releases
// feed. Nothing here touches the network beyond 127.0.0.1.

// Absolute path to the desktop app DIRECTORY, resolved from this test file (e2e
// is ESM, so no __dirname). Unlike zoom.spec.ts / settings.spec.ts, which launch
// the built main entry file directly, this suite launches the directory: Electron
// then reads apps/desktop/package.json, whose `main` is the same built
// ./out/main/index.js and whose `version` ("0.0.0") becomes `app.getVersion()`.
// Launching the bare entry file leaves no package.json beside the app path, so
// `app.getVersion()` falls back to Electron's own version (e.g. "44.0.0"), which
// is newer than every fixture release below, so no update would ever be offered.
const appDir = fileURLToPath(new URL("../../apps/desktop", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core's runtime; we redeclare only the
// slice these tests touch (structurally compatible with @zeo/core's ZeoApi).
interface BridgeAvailableUpdate {
  version: string;
  url: string;
}
interface BridgeUpdateState {
  enabled: boolean;
  origin: string;
  available: BridgeAvailableUpdate | null;
  checking: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}
interface BridgeState {
  settingsOpen?: boolean;
  settingsSection: string;
  update: BridgeUpdateState;
}
interface ZeoBridge {
  tabs: {
    list(): Promise<BridgeState>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
  settings: {
    setUpdateCheckEnabled(enabled: boolean): Promise<void>;
  };
  update: {
    check(): Promise<void>;
    dismiss(): Promise<void>;
    openRelease(): Promise<void>;
    copyUpgradeCommand(): Promise<void>;
    state(): Promise<BridgeUpdateState>;
  };
}

// --- Fixture releases feed. -------------------------------------------------------

/** A GitHub `releases/latest`-shaped body for `version` (no leading `v`). */
interface ReleaseBody {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

/** The release page url for `version`; github.com so `openRelease` accepts it. */
function releaseUrl(version: string): string {
  return `https://github.com/vtmocanu/zeo/releases/tag/v${version}`;
}

/** A non-draft, non-prerelease release body for `version`. */
function release(version: string, overrides: Partial<ReleaseBody> = {}): ReleaseBody {
  return {
    tag_name: `v${version}`,
    html_url: releaseUrl(version),
    published_at: "2026-01-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

/** A running loopback feed server whose `/latest` response is mutable. */
interface FixtureServer {
  /** The full feed url, `http://127.0.0.1:<port>/latest`. */
  feedUrl: string;
  /** Replace what `/latest` answers with from the next request on. */
  respond(body: unknown, status?: number): void;
  /** Number of requests `/latest` has received so far. */
  hits(): number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port whose `/latest`
 * route answers with a configurable JSON body and status and counts every hit.
 * Mirrors zoom.spec.ts's `startFixtureServer`.
 */
async function startFixtureServer(initial: unknown, initialStatus = 200): Promise<FixtureServer> {
  let body: unknown = initial;
  let status = initialStatus;
  let hits = 0;
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/latest") {
      hits += 1;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
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
    throw new Error("update fixture server did not bind to an inet address");
  }
  const port = (address as AddressInfo).port;
  return {
    feedUrl: `http://127.0.0.1:${port}/latest`,
    respond: (nextBody, nextStatus = 200) => {
      body = nextBody;
      status = nextStatus;
    },
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// --- App helpers. -----------------------------------------------------------------

/**
 * The renderer window that hosts the React sidebar. Copied from settings.spec.ts:
 * poll every open window for the one exposing the sidebar, guarding a navigating
 * view's destroyed execution context with try/catch.
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
 * The settings {@link Page} (its own WebContentsView loaded with
 * `?view=settings`). Copied from settings.spec.ts.
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

interface LaunchOptions {
  /** The fixture feed url; omitted means no automatic scheduling at all. */
  feedUrl?: string;
  /** `ZEO_UPDATE_ORIGIN` override. */
  origin?: "homebrew" | "direct";
}

/**
 * Launch the built Electron app against `userDataDir` (so relaunches share
 * `zeo.db`), mirroring persistence.spec.ts's `launch`. With a `feedUrl`, main
 * points the check at the fixture and schedules the startup check 100 ms after
 * launch (the `ZEO_UPDATE_FEED_URL` override is what enables automatic
 * scheduling in an unpackaged build). The ambient `ZEO_UPDATE_*` variables are
 * stripped first so only what this test asks for reaches main.
 */
async function launch(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ZEO_UPDATE_")) {
      env[key] = value;
    }
  }
  env.ELECTRON_RENDERER_URL = "";
  env.ZEO_E2E = "1";
  env.ZEO_UPDATE_STARTUP_DELAY_MS = "100";
  if (options.feedUrl !== undefined) {
    env.ZEO_UPDATE_FEED_URL = options.feedUrl;
  }
  if (options.origin !== undefined) {
    env.ZEO_UPDATE_ORIGIN = options.origin;
  }
  const app = await electron.launch({
    args: [
      appDir,
      "--user-data-dir=" + userDataDir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env,
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/**
 * Wait strictly longer than db.ts's 1000 ms SAVE_DEBOUNCE_MS so the debounced
 * save of the last update-state write lands on disk before a relaunch. A real
 * debounce timer, so a fixed sleep is the right instrument (persistence.spec.ts).
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

/** `window.zeo.update.state()` over the sidebar bridge. */
function updateState(sidebar: Page): Promise<BridgeUpdateState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.update.state();
  });
}

/** `window.zeo.update.check()` (manual, never rate-limited) over the bridge. */
function checkNow(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.update.check();
  });
}

/** The full `tabs.list()` snapshot over the sidebar bridge. */
function tabsList(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

/**
 * Wait until the scheduled startup check has completed: `lastCheckedAt` is
 * stamped and `checking` is false.
 */
async function waitForStartupCheck(sidebar: Page): Promise<BridgeUpdateState> {
  await expect
    .poll(
      async () => {
        const s = await updateState(sidebar);
        return s.lastCheckedAt !== null && !s.checking;
      },
      { message: "expected the startup update check to complete" },
    )
    .toBe(true);
  return updateState(sidebar);
}

/** The unpackaged app's own version (`app.getVersion()`, "0.0.0" in dev builds). */
function appVersion(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app: electronApp }) => electronApp.getVersion());
}

/** Fresh per-test userData dir. */
function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), "zeo-update-"));
}

test.describe("PRD 9.6 in-app update check (offline fixture feed)", () => {
  // §8: feed v9.9.9 -> banner with 9.9.9; state has available/error/lastCheckedAt.
  test("a newer feed release shows the sidebar banner and fills update.state()", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      const banner = sidebar.getByTestId("update-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Update available: zeo 9.9.9");

      const state = await waitForStartupCheck(sidebar);
      expect(state.available).toEqual({ version: "9.9.9", url: releaseUrl("9.9.9") });
      expect(state.error).toBeNull();
      expect(state.lastCheckedAt).not.toBeNull();
      expect(state.checking).toBe(false);
      expect(state.enabled).toBe(true);
      expect(server.hits()).toBe(1);

      // The same slice rides the TabsState broadcast.
      const snapshot = await tabsList(sidebar);
      expect(snapshot.update.available?.version).toBe("9.9.9");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: a 200 `{}` after an update was seen keeps `available`, reports malformed.
  test("a malformed feed after an update was seen keeps available and reports the error", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      const before = await waitForStartupCheck(sidebar);
      expect(before.available?.version).toBe("9.9.9");

      server.respond({});
      await checkNow(sidebar);

      const after = await updateState(sidebar);
      expect(server.hits()).toBe(2);
      expect(after.available?.version).toBe("9.9.9");
      expect(after.error).toBe("malformed feed");
      expect(after.checking).toBe(false);
      await expect(sidebar.getByTestId("update-banner")).toContainText(
        "Update available: zeo 9.9.9",
      );
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: relaunch within the 24 h interval does not fetch until a manual check.
  test("a relaunch inside the interval does not fetch until update.check()", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const first = await launch(userDataDir, { feedUrl: server.feedUrl });
    let firstCheckedAt: number | null;
    try {
      firstCheckedAt = (await waitForStartupCheck(first.sidebar)).lastCheckedAt;
      expect(server.hits()).toBe(1);
      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    const second = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      // The persisted lastCheckedAt is seeded at startup...
      await expect
        .poll(async () => (await updateState(second.sidebar)).lastCheckedAt)
        .toBe(firstCheckedAt);
      // ...so the startup check (100 ms after launch) is rate-limited: give it
      // well past its delay and confirm the feed was never hit again.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(server.hits()).toBe(1);
      expect((await updateState(second.sidebar)).lastCheckedAt).toBe(firstCheckedAt);

      // A manual check is never rate-limited.
      await checkNow(second.sidebar);
      expect(server.hits()).toBe(2);
      const state = await updateState(second.sidebar);
      expect(state.available?.version).toBe("9.9.9");
      expect(state.lastCheckedAt).not.toBe(firstCheckedAt);
    } finally {
      await second.app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: dismissing hides the banner and survives a relaunch on the same feed.
  test("dismissing hides the banner and persists across a relaunch", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const first = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      const banner = first.sidebar.getByTestId("update-banner");
      await expect(banner).toContainText("Update available: zeo 9.9.9");
      await banner.getByRole("button", { name: "Dismiss update" }).click();
      await expect(banner).toHaveCount(0);
      expect((await updateState(first.sidebar)).available).toBeNull();
      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    const second = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      await expect
        .poll(async () => (await updateState(second.sidebar)).lastCheckedAt)
        .not.toBeNull();
      expect((await updateState(second.sidebar)).available).toBeNull();
      await expect(second.sidebar.getByTestId("update-banner")).toHaveCount(0);

      // The relaunch's startup check is rate-limited, so the null above alone
      // would not prove the dismissal persisted: a real fetch of the SAME
      // version must still yield nothing.
      const hitsBefore = server.hits();
      await checkNow(second.sidebar);
      expect(server.hits()).toBe(hitsBefore + 1);
      const state = await updateState(second.sidebar);
      expect(state.error).toBeNull();
      expect(state.available).toBeNull();
      await expect(second.sidebar.getByTestId("update-banner")).toHaveCount(0);
    } finally {
      await second.app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: a version newer than the dismissed one shows again.
  test("a release newer than the dismissed version shows the banner again", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      const banner = sidebar.getByTestId("update-banner");
      await expect(banner).toContainText("Update available: zeo 9.9.9");
      await banner.getByRole("button", { name: "Dismiss update" }).click();
      await expect(banner).toHaveCount(0);

      // Same version again: still dismissed.
      await checkNow(sidebar);
      expect((await updateState(sidebar)).available).toBeNull();
      await expect(banner).toHaveCount(0);

      server.respond(release("9.9.10"));
      await checkNow(sidebar);
      await expect(banner).toContainText("Update available: zeo 9.9.10");
      const state = await updateState(sidebar);
      expect(state.available).toEqual({ version: "9.9.10", url: releaseUrl("9.9.10") });
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: an HTTP 500 sets the error, keeps available, and shows in settings.
  test("an HTTP error keeps available and surfaces on the settings status line", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      const before = await waitForStartupCheck(sidebar);
      expect(before.available?.version).toBe("9.9.9");

      server.respond({ message: "boom" }, 500);
      await checkNow(sidebar);

      const state = await updateState(sidebar);
      expect(server.hits()).toBe(2);
      expect(state.error).toBe("HTTP 500");
      expect(state.available).toEqual({ version: "9.9.9", url: releaseUrl("9.9.9") });
      expect(state.checking).toBe(false);

      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commands.run("settings.openGeneral");
      });
      const settings = await settingsWindow(app);
      await expect(settings.getByTestId("update-status")).toContainText(
        "Could not check for updates (HTTP 500)",
      );
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: a prerelease and a release equal to the running version are not updates.
  test("prerelease and equal-version releases leave available null", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      // Start from a non-null `available` so each null below is a real clear.
      expect((await waitForStartupCheck(sidebar)).available?.version).toBe("9.9.9");

      server.respond(release("9.9.10", { prerelease: true }));
      await checkNow(sidebar);
      let state = await updateState(sidebar);
      expect(state.error).toBeNull();
      expect(state.available).toBeNull();
      await expect(sidebar.getByTestId("update-banner")).toHaveCount(0);

      // Back to a real update, then the running version itself.
      server.respond(release("9.9.9"));
      await checkNow(sidebar);
      expect((await updateState(sidebar)).available?.version).toBe("9.9.9");

      const current = await appVersion(app);
      server.respond(release(current));
      await checkNow(sidebar);
      state = await updateState(sidebar);
      expect(state.error).toBeNull();
      expect(state.available).toBeNull();
      await expect(sidebar.getByTestId("update-banner")).toHaveCount(0);
      expect(server.hits()).toBe(4);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8: with the setting off, the startup check does nothing; manual still works.
  test("with automatic checks disabled, only a manual check fetches", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();

    // Launch #1 has NO feed override, so nothing is scheduled and lastCheckedAt
    // stays null: the relaunch below is then gated by the switch alone, never
    // by the 24 h rate limit.
    const first = await launch(userDataDir);
    try {
      await first.sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.settings.setUpdateCheckEnabled(false);
      });
      const state = await updateState(first.sidebar);
      expect(state.enabled).toBe(false);
      expect(state.lastCheckedAt).toBeNull();
      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }
    expect(server.hits()).toBe(0);

    const second = await launch(userDataDir, { feedUrl: server.feedUrl });
    try {
      expect((await updateState(second.sidebar)).enabled).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await expect(second.sidebar.getByTestId("update-banner")).toHaveCount(0);
      expect(server.hits()).toBe(0);
      expect((await updateState(second.sidebar)).lastCheckedAt).toBeNull();

      await checkNow(second.sidebar);
      expect(server.hits()).toBe(1);
      expect((await updateState(second.sidebar)).available?.version).toBe("9.9.9");
      await expect(second.sidebar.getByTestId("update-banner")).toContainText(
        "Update available: zeo 9.9.9",
      );
    } finally {
      await second.app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 origin (homebrew): the banner routes to settings General; Copy copies.
  test("homebrew origin: How to upgrade opens settings General and Copy copies the command", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, {
      feedUrl: server.feedUrl,
      origin: "homebrew",
    });
    try {
      expect((await updateState(sidebar)).origin).toBe("homebrew");
      const banner = sidebar.getByTestId("update-banner");
      await expect(banner).toContainText("Update available: zeo 9.9.9");
      await expect(banner.getByRole("button", { name: "Open release" })).toHaveCount(0);

      // Seed the clipboard so the assertion below proves Copy wrote it.
      await app.evaluate(({ clipboard }) => clipboard.writeText("zeo-update-e2e-sentinel"));

      await banner.getByRole("button", { name: "How to upgrade" }).click();
      await expect
        .poll(async () => {
          const s = await tabsList(sidebar);
          return s.settingsOpen === true && s.settingsSection === "general";
        })
        .toBe(true);

      const settings = await settingsWindow(app);
      await expect(settings.getByTestId("update-status")).toContainText("9.9.9");
      await expect(settings.locator("code", { hasText: "brew upgrade --cask zeo" })).toBeVisible();
      await expect(settings.getByTestId("update-open-release")).toHaveCount(0);
      await settings.getByTestId("update-copy-command").click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe("brew upgrade --cask zeo");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 origin (direct): Open release calls shell.openExternal once with html_url.
  test("direct origin: Open release calls shell.openExternal once with the html_url", async () => {
    const server = await startFixtureServer(release("9.9.9"));
    const userDataDir = tempUserData();
    const { app, sidebar } = await launch(userDataDir, {
      feedUrl: server.feedUrl,
      origin: "direct",
    });
    try {
      await app.evaluate(({ shell }) => {
        const g = globalThis as unknown as { __zeoOpened: string[] };
        g.__zeoOpened = [];
        shell.openExternal = async (url: string): Promise<void> => {
          g.__zeoOpened.push(url);
        };
      });
      const opened = (): Promise<string[]> =>
        app.evaluate(() => (globalThis as unknown as { __zeoOpened: string[] }).__zeoOpened);

      expect((await updateState(sidebar)).origin).toBe("direct");
      const banner = sidebar.getByTestId("update-banner");
      await expect(banner).toContainText("Update available: zeo 9.9.9");
      await expect(banner.getByRole("button", { name: "How to upgrade" })).toHaveCount(0);

      await banner.getByRole("button", { name: "Open release" }).click();
      await expect.poll(opened).toEqual([releaseUrl("9.9.9")]);
      // Exactly once: give a stray second call time to land, then re-read.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await opened()).toEqual([releaseUrl("9.9.9")]);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
