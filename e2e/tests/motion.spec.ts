import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// PRD 10.7 — the e2e oracle for every expected color/duration is the same pure
// @zeo/core function (or constant) the renderer applies, never a copied table.
import {
  MOTION_BASE_MS,
  MOTION_FAST_MS,
  MOTION_SPACE_MS,
  contentRect,
  themeTokens,
} from "@zeo/core";
import type { Rect, Space, SpaceTheme, ZeoApi } from "@zeo/core";
import { waitForViewUrl, waitForViewsIdle } from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Same layout as space-theme.spec.ts / app.spec.ts.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<
  ZeoApi,
  "tabs" | "spaces" | "commandBar" | "commands" | "chrome" | "find"
>;

/** One `animationstart` observation recorded by {@link installMotionLogger}. */
interface MotionLogEntry {
  animationName: string;
  /** The event target's `className`, so a log can be filtered by element. */
  className: string;
  /** The computed `animation-duration` at the moment the animation started. */
  duration: string;
  /** `AnimationEvent.pseudoElement` (e.g. `"::after"`), or `null` on the element itself. */
  pseudoElement: string | null;
}

// --- Window lookups, copied from space-theme.spec.ts / page-search.spec.ts. -----

/** The renderer window that hosts the React sidebar. */
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
        // context; skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/** The overlay window (`?view=command-bar`), which hosts both the command bar
 *  and the find pill and is created eagerly at window creation. */
async function overlayWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes("view=command-bar")) {
          return w;
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution context.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No overlay window whose url includes "view=command-bar" was found within 15s');
}

/** The settings window (`?view=settings`), created lazily on first open. */
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
  throw new Error('No settings window whose url includes "view=settings" was found within 20s');
}

/**
 * Launch the packaged Electron build against a temp userData dir. `motion`
 * gates `ZEO_E2E_MOTION` (PRD 10.7 §5): only this spec ever sets it, so every
 * other spec keeps running with motion off. `reducedMotion`/`colorScheme` are
 * applied on the sidebar AND overlay pages with `emulateMedia` immediately,
 * because `nativeTheme`/native OS media-feature state does not reach a
 * renderer's `prefers-*` queries under xvfb or on CI (theme.spec.ts's
 * `followAppearance` documents the same for color scheme).
 */
async function launch(
  userDataDir: string,
  options: { motion: boolean; reducedMotion?: boolean },
): Promise<{ app: ElectronApplication; sidebar: Page; overlay: Page }> {
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
      ...(options.motion ? { ZEO_E2E_MOTION: "1" } : {}),
    },
  });
  const sidebar = await sidebarWindow(app);
  const overlay = await overlayWindow(app);
  if (options.reducedMotion) {
    await sidebar.emulateMedia({ reducedMotion: "reduce" });
    await overlay.emulateMedia({ reducedMotion: "reduce" });
  }
  return { app, sidebar, overlay };
}

/**
 * Installs a capture-phase `animationstart` listener on `page` that appends
 * every observation to `globalThis.__zeoMotion`, BEFORE any triggering action
 * runs (a listener installed after the action would race the animation).
 * `getComputedStyle(target, pseudoElement)` reads the duration off the exact
 * originating element/pseudo-element, matching what CSS actually applied.
 */
async function installMotionLogger(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bag = window as unknown as { __zeoMotion: MotionLogEntry[] };
    bag.__zeoMotion = [];
    document.addEventListener(
      "animationstart",
      (event) => {
        const e = event as AnimationEvent;
        const target = e.target;
        const className =
          target instanceof Element && typeof target.className === "string"
            ? target.className
            : "";
        const style = getComputedStyle(
          target as Element,
          e.pseudoElement === "" ? undefined : e.pseudoElement,
        );
        bag.__zeoMotion.push({
          animationName: e.animationName,
          className,
          duration: style.animationDuration,
          pseudoElement: e.pseudoElement === "" ? null : e.pseudoElement,
        });
      },
      true,
    );
  });
}

/** Reads back every entry the logger on `page` has recorded so far. */
function motionLog(page: Page): Promise<MotionLogEntry[]> {
  return page.evaluate(
    () => (window as unknown as { __zeoMotion: MotionLogEntry[] }).__zeoMotion,
  );
}

/** Empties the logger's buffer on `page` without removing the listener. */
function clearMotionLog(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __zeoMotion: MotionLogEntry[] }).__zeoMotion = [];
  });
}

