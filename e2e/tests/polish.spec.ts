import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// PRD 10.7 — the e2e oracle for every expected color/geometry is the same pure
// @zeo/core function the renderer/main applies, never a copied table or formula.
import {
  SEMANTIC_TOKENS,
  contentRect,
  contrastAudit,
  splitPaneBounds,
  themeTokens,
} from "@zeo/core";
import type { ChromeState, Rect, Space, SpaceTheme, ZeoApi } from "@zeo/core";
import { waitForViewUrl, waitForViewsIdle, VIEW_POLL_TIMEOUT_MS } from "./helpers/view";
import { tokenBackground } from "./helpers/token";
import { assertFocusRings, assertFocusRingsByTab, assertHitTargets } from "./helpers/a11y";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Same layout as chrome.spec.ts / motion.spec.ts.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<
  ZeoApi,
  | "tabs"
  | "spaces"
  | "commandBar"
  | "commands"
  | "chrome"
  | "find"
  | "splitView"
  | "favorites"
  | "zoom"
  | "downloads"
>;

// --- Window lookups, copied from motion.spec.ts / chrome.spec.ts. --------------

async function sidebarWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();
  const deadline = Date.now() + VIEW_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.getByTestId("sidebar").count()) > 0) {
          return w;
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution context.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No renderer window exposing data-testid="sidebar" was found');
}

async function windowByUrl(app: ElectronApplication, urlSubstring: string): Promise<Page> {
  const deadline = Date.now() + VIEW_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(urlSubstring)) {
          return w;
        }
      } catch {
        // A navigating/loading WebContentsView can momentarily lose its context.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No window whose url includes "${urlSubstring}" was found`);
}

async function settingsWindow(app: ElectronApplication): Promise<Page> {
  return windowByUrl(app, "view=settings");
}

async function overlayWindow(app: ElectronApplication): Promise<Page> {
  return windowByUrl(app, "view=command-bar");
}

/**
 * Launch the packaged Electron build against a temp userData dir with default
 * settings: ZEO_E2E=1 (motion off, per PRD 10.7 §5), no ZEO_E2E_MOTION. Mirrors
 * chrome.spec.ts / motion.spec.ts's `launch`. `downloadsDir`, when given, is
 * wired via `ZEO_DOWNLOADS_DIR` (required whenever `ZEO_E2E=1` and a test
 * drives a real download — downloads.spec.ts's `launch` does the same; without
 * it main's save path resolves to `undefined` and a download never settles).
 */
async function launch(
  userDataDir: string,
  downloadsDir?: string,
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
      ...(downloadsDir !== undefined ? { ZEO_DOWNLOADS_DIR: downloadsDir } : {}),
    },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

// --- Bridge helpers --------------------------------------------------------------

function runCommand(page: Page, id: string): Promise<void> {
  return page.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd as Parameters<ZeoBridge["commands"]["run"]>[0]);
  }, id);
}

function readSpaces(sidebar: Page): Promise<{ spaces: Space[]; activeSpaceId: string }> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.list();
  });
}

function createSpace(sidebar: Page, name: string): Promise<Space> {
  return sidebar.evaluate((n) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.create(n);
  }, name);
}

function setTheme(sidebar: Page, id: string, theme: SpaceTheme): Promise<void> {
  return sidebar.evaluate(
    (data) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.setTheme(data.id, data.theme);
    },
    { id, theme },
  );
}

function activateSpace(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((spaceId) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.activate(spaceId);
  }, id);
}

function settingsOpen(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const state = await zeo.tabs.list();
    return (state as unknown as { settingsOpen: boolean }).settingsOpen === true;
  });
}

/** Open the settings view (once) and return its {@link Page}. */
async function openSettings(app: ElectronApplication, sidebar: Page): Promise<Page> {
  await runCommand(sidebar, "settings.open");
  await expect.poll(() => settingsOpen(sidebar)).toBe(true);
  const settings = await settingsWindow(app);
  await expect(settings.getByTestId("settings")).toHaveCount(1);
  return settings;
}

async function resetThemeSource(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "system";
    })
    .catch(() => undefined);
}

/**
 * Emulate `scheme` on every one of `pages` (nativeTheme does not reach a
 * renderer's `prefers-color-scheme` under xvfb/CI — theme.spec.ts's
 * `followAppearance` documents the same). Also sets `nativeTheme.themeSource`
 * so process-wide state matches, though no assertion depends on it.
 */
