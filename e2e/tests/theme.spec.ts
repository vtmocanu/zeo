import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// PRD 10.1: the e2e oracle is the same pure token function the renderer applies,
// so the computed custom properties are compared against `themeTokens` itself
// rather than a copied table of colors. Resolves to @zeo/core's built dist.
import { themeTokens } from "@zeo/core";
import type { Appearance, ZeoApi } from "@zeo/core";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Same layout as zoom.spec.ts / blocking.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "commandBar" | "commands">;

/** Poll bound for an appearance switch to reach a renderer's computed style. */
const APPEARANCE_POLL_TIMEOUT_MS = 10_000;

/**
 * The renderer window that hosts the React sidebar. Copied from zoom.spec.ts:
 * `firstWindow()` cannot be trusted because each tab and the overlay surface as
 * their own windows, so poll every open window for the one exposing the sidebar,
 * guarding a navigating view's destroyed execution context with try/catch.
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
 * The first open window whose url includes `urlSubstring`. The settings view
 * (`?view=settings`, as in settings.spec.ts) and the command-bar overlay
 * (`?view=command-bar`, as in page-search.spec.ts) each load the renderer in their
 * own WebContentsView, which surfaces as its own Playwright Page; the sidebar
 * carries no `?view=` param, so either substring identifies its surface uniquely.
 */
async function viewWindow(app: ElectronApplication, urlSubstring: string): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(urlSubstring)) {
          return await followAppearance(w);
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution
        // context; skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`No window whose url includes "${urlSubstring}" was found within 20s`);
}

/**
 * Launch the packaged Electron build against a temp userData dir: empty
 * ELECTRON_RENDERER_URL (production loadFile path), ZEO_E2E=1 (headless test
 * mode), and --no-sandbox gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs as
 * root). Mirrors zoom.spec.ts's launch.
 */
async function launch(userDataDir: string): Promise<{ app: ElectronApplication; sidebar: Page }> {
  // Each launch starts at the system appearance with no tracked surfaces.
  surfaces.clear();
  emulatedScheme = null;
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
  return { app, sidebar: await followAppearance(sidebar) };
}

/**
 * `nativeTheme.themeSource` does not reliably reach the renderers'
 * `prefers-color-scheme` on headless CI: on Linux (xvfb) and on the GitHub
 * macOS runner alike, Electron updates `nativeTheme.shouldUseDarkColors` but
 * the renderers' media query never flips. So the same scheme is also emulated
 * on every page under test, on every platform. That exercises what zeo owns: a
 * `prefers-color-scheme` change re-coloring an open surface without a reload.
 * It cannot show that a surface created while the OS appearance is dark starts
 * in it.
 */
let emulatedScheme: "light" | "dark" | null = null;
const surfaces = new Set<Page>();

async function followAppearance(page: Page): Promise<Page> {
  surfaces.add(page);
  await page.emulateMedia({ colorScheme: emulatedScheme });
  return page;
}

/**
 * Force the process-wide appearance through Electron's `nativeTheme`, and
 * emulate the same scheme on every tracked surface, since the former does not
 * reliably reach the renderers.
 */
async function setThemeSource(
  app: ElectronApplication,
  source: "light" | "dark" | "system",
): Promise<void> {
  emulatedScheme = source === "system" ? null : source;
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, source);
  for (const page of surfaces) {
    if (!page.isClosed()) await page.emulateMedia({ colorScheme: emulatedScheme });
  }
}

/**
 * The appearance-bearing slice of a renderer's root: what `matchMedia` reports,
 * the `data-appearance` stamp, and two computed semantic tokens.
 */
interface RootTheme {
  mediaDark: boolean;
  dataAppearance: string | undefined;
  inkPrimary: string;
  surfaceWindow: string;
}

/** Read {@link RootTheme} off `page`'s document element. */
function readRootTheme(page: Page): Promise<RootTheme> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      mediaDark: matchMedia("(prefers-color-scheme: dark)").matches,
      dataAppearance: root.dataset.appearance,
      inkPrimary: style.getPropertyValue("--ink-primary").trim(),
      surfaceWindow: style.getPropertyValue("--surface-window").trim(),
    };
  });
}