/** Polls `page`'s log until an entry with `animationName` on a target whose
 *  `className` contains `classSubstring` shows up, then returns it. */
async function waitForLogEntry(
  page: Page,
  animationName: string,
  classSubstring: string,
): Promise<MotionLogEntry> {
  let found: MotionLogEntry | undefined;
  await expect
    .poll(
      async () => {
        const log = await motionLog(page);
        found = log.find(
          (entry) =>
            entry.animationName === animationName && entry.className.includes(classSubstring),
        );
        return found !== undefined;
      },
      { message: `expected a "${animationName}" entry on ".${classSubstring}"` },
    )
    .toBe(true);
  if (!found) {
    throw new Error("unreachable: poll resolved true without setting found");
  }
  return found;
}

// --- Bridge helpers -----------------------------------------------------------

function readSpaces(sidebar: Page): Promise<{ spaces: Space[]; activeSpaceId: string }> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.list();
  });
}

function createSpace(sidebar: Page, name: string): Promise<Space> {
  return sidebar.evaluate(async (n) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.create(n);
  }, name);
}

function setTheme(sidebar: Page, id: string, theme: SpaceTheme): Promise<void> {
  return sidebar.evaluate(
    async (data) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.setTheme(data.id, data.theme);
    },
    { id, theme },
  );
}

function activateSpace(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate(async (spaceId) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    await zeo.spaces.activate(spaceId);
  }, id);
}

function deleteSpace(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate(async (spaceId) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    await zeo.spaces.delete(spaceId);
  }, id);
}

function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd as Parameters<ZeoBridge["commands"]["run"]>[0]);
  }, id);
}

function settingsOpen(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const state = await zeo.tabs.list();
    return state.settingsOpen === true;
  });
}

function commandBarOpenState(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.commandBar.state()).open;
  });
}

function findOpenState(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.find.state()).open;
  });
}

/** Sets up three spaces of known order and theme: A (iris), B (rose+amber,
 *  gradient), C (teal). A is the launch-seeded space (renamed in place via
 *  `setTheme`, never renamed by name — only order and theme matter here). */
async function setupSpaces(sidebar: Page): Promise<{ a: string; b: string; c: string }> {
  const before = await readSpaces(sidebar);
  const a = before.activeSpaceId;
  await setTheme(sidebar, a, { stops: ["iris"], intensity: 1 });
  const b = await createSpace(sidebar, "B");
  await setTheme(sidebar, b.id, { stops: ["rose", "amber"], intensity: 1 });
  const c = await createSpace(sidebar, "C");
  await setTheme(sidebar, c.id, { stops: ["teal"], intensity: 1 });
  return { a, b: b.id, c: c.id };
}

/** The `.sidebar__space` wrapper's motion classes and `data-space-motion`. */
function spaceWrapperState(
  sidebar: Page,
): Promise<{ enterClasses: string[]; dataSpaceMotion: string | null }> {
  return sidebar.evaluate(() => {
    const el = document.querySelector(".sidebar__space");
    if (!el) throw new Error(".sidebar__space not found");
    return {
      enterClasses: Array.from(el.classList).filter((c) =>
        c.startsWith("sidebar__space--enter-"),
      ),
      dataSpaceMotion: el.getAttribute("data-space-motion"),
    };
  });
}

/** Count of `.window-tint-outgoing` layers currently mounted. */
function outgoingTintCount(sidebar: Page): Promise<number> {
  return sidebar.locator(".window-tint-outgoing").count();
}

/**
 * The browser-normalized `background-color` `cssColor` resolves to, computed
 * through a throwaway element on `page` — so comparing two colors expressed in
 * different notations (a `#rrggbb` literal vs. what an inline style read-back
 * reports) never produces a false mismatch from formatting alone.
 */
function computedColor(page: Page, cssColor: string): Promise<string> {
  return page.evaluate((c) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = c;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, cssColor);
}

/** The live computed `background-color` of the (currently mounted) outgoing tint layer. */
function outgoingTintColor(sidebar: Page): Promise<string> {
  return sidebar
    .locator(".window-tint-outgoing")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function resetThemeSource(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "system";
    })
    .catch(() => undefined);
}

// ================================================================================
// Motion enabled (ZEO_E2E_MOTION=1)
// ================================================================================