async function setAppearance(
  app: ElectronApplication,
  pages: Page[],
  scheme: "light" | "dark",
): Promise<void> {
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, scheme);
  for (const page of pages) {
    if (!page.isClosed()) await page.emulateMedia({ colorScheme: scheme });
  }
}

/** Every {@link SEMANTIC_TOKENS} value computed on `page`'s `<html>`. */
function readSemanticTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const t of tokens) out[t] = style.getPropertyValue(t).trim();
    return out;
  }, SEMANTIC_TOKENS as unknown as string[]);
}

/** The live computed `color` of `.sidebar__title`. */
function sidebarTitleColor(sidebar: Page): Promise<string> {
  return sidebar
    .locator(".sidebar__title")
    .evaluate((el) => getComputedStyle(el).color);
}

// ================================================================================
// §8 — theme tokens and the contrast audit
// ================================================================================

test.describe("PRD 10.7 polish — tokens and contrast", () => {
  test("SEMANTIC_TOKENS on every surface equal themeTokens(), and contrastAudit passes, for A/B/C in light and dark", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-polish-tokens-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const overlay = await overlayWindow(app);
      const settings = await openSettings(app, sidebar);

      // Three themed spaces, mirroring motion.spec.ts's setupSpaces.
      const before = await readSpaces(sidebar);
      const a = before.activeSpaceId;
      const aTheme: SpaceTheme = { stops: ["iris"], intensity: 1 };
      await setTheme(sidebar, a, aTheme);
      const bSpace = await createSpace(sidebar, "B");
      const bTheme: SpaceTheme = { stops: ["rose", "amber"], intensity: 1 };
      await setTheme(sidebar, bSpace.id, bTheme);
      const cSpace = await createSpace(sidebar, "C");
      const cTheme: SpaceTheme = { stops: ["teal"], intensity: 1 };
      await setTheme(sidebar, cSpace.id, cTheme);
      const spaces: { id: string; theme: SpaceTheme }[] = [
        { id: a, theme: aTheme },
        { id: bSpace.id, theme: bTheme },
        { id: cSpace.id, theme: cTheme },
      ];

      for (const appearance of ["light", "dark"] as const) {
        await setAppearance(app, [sidebar, overlay, settings], appearance);
        for (const space of spaces) {
          await activateSpace(sidebar, space.id);

          const expected = themeTokens(space.theme, appearance);
          await expect
            .poll(() => readSemanticTokens(sidebar), {
              message: `sidebar tokens for space ${space.id} (${appearance})`,
            })
            .toEqual(expected);
          await expect
            .poll(() => readSemanticTokens(overlay), {
              message: `overlay tokens for space ${space.id} (${appearance})`,
            })
            .toEqual(expected);
          await expect
            .poll(() => readSemanticTokens(settings), {
              message: `settings tokens for space ${space.id} (${appearance})`,
            })
            .toEqual(expected);

          // contrastAudit: every one of the 17 checks passes its floor.
          const audit = contrastAudit(space.theme, appearance);
          const failing = audit.filter((c) => !c.pass);
          expect(failing, JSON.stringify(failing)).toEqual([]);
          expect(audit.length).toBe(17);

          // .sidebar__title (the active space's label) is painted in --ink-secondary.
          const inkSecondary = await tokenBackground(sidebar, "--ink-secondary");
          await expect
            .poll(() => sidebarTitleColor(sidebar))
            .toBe(inkSecondary);
        }
      }
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// §8/§10 — geometry: contentRect and splitPaneBounds across the size/sidebar matrix
// ================================================================================

/** The main window's content size, as main reads it for every bounds formula. */
function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0].getContentSize();
    return { width, height };
  });
}

function setContentSize(app: ElectronApplication, w: number, h: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
    },
    { w, h },
  );
}

function setSidebarWidth(sidebar: Page, px: number): Promise<void> {
  return sidebar.evaluate(
    (w) => (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.setSidebarWidth(w),
    px,
  );
}

function chromeState(sidebar: Page): Promise<ChromeState> {
  return sidebar.evaluate(() => (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.state());
}

/** The native bounds of the window's child view whose URL contains `sub`. */
function nativeBounds(app: ElectronApplication, sub: string): Promise<Rect | null> {
  return app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (const child of win.contentView.children) {
      const wc = (child as { webContents?: { getURL(): string } }).webContents;
      if (wc != null && wc.getURL().includes(s)) {
        return child.getBounds();
      }
    }
    return null;
  }, sub);
}