/** The {@link RootTheme} a renderer must show under `appearance`. */
function expectedRootTheme(appearance: Appearance): RootTheme {
  const tokens = themeTokens(null, appearance);
  return {
    mediaDark: appearance === "dark",
    dataAppearance: appearance,
    inkPrimary: tokens["--ink-primary"],
    surfaceWindow: tokens["--surface-window"],
  };
}

/**
 * Poll `page`'s root until it renders `appearance`. An appearance switch reaches
 * the renderer through the `matchMedia` change event and a layout effect, so the
 * computed style lands a tick or more after `themeSource` is set.
 */
async function expectAppearance(
  page: Page,
  surface: string,
  appearance: Appearance,
): Promise<void> {
  await expect
    .poll(() => readRootTheme(page), {
      timeout: APPEARANCE_POLL_TIMEOUT_MS,
      message: `expected the ${surface} to render the ${appearance} tokens`,
    })
    .toEqual(expectedRootTheme(appearance));
}

/** Run command `id` over the sidebar bridge (e.g. `settings.open`). */
function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd as Parameters<ZeoBridge["commands"]["run"]>[0]);
  }, id);
}

/** Whether the settings view is open, read off `tabs.list()`'s `settingsOpen`. */
function settingsOpen(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const state = await zeo.tabs.list();
    return state.settingsOpen === true;
  });
}

/** Whether the command bar is open, read off `commandBar.state()`. */
function commandBarOpen(sidebar: Page): Promise<boolean> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.commandBar.state()).open;
  });
}

/** Open the command bar in navigate mode over the sidebar bridge. */
function openCommandBar(sidebar: Page): Promise<void> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.open("navigate");
  });
}

// One launch covers every surface: cold Electron starts are expensive under
// xvfb/docker. `themeSource` is process-wide state inside the launched app, so it
// is reset to "system" in `finally` before the app closes and never leaks.
test.describe("PRD 10.1 theme tokens (offline)", () => {
  test("every surface renders themeTokens(null, appearance) and re-colors on an appearance switch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      // --- The sidebar matches the tokens for whatever appearance the page
      // itself reports (the system default, untouched). ---
      const initialDark = await sidebar.evaluate(
        () => matchMedia("(prefers-color-scheme: dark)").matches,
      );
      await expectAppearance(sidebar, "sidebar", initialDark ? "dark" : "light");

      // --- Forcing dark, then light, re-colors the open sidebar without a
      // reload. The two token sets differ, so neither poll can pass vacuously. ---
      expect(themeTokens(null, "dark")["--ink-primary"]).not.toBe(
        themeTokens(null, "light")["--ink-primary"],
      );
      await setThemeSource(app, "dark");
      await expectAppearance(sidebar, "sidebar", "dark");
      await setThemeSource(app, "light");
      await expectAppearance(sidebar, "sidebar", "light");

      // --- Settings view: open it through the bridge while light, then switch
      // to dark with it open. ---
      await runCommand(sidebar, "settings.open");
      await expect
        .poll(() => settingsOpen(sidebar), {
          message: "expected settingsOpen === true after settings.open",
        })
        .toBe(true);
      const settings = await viewWindow(app, "view=settings");
      await expect(settings.getByTestId("settings")).toHaveCount(1);
      await expectAppearance(settings, "settings view", "light");
      await setThemeSource(app, "dark");
      await expectAppearance(settings, "settings view", "dark");
      await expectAppearance(sidebar, "sidebar", "dark");

      // --- Command-bar overlay: open it while dark, then switch to light with
      // it open. Located by url, as page-search.spec.ts does. ---
      await openCommandBar(sidebar);
      await expect
        .poll(() => commandBarOpen(sidebar), {
          message: "expected the command bar to be open after commandBar.open",
        })
        .toBe(true);
      const overlay = await viewWindow(app, "view=command-bar");
      await expect(overlay.getByTestId("command-bar")).toHaveCount(1);
      await expectAppearance(overlay, "command-bar overlay", "dark");
      await setThemeSource(app, "light");
      await expectAppearance(overlay, "command-bar overlay", "light");
    } finally {
      await setThemeSource(app, "system").catch(() => undefined);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