test.describe("PRD 10.7 motion — enabled", () => {
  test("space switches slide/fade the sidebar block and cross-fade the tint; content swaps instantly", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-space-"));
    const { app, sidebar } = await launch(userDataDir, { motion: true });
    try {
      await installMotionLogger(sidebar);
      const { a, b, c } = await setupSpaces(sidebar);

      // Tag A and C with distinct content tabs so their views are identifiable
      // in main once we switch back and forth.
      await activateSpace(sidebar, a);
      const tabA = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create("data:text/html,motion-a");
      });
      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.activate(id);
      }, tabA.id);
      await waitForViewUrl(app, "motion-a");
      await waitForViewsIdle(app);

      await activateSpace(sidebar, c);
      const tabC = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create("data:text/html,motion-c");
      });
      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.activate(id);
      }, tabC.id);
      await waitForViewUrl(app, "motion-c");
      await waitForViewsIdle(app);

      // Back to A before the timed A -> C switch below, so that switch is the
      // one under observation.
      await activateSpace(sidebar, a);
      await waitForViewsIdle(app);
      await clearMotionLog(sidebar);

      const irisTint = themeTokens({ stops: ["iris"], intensity: 1 }, "light")["--tint"];

      // A -> C: forward, plus the tint cross-fade.
      await activateSpace(sidebar, c);

      const forwardEntry = await waitForLogEntry(
        sidebar,
        "zeo-space-in-forward",
        "sidebar__space",
      );
      expect(forwardEntry.duration).toBe(`${MOTION_SPACE_MS / 1000}s`);
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-forward"],
        dataSpaceMotion: "forward",
      });

      await waitForLogEntry(sidebar, "zeo-tint-in", "window-tint");
      const outEntry = await waitForLogEntry(sidebar, "zeo-tint-out", "window-tint-outgoing");
      expect(outEntry.duration).toBe(`${MOTION_SPACE_MS / 1000}s`);

      // The tint-in entry is on .window-tint's ::after pseudo-element.
      const tintInEntry = (await motionLog(sidebar)).find(
        (entry) => entry.animationName === "zeo-tint-in",
      );
      expect(tintInEntry?.pseudoElement).toBe("::after");

      expect(await computedColor(sidebar, await outgoingTintColor(sidebar))).toBe(
        await computedColor(sidebar, irisTint),
      );
      await expect.poll(() => outgoingTintCount(sidebar), { timeout: 1_000 }).toBe(0);

      // Instant content swap: right after activate() resolves, main has
      // already hidden A's view and shown C's, at contentRect.
      const { width, height } = await app.evaluate(({ BrowserWindow }) => {
        const [w, h] = BrowserWindow.getAllWindows()[0].getContentSize();
        return { width: w, height: h };
      });
      const chrome = await sidebar.evaluate(() =>
        (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.state(),
      );
      const expectedRect = contentRect(width, height, chrome);
      const views = await app.evaluate(
        ({ BrowserWindow }, subs) => {
          const win = BrowserWindow.getAllWindows()[0];
          const find = (sub: string) => {
            for (const child of win.contentView.children) {
              const wc = (child as { webContents?: { getURL(): string } }).webContents;
              if (wc != null && wc.getURL().includes(sub)) {
                const view = child as unknown as {
                  getVisible(): boolean;
                  getBounds(): Rect;
                };
                return { visible: view.getVisible(), bounds: view.getBounds() };
              }
            }
            return null;
          };
          return { a: find(subs.a), c: find(subs.c) };
        },
        { a: "motion-a", c: "motion-c" },
      );
      expect(views.a?.visible).toBe(false);
      expect(views.c?.visible).toBe(true);
      expect(views.c?.bounds).toEqual(expectedRect);

      // C -> B: backward.
      await clearMotionLog(sidebar);
      await activateSpace(sidebar, b);
      const backwardEntry = await waitForLogEntry(
        sidebar,
        "zeo-space-in-backward",
        "sidebar__space",
      );
      expect(backwardEntry.duration).toBe(`${MOTION_SPACE_MS / 1000}s`);
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-backward"],
        dataSpaceMotion: "backward",
      });

      // Deleting the active space fades it in on whatever becomes active.
      await clearMotionLog(sidebar);
      await deleteSpace(sidebar, b);
      const fadeEntry = await waitForLogEntry(sidebar, "zeo-fade-in", "sidebar__space");
      expect(fadeEntry.duration).toBe(`${MOTION_SPACE_MS / 1000}s`);
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-fade"],
        dataSpaceMotion: "fade",
      });
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("opens: command bar, find, theme picker, settings sheet and the history-clear dialog each log zeo-enter", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-opens-"));
    const { app, sidebar, overlay } = await launch(userDataDir, { motion: true });
    try {
      // Loggers installed BEFORE any triggering action, on every page an
      // enter-motion element can render on.
      await installMotionLogger(overlay); // command bar, find pill
      await installMotionLogger(sidebar); // theme picker

      // Command bar: panel logs zeo-enter, scrim logs zeo-fade-in. A reopen
      // replays zeo-enter again.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("commands");
      });
      await expect.poll(() => commandBarOpenState(sidebar)).toBe(true);
      const panelEntry = await waitForLogEntry(overlay, "zeo-enter", "command-bar");
      expect(panelEntry.duration).toBe(`${MOTION_BASE_MS / 1000}s`);
      await waitForLogEntry(overlay, "zeo-fade-in", "command-bar-scrim");

      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.close();
      });
      await expect.poll(() => commandBarOpenState(sidebar)).toBe(false);
      await clearMotionLog(overlay);
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("commands");
      });
      await expect.poll(() => commandBarOpenState(sidebar)).toBe(true);
      await waitForLogEntry(overlay, "zeo-enter", "command-bar");
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.close();
      });
      await expect.poll(() => commandBarOpenState(sidebar)).toBe(false);

      // Find pill.
      await clearMotionLog(overlay);
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.find.open();
      });
      await expect.poll(() => findOpenState(sidebar)).toBe(true);
      await waitForLogEntry(overlay, "zeo-enter", "find-bar");
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.find.close();
      });

      // Theme picker (mounted inside the sidebar tree).
      await clearMotionLog(sidebar);
      await runCommand(sidebar, "space.editTheme");
      await expect(sidebar.getByTestId("theme-picker")).toBeVisible();
      await waitForLogEntry(sidebar, "zeo-enter", "theme-picker");
      await sidebar.getByTestId("theme-intensity").press("Escape");
      await expect(sidebar.getByTestId("theme-picker")).toHaveCount(0);

      // Settings is created lazily: open and close it once first, THEN
      // install the logger, so the panel's replay (not its very first mount)
      // is what gets captured — matching how the command bar and find pill
      // are logged on an already-live page.
      await runCommand(sidebar, "settings.open");
      await expect.poll(() => settingsOpen(sidebar)).toBe(true);
      let settings = await settingsWindow(app);
      await expect(settings.getByTestId("settings")).toHaveCount(1);
      await runCommand(sidebar, "settings.close");
      await expect.poll(() => settingsOpen(sidebar)).toBe(false);

      await installMotionLogger(settings);
      await runCommand(sidebar, "settings.openHistory");
      await expect.poll(() => settingsOpen(sidebar)).toBe(true);
      settings = await settingsWindow(app);
      await waitForLogEntry(settings, "zeo-enter", "settings");
      await waitForLogEntry(settings, "zeo-fade-in", "settings-scrim");

      // The history-clear dialog, triggered on the same, now-logged page.
      await expect(settings.getByTestId("settings-history-stats")).toBeVisible();
      await clearMotionLog(settings);
      await settings.getByTestId("settings-history-clear").click();
      await expect(settings.getByTestId("settings-history-clear-dialog")).toBeVisible();
      const dialogEntry = await waitForLogEntry(settings, "zeo-enter", "dialog");
      expect(dialogEntry.duration).toBe(`${MOTION_BASE_MS / 1000}s`);
      await waitForLogEntry(settings, "zeo-fade-in", "dialog-scrim");
      await settings.getByTestId("settings-history-clear-cancel").click();
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("hover: .tab-item transitions over --motion-fast with --ease-standard", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-hover-"));
    const { app, sidebar } = await launch(userDataDir, { motion: true });
    try {
      const { duration, timing } = await sidebar
        .getByTestId("tab-item")
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el);
          // `--transition-control` lists five comma-separated properties that
          // all share one timing function, so `transitionTimingFunction`'s
          // FIRST TOP-LEVEL entry (not just its first comma, which falls
          // inside `cubic-bezier(...)`'s own argument list) is what matters.
          const firstTiming = /^[^(]*\([^)]*\)/.exec(style.transitionTimingFunction)?.[0];
          return {
            duration: style.transitionDuration.split(",")[0]?.trim(),
            timing: firstTiming?.trim(),
          };
        });
      expect(duration).toBe(`${MOTION_FAST_MS / 1000}s`);
      expect(timing).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// Reduced motion (prefers-reduced-motion: reduce)