/** Box of every `.window-card` element, in document order. */
function cardBoxes(sidebar: Page): Promise<Rect[]> {
  return sidebar.locator(".window-card").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

/** Create a `data:` tab carrying `token`, make it active, and wait for its view. */
async function activeTokenTab(
  app: ElectronApplication,
  sidebar: Page,
  token: string,
): Promise<string> {
  const id = await sidebar.evaluate(async (t) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const tab = await zeo.tabs.create("data:text/html," + t);
    await zeo.tabs.activate(tab.id);
    return tab.id;
  }, token);
  await waitForViewUrl(app, token);
  return id;
}

function splitWith(sidebar: Page, tabId: string): Promise<void> {
  return sidebar.evaluate((id) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.splitView.splitWith(id);
  }, tabId);
}

function setRatio(sidebar: Page, ratio: number): Promise<void> {
  return sidebar.evaluate((r) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.splitView.setRatio(r);
  }, ratio);
}

test.describe("PRD 10.7 polish — geometry", () => {
  test("the active view and .window-card equal contentRect across content sizes and sidebar widths", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-polish-geo-single-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const TOKEN = "ZEOPOLISH_ACTIVE";
      await activeTokenTab(app, sidebar, TOKEN);

      // Every size must fit the runner's display: the GitHub macOS runner
      // clamps a 1280x800 request to a 677 px tall content area, so the
      // matrix stays under that (and at or above MIN_WINDOW_SIZE, 640x400).
      const SIZES = [
        [1200, 640],
        [1024, 600],
        [640, 400],
      ] as const;
      const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
      for (const [w, h] of SIZES) {
        expect(
          w <= workArea.width && h <= workArea.height,
          `runner display too small for ${w}x${h}: work area ${workArea.width}x${workArea.height}`,
        ).toBe(true);
      }

      for (const [w, h] of SIZES) {
        await setContentSize(app, w, h);
        for (const width of [200, 240, 360]) {
          await setSidebarWidth(sidebar, width);
          await expect
            .poll(async () => {
              const { width: cw, height: ch } = await contentSize(app);
              const chrome = await chromeState(sidebar);
              const want = contentRect(cw, ch, chrome);
              const bounds = await nativeBounds(app, TOKEN);
              const cards = await cardBoxes(sidebar);
              // A clamped resize (e.g. xvfb's screen refusing 1280x800) must
              // not silently shrink the matrix: the applied content size and
              // the applied sidebar width must equal what was requested, not
              // just be self-consistent with contentRect.
              const sizeMatches = cw === w && ch === h;
              const sidebarMatches = chrome.sidebarWidth === width;
              return sizeMatches &&
                sidebarMatches &&
                JSON.stringify(bounds) === JSON.stringify(want) &&
                JSON.stringify(cards) === JSON.stringify([want])
                ? "ok"
                : JSON.stringify({
                    requested: { w, h, sidebarWidth: width },
                    applied: { cw, ch, sidebarWidth: chrome.sidebarWidth },
                    bounds,
                    cards,
                    want,
                  });
            }, { message: `geometry at ${w}x${h}, sidebar ${width}` })
            .toBe("ok");
        }

        // Collapsed sidebar.
        await runCommand(sidebar, "view.toggleSidebar");
        await expect.poll(async () => (await chromeState(sidebar)).sidebarCollapsed).toBe(true);
        await expect
          .poll(async () => {
            const { width: cw, height: ch } = await contentSize(app);
            const chrome = await chromeState(sidebar);
            const want = contentRect(cw, ch, chrome);
            const bounds = await nativeBounds(app, TOKEN);
            const cards = await cardBoxes(sidebar);
            const sizeMatches = cw === w && ch === h;
            return sizeMatches &&
              chrome.sidebarCollapsed === true &&
              JSON.stringify(bounds) === JSON.stringify(want) &&
              JSON.stringify(cards) === JSON.stringify([want])
              ? "ok"
              : JSON.stringify({
                  requested: { w, h },
                  applied: { cw, ch, sidebarCollapsed: chrome.sidebarCollapsed },
                  bounds,
                  cards,
                  want,
                });
          }, { message: `collapsed geometry at ${w}x${h}` })
          .toBe("ok");
        await runCommand(sidebar, "view.toggleSidebar");
        await expect.poll(async () => (await chromeState(sidebar)).sidebarCollapsed).toBe(false);
      }
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("split-view panes and .window-card rects equal splitPaneBounds at ratios 0.5 and 0.3", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-polish-geo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      // Two distinct, identifiable tabs (tokens embedded in their `data:` URL,
      // not their ids — `nativeBounds` below matches by live WebContents URL).
      const LEFT_TOKEN = "ZEOPOLISH_LEFT";
      const RIGHT_TOKEN = "ZEOPOLISH_RIGHT";
      const leftId = await sidebar.evaluate(async (token) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return (await zeo.tabs.create("data:text/html," + token)).id;
      }, LEFT_TOKEN);
      await waitForViewUrl(app, LEFT_TOKEN);
      const rightId = await sidebar.evaluate(async (token) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return (await zeo.tabs.create("data:text/html," + token)).id;
      }, RIGHT_TOKEN);
      await waitForViewUrl(app, RIGHT_TOKEN);
      // `tabs.create` activates the new tab, so the left tab must be
      // re-activated before `splitWith` — otherwise the active tab IS the
      // right tab and the call rejects with "cannot split a tab with itself".
      await sidebar.evaluate((id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.activate(id);
      }, leftId);
      await splitWith(sidebar, rightId);
      await waitForViewUrl(app, "view=divider");

      for (const ratio of [0.5, 0.3]) {
        await setRatio(sidebar, ratio);
        await expect
          .poll(async () => {
            const { width, height } = await contentSize(app);
            const chrome = await chromeState(sidebar);
            const want = splitPaneBounds(width, height, chrome, ratio);
            const leftBounds = await nativeBounds(app, LEFT_TOKEN);
            const rightBounds = await nativeBounds(app, RIGHT_TOKEN);
            const dividerBounds = await nativeBounds(app, "view=divider");
            const cards = await cardBoxes(sidebar);
            const cardsMatch =
              cards.length === 2 &&
              JSON.stringify(cards[0]) === JSON.stringify(want.left) &&
              JSON.stringify(cards[1]) === JSON.stringify(want.right);
            return JSON.stringify(leftBounds) === JSON.stringify(want.left) &&
              JSON.stringify(rightBounds) === JSON.stringify(want.right) &&
              JSON.stringify(dividerBounds) === JSON.stringify(want.divider) &&
              cardsMatch
              ? "ok"
              : JSON.stringify({ leftBounds, rightBounds, dividerBounds, cards, want });
          }, { message: `split geometry at ratio ${ratio}` })
          .toBe("ok");
      }
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// §6/§7 — focus ring and hit targets
// ================================================================================
// assertFocusRings and assertHitTargets now live in ./helpers/a11y.ts (shared
// with update.spec.ts and quick-browse.spec.ts) and return the set of
// identifiers they actually measured/focused, so a required-coverage list can
// be asserted against a real sweep result instead of a comment's claim.


/** A trivial same-origin fixture page, for zoom (host-keyed) and downloads. */
async function startFixtureServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const body = Buffer.alloc(4096, 0x7a);
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><meta charset=utf-8><title>zeo-polish-fixture</title><p>fixture</p>");
      return;
    }
    if (pathname === "/file.bin") {
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="polish.bin"',
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to an inet address");
  }
  const port = (address as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Poll `zeo.downloads.list()` until every entry matches `predicate`. */
async function pollDownloads(
  sidebar: Page,
  predicate: (items: { state: string }[]) => boolean,
  deadlineMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last: { state: string }[] = [];
  while (Date.now() < deadline) {
    last = await sidebar.evaluate(() => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.downloads.list();
    });
    if (predicate(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `pollDownloads: predicate not satisfied within ${deadlineMs}ms; last list = ${JSON.stringify(last)}`,
  );
}

// The §6 sidebar-row identifiers (PRD 10.7 §6's table, in the identify()
// format `a11y.ts`'s sweeps return) that this suite's sidebar setup must
// actually present and probe. Excludes update-banner-action/.update-banner__
// dismiss (covered by update.spec.ts, where the banner is actually shown) and
// the ThemePicker/space-name-input controls, which get their own phases below.
const SIDEBAR_MAIN_REQUIRED = [
  '[data-testid="sidebar-toggle"]',
  '[data-testid="nav-back"]',
  '[data-testid="nav-forward"]',
  '[data-testid="nav-reload"]',
  '[data-testid="sidebar-url-pill"]',
  '[data-testid="favorite-tile"]',
  ".tab-item__title",
  ".icon-button.tab-item__close",
  '[data-testid="tab-zoom"]',
  '[data-testid="new-tab-button"]',
  '[data-testid="clear-today-button"]',
  '[data-testid="downloads-indicator"]',
  '[data-testid="archived-toggle"]',
  ".archived-item__title",
  '[data-testid="archived-delete"]',
  '[data-testid="space-item"]',
  '[data-testid="new-space-button"]',
];

// sidebar-resize-handle is a §6 sidebar-row control (PRD 10.7 §6) and so is
// required for the focus-ring sweep, but it is one of §7's two named
// pointer-only drag-strip exemptions from the hit-target floor — so it is
// added only here, never to SIDEBAR_MAIN_REQUIRED (assertHitTargets skips it
// entirely as exempt, and would fail coverage if it were required there).
const SIDEBAR_MAIN_FOCUS_REQUIRED = [
  ...SIDEBAR_MAIN_REQUIRED,
  '[data-testid="sidebar-resize-handle"]',
];

const THEME_PICKER_REQUIRED = [
  '[data-testid="theme-kind-solid"]',
  '[data-testid="theme-kind-gradient"]',
  '[data-testid="theme-stop"]',
  '[data-testid="theme-swatch"]',
  '[data-testid="theme-intensity"]',
];

const OVERLAY_FIND_REQUIRED = [
  '[data-testid="find-previous"]',
  '[data-testid="find-next"]',
  '[data-testid="find-close"]',
];

test.describe("PRD 10.7 polish — sidebar and overlay focus ring and hit targets", () => {
  test("with a non-favorited zoomed tab, a favorite tile, a completed download archived on its own, a rename and ThemePicker open", async () => {
    // This setup chains a real download, a real zoom (host-keyed, so it needs a
    // live fixture page), and several focus-ring sweeps; under xvfb it can run
    // past the config's default 60s.
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-polish-sidebar-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-polish-dl-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, downloadsDir);
    try {
      // --- A tab to favorite (host-keyed origin, but never zoomed — it must
      // NOT be the zoomed tab below, or favoriting it would turn it into a
      // tile and remove it from the TabItem row entirely, taking tab-zoom
      // with it). ---
      const favTabId = await sidebar.evaluate(async (base) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const tab = await zeo.tabs.create(base + "/page.html?fav");
        await zeo.tabs.activate(tab.id);
        return tab.id;
      }, server.base);
      await waitForViewUrl(app, "page.html?fav");
      await sidebar.evaluate(
        (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.favorites.add(id);
        },
        favTabId,
      );
      await expect.poll(() => sidebar.getByTestId("favorite-tile").count()).toBeGreaterThan(0);

      // --- A distinct, non-favorited zoomed tab: it stays a normal
      // TabItem row for the whole test, so .tab-item__title,
      // .tab-item__close and tab-zoom are always present to probe. ---
      await sidebar.evaluate(async (base) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const tab = await zeo.tabs.create(base + "/page.html?zoom");
        await zeo.tabs.activate(tab.id);
        return tab.id;
      }, server.base);
      await waitForViewUrl(app, "page.html?zoom");
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.zoom.zoomIn();
      });
      await expect.poll(() => sidebar.getByTestId("tab-zoom").count()).toBeGreaterThan(0);

      // --- A third tab that triggers a real download; poll it to
      // "completed" (mirrors downloads.spec.ts's pollDownloads) rather than
      // just waiting for the views to go idle, so the assertion actually
      // proves the download settled, not just that navigation stopped. ---
      const downloadTabId = await sidebar.evaluate(async (base) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const tab = await zeo.tabs.create(base + "/file.bin");
        await zeo.tabs.activate(tab.id);
        return tab.id;
      }, server.base);
      await waitForViewsIdle(app);
      await pollDownloads(sidebar, (items) => items.some((d) => d.state === "completed"));

      // --- Archive that specific download tab (not tabs.clearToday, which
      // would also archive the zoomed tab and disable Clear). The zoomed tab
      // and the favorited tab both remain in "today", so
      // clear-today-button stays enabled and every sidebar §6 control is
      // simultaneously reachable. ---
      await sidebar.evaluate(
        (id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.tabs.archive(id);
        },
        downloadTabId,
      );
      await sidebar.getByTestId("archived-toggle").click();
      await expect(sidebar.getByTestId("archived-view")).toBeVisible();
      await expect.poll(() => sidebar.getByTestId("archived-item").count()).toBeGreaterThan(0);
      await expect(sidebar.getByTestId("clear-today-button")).toBeEnabled();

      // --- Phase A: the main sweep, with the favorite tile, the zoomed
      // today tab, and the archived view all present together. Coverage is
      // asserted, not assumed: assertFocusRings/assertHitTargets throw if any
      // SIDEBAR_MAIN_REQUIRED identifier was not actually found and probed. ---
      await assertFocusRings(sidebar, SIDEBAR_MAIN_FOCUS_REQUIRED);
      await assertHitTargets(sidebar, SIDEBAR_MAIN_REQUIRED);

      // PRD 10.7 §10 — a real Tab-key smoke test on the sidebar too,
      // alongside the synthetic sweep above. Seed focus programmatically
      // (not a click — clicking sidebar-toggle/sidebar-url-pill would
      // collapse the sidebar or open the command bar) on a control with no
      // side effects, then Tab and check every stop's ring.
      await sidebar.getByTestId("nav-back").evaluate((el) => (el as HTMLElement).focus());
      const sidebarTabVisited = await assertFocusRingsByTab(sidebar, 6);
      // nav-forward is the very next control after nav-back in DOM tab order
      // (WindowChrome.tsx's WINDOW_ROW_BUTTONS) and is never disabled (the
      // sidebar has no navigation flags), so Tab must land on it first — a
      // Tab press that does nothing would leave it unvisited.
      expect(
        [...sidebarTabVisited],
        `real Tab walk on sidebar visited: ${[...sidebarTabVisited].join(", ")}`,
      ).toContain('[data-testid="nav-forward"]');

      // --- Phase B: rename, in isolation. space-name-input is measured
      // (size, then focus ring) BEFORE anything else takes focus — a full
      // page sweep would eventually focus some other control, and
      // SpaceNameInput's onBlur cancels the edit and unmounts the input. ---
      const focusRing = await tokenBackground(sidebar, "--focus-ring");
      const activeSpaceId = (await readSpaces(sidebar)).activeSpaceId;
      await sidebar
        .locator(`[data-testid="space-item"][data-space-id="${activeSpaceId}"]`)
        .dblclick();
      const nameInput = sidebar.getByTestId("space-name-input");
      await expect(nameInput).toBeVisible();
      const box = await nameInput.boundingBox();
      expect(box, "space-name-input has a bounding box").not.toBeNull();
      expect(box!.width, "space-name-input width").toBeGreaterThanOrEqual(28);
      expect(box!.height, "space-name-input height").toBeGreaterThanOrEqual(28);
      // The input already has focus via `autoFocus`; nudge input modality to
      // keyboard (an ArrowRight leaves the text unchanged) rather than
      // blurring and refocusing it, since a blur would fire onBlur and
      // cancel the edit before the ring could ever be read.
      await nameInput.press("ArrowRight");
      const nameInputStyle = await nameInput.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
          outlineOffset: s.outlineOffset,
          outlineColor: s.outlineColor,
        };
      });
      expect(nameInputStyle, "focus ring on space-name-input").toEqual({
        outlineStyle: "solid",
        outlineWidth: "2px",
        outlineOffset: "1px",
        outlineColor: focusRing,
      });
      await nameInput.press("Escape");
      await expect(sidebar.getByTestId("space-name-input")).toHaveCount(0);

      // --- Phase C: ThemePicker, in isolation (space.editTheme's handler
      // calls cancelEdit() unconditionally, so it must run after the rename
      // phase has already completed and read its own state, not before). ---
      await runCommand(sidebar, "space.editTheme");
      await expect(sidebar.getByTestId("theme-picker")).toBeVisible();
      // theme-stop only renders for a 2-stop gradient theme (ThemePicker.tsx),
      // and the default space theme is a solid (1-stop) theme — switch kind
      // first so every §6 ThemePicker control, including theme-stop, is
      // actually on the page for the sweep to reach.
      await sidebar.getByTestId("theme-kind-gradient").click();
      await expect(sidebar.getByTestId("theme-stop")).toHaveCount(2);
      await assertFocusRings(sidebar, THEME_PICKER_REQUIRED);
      await assertHitTargets(sidebar, THEME_PICKER_REQUIRED);
      await sidebar.getByTestId("theme-intensity").press("Escape");
      await expect(sidebar.getByTestId("theme-picker")).toHaveCount(0);

      // --- Phase D: overlay, find pill open, with a page to search. ---
      const overlay = await overlayWindow(app);
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.find.open();
      });
      await expect(overlay.getByTestId("find-bar")).toBeVisible();
      await assertFocusRings(overlay, OVERLAY_FIND_REQUIRED);
      await assertHitTargets(overlay, OVERLAY_FIND_REQUIRED);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });
});

// §6/§7's per-section required identifiers: at least one control from each
// settings section body, so the sweep's coverage check catches a section that
// silently rendered no probeable controls (or where a click on the section
// nav failed to actually switch sections).
const SETTINGS_SECTION_REQUIRED: Record<string, string[]> = {
  general: [
    '[data-testid="settings-search-engine-duckduckgo"]',
    '[data-testid="update-auto-check"]',
    '[data-testid="settings-quick-browse-external"]',
  ],
  blocking: [
    '[data-testid="settings-blocking-enabled"]',
    '[data-testid="settings-allowlist-input"]',
    '[data-testid="settings-allowlist-add"]',
  ],
  profiles: ['[data-testid="settings-profile-create-name"]', '[data-testid="settings-profile-create"]'],
  history: ['[data-testid="settings-history-clear"]'],
  about: ['[data-testid="settings-close"]'],
};

test.describe("PRD 10.7 polish — settings focus ring and hit targets", () => {
  test("every settings section, plus the history-clear dialog", async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-polish-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar);

      // PRD 10.7 §10 — a real Tab-key smoke test on the settings page: from
      // the general section nav item, Tab should cycle focus through the
      // section items (and beyond), with every stop showing the same ring
      // §6 requires. This exercises real keyboard focus, not just the
      // synthetic `el.focus({ focusVisible: true })` sweep below.
      await settings.getByTestId("settings-section-general").click();
      await expect(
        settings.locator('[data-testid="settings-section-general"][aria-current="page"]'),
      ).toHaveCount(1);
      const tabVisited = await assertFocusRingsByTab(settings, 10);
      // settings-section-blocking is the next section-nav button after
      // settings-section-general in DOM order (SETTINGS_SECTIONS in
      // packages/core/src/settings.ts, rendered in that order as plain
      // <button>s with no tabindex overrides), so Tab must land on it first.
      expect(
        [...tabVisited],
        `real Tab walk should reach settings-section-blocking next; visited: ${[...tabVisited].join(", ")}`,
      ).toContain('[data-testid="settings-section-blocking"]');

      for (const section of ["general", "blocking", "profiles", "history", "about"]) {
        await settings.getByTestId(`settings-section-${section}`).click();
        await expect(
          settings.locator(`[data-testid="settings-section-${section}"][aria-current="page"]`),
        ).toHaveCount(1);
        if (section === "history") {
          // The trigger is disabled while the async stats read is loading;
          // sweeping before it settles would skip it as disabled.
          await expect(settings.getByTestId("settings-history-clear")).toBeEnabled();
        }
        const required = SETTINGS_SECTION_REQUIRED[section];
        const checked = await assertFocusRings(settings, required);
        expect(checked.size, `section ${section}`).toBeGreaterThan(0);
        await assertHitTargets(settings, required);
      }

      // The history-clear confirmation dialog.
      await settings.getByTestId("settings-section-history").click();
      await expect(settings.getByTestId("settings-history-stats")).toBeVisible();
      await settings.getByTestId("settings-history-clear").click();
      await expect(settings.getByTestId("settings-history-clear-dialog")).toBeVisible();
      const dialogRequired = [
        '[data-testid="settings-history-clear-cancel"]',
        '[data-testid="settings-history-clear-confirm"]',
      ];
      const dialogChecked = await assertFocusRings(settings, dialogRequired);
      expect(dialogChecked.size).toBeGreaterThan(0);
      await assertHitTargets(settings, dialogRequired);
      await settings.getByTestId("settings-history-clear-cancel").click();

      await settings.getByTestId("settings-close").click();
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