// ================================================================================

test.describe("PRD 10.7 motion — reduced motion", () => {
  test("space switches and opens become 120ms opacity fades; carets stop blinking", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-reduced-"));
    const { app, sidebar, overlay } = await launch(userDataDir, {
      motion: true,
      reducedMotion: true,
    });
    try {
      await installMotionLogger(sidebar);
      await installMotionLogger(overlay);
      const { a, c } = await setupSpaces(sidebar);
      await activateSpace(sidebar, a);
      await clearMotionLog(sidebar);

      await activateSpace(sidebar, c);
      // Under reduced motion the forward class still applies (direction is
      // unchanged), but its animation-name switches to zeo-fade-in.
      const spaceEntry = await waitForLogEntry(sidebar, "zeo-fade-in", "sidebar__space");
      expect(spaceEntry.duration).toBe("0.12s");
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-forward"],
        dataSpaceMotion: "forward",
      });

      const tintOutEntry = await waitForLogEntry(sidebar, "zeo-tint-out", "window-tint-outgoing");
      expect(tintOutEntry.duration).toBe("0.12s");
      const tintInEntry = (await motionLog(sidebar)).find(
        (entry) => entry.animationName === "zeo-tint-in",
      );
      expect(tintInEntry?.duration).toBe("0.12s");

      // Command-bar open.
      await clearMotionLog(overlay);
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("commands");
      });
      await expect.poll(() => commandBarOpenState(sidebar)).toBe(true);
      const cmdEntry = await waitForLogEntry(overlay, "zeo-fade-in", "command-bar");
      expect(cmdEntry.duration).toBe("0.12s");

      // caret-animation: manual on the space-name input.
      const supports = await sidebar.evaluate(() => CSS.supports("caret-animation", "manual"));
      expect(supports).toBe(true);
      const spaceId = (await readSpaces(sidebar)).activeSpaceId;
      await sidebar
        .locator(`[data-testid="space-item"][data-space-id="${spaceId}"]`)
        .dblclick();
      const caretAnimation = await sidebar
        .getByTestId("space-name-input")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("caret-animation"));
      expect(caretAnimation.trim()).toBe("manual");
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// Motion off (ZEO_E2E=1, no ZEO_E2E_MOTION — the default for every other spec)
// ================================================================================

test.describe("PRD 10.7 motion — off", () => {
  test("<html> carries zeo-motion-off, --motion-space computes 0ms, and a space switch animates nothing", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-off-"));
    const { app, sidebar } = await launch(userDataDir, { motion: false });
    try {
      const hasClass = await sidebar.evaluate(() =>
        document.documentElement.classList.contains("zeo-motion-off"),
      );
      expect(hasClass).toBe(true);
      const motionSpace = await sidebar.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--motion-space").trim(),
      );
      // Chromium serializes a zero-valued <time> custom property as "0s"
      // regardless of the "0ms" literal authored in tokens.css, so accept
      // either spelling of zero rather than the exact source text.
      expect(["0s", "0ms"]).toContain(motionSpace);

      await installMotionLogger(sidebar);
      const { c } = await setupSpaces(sidebar);
      await clearMotionLog(sidebar);
      await activateSpace(sidebar, c);

      // Give any (incorrectly firing) animation a moment to be observed.
      await sidebar.waitForTimeout(300);
      expect(await motionLog(sidebar)).toEqual([]);
      expect(await outgoingTintCount(sidebar)).toBe(0);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// App wiring guards: these must fail if App.tsx's refresh layout effect, or its
// replaySpaceMotion call, is removed (proven by a mutation run outside this file).
// ================================================================================

test.describe("PRD 10.7 motion — App wiring guards", () => {
  test("three consecutive switches each carry exactly one direction class, and the third logs forward again", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-guard-sequence-"));
    const { app, sidebar } = await launch(userDataDir, { motion: true });
    try {
      await installMotionLogger(sidebar);
      const { a, b, c } = await setupSpaces(sidebar);
      await activateSpace(sidebar, a);
      await clearMotionLog(sidebar);

      // A -> C: forward.
      await activateSpace(sidebar, c);
      await waitForLogEntry(sidebar, "zeo-space-in-forward", "sidebar__space");
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-forward"],
        dataSpaceMotion: "forward",
      });

      // C -> B: backward. If replaySpaceMotion did not clear the previous
      // class first, the forward class from the last switch would still be
      // present alongside it.
      await clearMotionLog(sidebar);
      await activateSpace(sidebar, b);
      await waitForLogEntry(sidebar, "zeo-space-in-backward", "sidebar__space");
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-backward"],
        dataSpaceMotion: "backward",
      });

      // B -> C: forward again. Without replaySpaceMotion (or the layout
      // effect calling it) ever running, no enter-* class — and no
      // animationstart — would appear at all on this or any prior switch.
      await clearMotionLog(sidebar);
      await activateSpace(sidebar, c);
      await waitForLogEntry(sidebar, "zeo-space-in-forward", "sidebar__space");
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-forward"],
        dataSpaceMotion: "forward",
      });
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("deleting the active space, then switching forward, still logs zeo-space-in-forward", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-guard-delete-"));
    const { app, sidebar } = await launch(userDataDir, { motion: true });
    try {
      await installMotionLogger(sidebar);
      const { a, b, c } = await setupSpaces(sidebar);
      await activateSpace(sidebar, b);
      await clearMotionLog(sidebar);

      // Deleting the active space (B) fades whatever becomes active in.
      await deleteSpace(sidebar, b);
      await waitForLogEntry(sidebar, "zeo-fade-in", "sidebar__space");
      const afterDelete = await readSpaces(sidebar);
      expect(afterDelete.spaces.map((s) => s.id)).toEqual([a, c]);

      // A forward switch right after the deletion must still resolve to
      // "forward", not fall back to "fade" from a stale previous id. This is
      // exactly what breaks if App's post-switch `previousRef.current = ...`
      // update is removed: the effect would keep comparing against the
      // deleted space's id forever.
      await clearMotionLog(sidebar);
      await activateSpace(sidebar, c);
      await waitForLogEntry(sidebar, "zeo-space-in-forward", "sidebar__space");
      expect(await spaceWrapperState(sidebar)).toEqual({
        enterClasses: ["sidebar__space--enter-forward"],
        dataSpaceMotion: "forward",
      });
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("editing the active space's theme, then switching away, cross-fades from the edited theme", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-motion-guard-edit-"));
    const { app, sidebar } = await launch(userDataDir, { motion: true });
    try {
      await installMotionLogger(sidebar);
      const { a, c } = await setupSpaces(sidebar);
      await activateSpace(sidebar, a);
      await waitForViewsIdle(app);

      // Edit A's (the active space's) theme in place: iris -> rose. This
      // commits without a space switch, so it can only reach `previousRef`
      // through App's refresh layout effect.
      const roseTheme: SpaceTheme = { stops: ["rose"], intensity: 1 };
      await setTheme(sidebar, a, roseTheme);
      await expect
        .poll(async () => {
          const { spaces } = await readSpaces(sidebar);
          return spaces.find((s) => s.id === a)?.theme;
        })
        .toEqual(roseTheme);

      const roseTint = themeTokens(roseTheme, "light")["--tint"];
      const irisTint = themeTokens({ stops: ["iris"], intensity: 1 }, "light")["--tint"];
      expect(roseTint).not.toBe(irisTint);

      await clearMotionLog(sidebar);
      await activateSpace(sidebar, c);
      await waitForLogEntry(sidebar, "zeo-tint-out", "window-tint-outgoing");

      // If App's refresh effect were removed, `previousRef.current.theme`
      // would still hold A's PRE-edit theme (iris), and the outgoing layer
      // would incorrectly paint iris's tint instead of rose's.
      await expect
        .poll(async () => (await outgoingTintCount(sidebar)) > 0)
        .toBe(true);
      const observed = await outgoingTintColor(sidebar);
      expect(await computedColor(sidebar, observed)).toBe(await computedColor(sidebar, roseTint));
      expect(await computedColor(sidebar, observed)).not.toBe(
        await computedColor(sidebar, irisTint),
      );
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
