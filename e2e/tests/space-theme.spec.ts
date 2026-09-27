import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// PRD 10.3 — the e2e oracle for every expected color/token is the same pure
// @zeo/core function the renderer applies, never a copied table of values.
import { IPC, MIGRATION_HUE_ORDER, SCHEMA_VERSION, themeReport, themeTokens } from "@zeo/core";
import type { Appearance, Space, SpaceTheme, ZeoApi } from "@zeo/core";
import { waitForViewsIdle } from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Same layout as persistence.spec.ts / theme.spec.ts.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "spaces" | "commandBar" | "commands" | "chrome">;

/**
 * The renderer window that hosts the React sidebar. Copied from theme.spec.ts:
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
 * The first open window whose url includes `urlSubstring`, forced to `"light"`
 * (nativeTheme does not reach a renderer's `prefers-color-scheme` under xvfb or
 * on the macOS runner, so every measured surface is emulated directly — see
 * theme.spec.ts's `followAppearance`).
 */
async function viewWindow(app: ElectronApplication, urlSubstring: string): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(urlSubstring)) {
          await w.emulateMedia({ colorScheme: "light" });
          return w;
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
 * mode), and --no-sandbox gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs
 * as root). Forces light appearance on the sidebar immediately, both through
 * `nativeTheme.themeSource` (so the process-wide state matches) and
 * `emulateMedia` (what every assertion actually observes).
 */
async function launch(userDataDir: string): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
    args: [
      mainPath,
      "--user-data-dir=" + userDataDir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
  });
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "light";
  });
  const sidebar = await sidebarWindow(app);
  await sidebar.emulateMedia({ colorScheme: "light" });
  return { app, sidebar };
}

/** Resets `nativeTheme.themeSource` to "system" so it never leaks into another test. */
async function resetThemeSource(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "system";
    })
    .catch(() => undefined);
}

/**
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS so the debounced
 * save after the LAST mutation definitely lands on disk before the app closes.
 * Copied from persistence.spec.ts.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

/** Read the spaces-only snapshot over the sidebar bridge. */
function readSpaces(sidebar: Page): Promise<{ spaces: Space[]; activeSpaceId: string }> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.list();
  });
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

/** The live `--tint` custom property on `page`'s document root. */
function readTint(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--tint").trim(),
  );
}

/** The live `--accent` custom property on `page`'s document root. */
function readAccent(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
}

/**
 * Sends `{ action: "edit-theme", spaceId }` on `IPC.spaceMenuAction` straight
 * to the BrowserWindow whose URL carries no `view=` query — the sidebar's own
 * window, as `showSpaceContextMenu`/`space.editTheme` do in main. Mirrors what
 * a real native space-context-menu click or the `space.editTheme` command
 * ultimately does, without depending on a right-click or on `commands.run`
 * (used elsewhere to specifically test the direct-dispatch path).
 */
async function sendEditThemeAction(app: ElectronApplication, spaceId: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, data) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().includes("view="),
      );
      if (win === undefined) {
        throw new Error("no BrowserWindow without a view= query was found");
      }
      win.webContents.send(data.channel, { action: "edit-theme", spaceId: data.spaceId });
    },
    { channel: IPC.spaceMenuAction, spaceId },
  );
}

/** The `theme-picker` locator, or none when it isn't rendered. */
function picker(sidebar: Page) {
  return sidebar.getByTestId("theme-picker");
}

/** The current theme of space `id`, read off `spaces.list()`. */
async function themeOf(sidebar: Page, id: string): Promise<SpaceTheme | null> {
  const { spaces } = await readSpaces(sidebar);
  const space = spaces.find((s) => s.id === id);
  if (space === undefined) {
    throw new Error(`space ${id} not found`);
  }
  return space.theme;
}

/** `data-testid`/`data-hue` of the space-dot inside space `id`'s switcher row. */
function spaceDotHue(sidebar: Page, id: string): Promise<string | null> {
  return sidebar
    .locator(`[data-testid="space-item"][data-space-id="${id}"] [data-testid="space-dot"]`)
    .getAttribute("data-hue");
}

/** `document.activeElement`'s `data-testid`, or `null` for `<body>`/no attribute. */
function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
}

test.describe("PRD 10.3 space themes", () => {
  // --- New spaces take MIGRATION_HUE_ORDER hues by creation position. ---------
  test("new spaces get MIGRATION_HUE_ORDER hues, mirrored by the switcher's space-dot", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-new-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      expect(before.spaces).toHaveLength(1);
      const personalId = before.spaces[0]!.id;
      expect(before.spaces[0]!.theme).toEqual({ stops: ["iris"], intensity: 1 });
      expect(await spaceDotHue(sidebar, personalId)).toBe("iris");

      const a = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("A");
      });
      const b = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("B");
      });

      expect(a.theme).toEqual({ stops: [MIGRATION_HUE_ORDER[1]], intensity: 1 });
      expect(b.theme).toEqual({ stops: [MIGRATION_HUE_ORDER[2]], intensity: 1 });
      expect(MIGRATION_HUE_ORDER[1]).toBe("rose");
      expect(MIGRATION_HUE_ORDER[2]).toBe("teal");

      expect(await spaceDotHue(sidebar, a.id)).toBe("rose");
      expect(await spaceDotHue(sidebar, b.id)).toBe("teal");
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Bridge: setTheme validates, clamps, and rejects without side effects. --
  test("spaces.setTheme validates through normalizeTheme and leaves the list unchanged on rejection", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-bridge-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const { spaces } = await readSpaces(sidebar);
      const id = spaces[0]!.id;

      await sidebar.evaluate(
        async (data) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.spaces.setTheme(data.id, data.theme);
        },
        { id, theme: { stops: ["coral", "sky"], intensity: 0.6 } as SpaceTheme },
      );
      expect(await themeOf(sidebar, id)).toEqual({ stops: ["coral", "sky"], intensity: 0.6 });

      // Intensity 1.5 clamps to 1.
      await sidebar.evaluate(
        async (data) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.spaces.setTheme(data.id, data.theme);
        },
        { id, theme: { stops: ["coral", "sky"], intensity: 1.5 } as SpaceTheme },
      );
      expect(await themeOf(sidebar, id)).toEqual({ stops: ["coral", "sky"], intensity: 1 });

      const beforeReject = await readSpaces(sidebar);

      // An unknown hue rejects and changes nothing.
      const unknownHueRejected = await sidebar.evaluate(
        async (data) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          try {
            // @ts-expect-error deliberately invalid at the type level too
            await zeo.spaces.setTheme(data.id, { stops: ["mauve"], intensity: 1 });
            return false;
          } catch {
            return true;
          }
        },
        { id },
      );
      expect(unknownHueRejected).toBe(true);
      expect(await readSpaces(sidebar)).toEqual(beforeReject);

      // An unknown space id rejects and changes nothing.
      const unknownIdRejected = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.spaces.setTheme("not-a-real-space-id", { stops: ["teal"], intensity: 1 });
          return false;
        } catch {
          return true;
        }
      });
      expect(unknownIdRejected).toBe(true);
      expect(await readSpaces(sidebar)).toEqual(beforeReject);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Tokens follow the active space on every surface. ------------------------
  test("sidebar, settings and overlay tokens follow the active space's theme", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-tokens-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const personalId = before.activeSpaceId;
      const personalTheme = before.spaces.find((s) => s.id === personalId)!.theme;

      await expect
        .poll(() => readTint(sidebar))
        .toBe(themeTokens(personalTheme, "light")["--tint"]);

      const b = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("B");
      });
      expect(b.theme).not.toEqual(personalTheme);

      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.activate(id);
      }, b.id);

      const personalTint = themeTokens(personalTheme, "light")["--tint"];
      const bTint = themeTokens(b.theme, "light")["--tint"];
      expect(bTint).not.toBe(personalTint);
      await expect.poll(() => readTint(sidebar)).toBe(bTint);

      // Settings view, opened while B is active.
      await runCommand(sidebar, "settings.open");
      await expect.poll(() => settingsOpen(sidebar)).toBe(true);
      const settings = await viewWindow(app, "view=settings");
      await expect(settings.getByTestId("settings")).toHaveCount(1);
      const bAccent = themeTokens(b.theme, "light")["--accent"];
      await expect.poll(() => readAccent(settings)).toBe(bAccent);

      // Command-bar overlay, opened while B is still active.
      await waitForViewsIdle(app);
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("commands");
      });
      await expect.poll(() => commandBarOpen(sidebar)).toBe(true);
      const overlay = await viewWindow(app, "view=command-bar");
      await expect(overlay.getByTestId("command-bar")).toHaveCount(1);
      await expect.poll(() => readAccent(overlay)).toBe(bAccent);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Relaunch: themes round-trip through the debounced save. ----------------
  test("a gradient and a null theme both survive relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-relaunch-"));

    const first = await launch(userDataDir);
    let personalId: string;
    let bId: string;
    const gradient: SpaceTheme = { stops: ["amber", "sky"], intensity: 0.4 };
    try {
      const before = await readSpaces(first.sidebar);
      personalId = before.activeSpaceId;
      const b = await first.sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("B");
      });
      bId = b.id;

      await first.sidebar.evaluate(
        async (data) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.spaces.setTheme(data.id, data.theme);
        },
        { id: personalId, theme: gradient },
      );
      await first.sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.setTheme(id, null);
      }, bId);

      expect(await themeOf(first.sidebar, personalId)).toEqual(gradient);
      expect(await themeOf(first.sidebar, bId)).toBeNull();

      await waitForDebouncedSave();
    } finally {
      await resetThemeSource(first.app);
      await first.app.close();
    }

    const second = await launch(userDataDir);
    try {
      expect(await themeOf(second.sidebar, personalId)).toEqual(gradient);
      expect(await themeOf(second.sidebar, bId)).toBeNull();
    } finally {
      await resetThemeSource(second.app);
      await second.app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Migration: a pre-N database backfills hues by position. -----------------
  test("a v(N-1) database migrates existing spaces to MIGRATION_HUE_ORDER by position", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-migration-"));

    const first = await launch(userDataDir);
    try {
      // Personal + ten more = eleven spaces, created in order.
      for (let i = 0; i < 10; i += 1) {
        await first.sidebar.evaluate(async (n) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.spaces.create(`Space ${n}`);
        }, i);
      }
      expect((await readSpaces(first.sidebar)).spaces).toHaveLength(11);
      await waitForDebouncedSave();
    } finally {
      await resetThemeSource(first.app);
      await first.app.close();
    }

    // Downgrade the on-disk database to schema N-1: drop the theme column and
    // roll back the recorded schemaVersion, exactly as PRD 10.3 §9 describes.
    const dbPath = join(userDataDir, "zeo.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("ALTER TABLE spaces DROP COLUMN theme;");
      db.prepare("UPDATE meta SET schemaVersion = ? WHERE id = 0;").run(SCHEMA_VERSION - 1);
    } finally {
      db.close();
    }

    const second = await launch(userDataDir);
    try {
      const { spaces } = await readSpaces(second.sidebar);
      expect(spaces).toHaveLength(11);
      spaces.forEach((space, index) => {
        expect(space.theme).toEqual({
          stops: [MIGRATION_HUE_ORDER[index % 10]],
          intensity: 1,
        });
      });
    } finally {
      await resetThemeSource(second.app);
      await second.app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- The picker: geometry, interactions, contrast readout, Escape, command. --
  test("the theme picker edits the live theme and reports contrast that matches themeReport", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-picker-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const spaceId = before.activeSpaceId;
      const chrome = await sidebar.evaluate(() =>
        (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.state(),
      );

      await sendEditThemeAction(app, spaceId);
      await expect(picker(sidebar)).toBeVisible();
      await expect(picker(sidebar)).toHaveAttribute("data-space-id", spaceId);

      const box = await picker(sidebar).boundingBox();
      if (box === null) {
        throw new Error("theme picker has no bounding box");
      }
      expect(Math.abs(box.x - 8)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - (chrome.sidebarWidth - 16))).toBeLessThanOrEqual(1);
      expect(box.x + box.width).toBeLessThan(chrome.sidebarWidth);

      // Teal swatch -> ["teal"].
      await sidebar
        .locator('[data-testid="theme-swatch"][data-hue="teal"]')
        .click();
      await expect.poll(() => themeOf(sidebar, spaceId)).toEqual({
        stops: ["teal"],
        intensity: 1,
      });

      // Gradient, then amber on the (now selected) second stop -> ["teal", "amber"].
      await sidebar.getByTestId("theme-kind-gradient").click();
      await sidebar
        .locator('[data-testid="theme-swatch"][data-hue="amber"]')
        .click();
      await expect.poll(() => themeOf(sidebar, spaceId)).toEqual({
        stops: ["teal", "amber"],
        intensity: 1,
      });

      // Color 1, then rose -> ["rose", "amber"].
      await sidebar.locator('[data-testid="theme-stop"][data-stop-index="0"]').click();
      await sidebar
        .locator('[data-testid="theme-swatch"][data-hue="rose"]')
        .click();
      await expect.poll(() => themeOf(sidebar, spaceId)).toEqual({
        stops: ["rose", "amber"],
        intensity: 1,
      });

      // Intensity 50%.
      await sidebar.getByTestId("theme-intensity").fill("50");
      await expect.poll(() => themeOf(sidebar, spaceId)).toEqual({
        stops: ["rose", "amber"],
        intensity: 0.5,
      });
      await expect(sidebar.getByTestId("theme-intensity-value")).toHaveText("50%");

      // Each contrast chip's data-ink-contrast matches themeReport exactly.
      const draft = await themeOf(sidebar, spaceId);
      const chips = sidebar.getByTestId("theme-contrast");
      await expect(chips).toHaveCount(2);
      for (const appearance of ["light", "dark"] as Appearance[]) {
        const chip = sidebar.locator(
          `[data-testid="theme-contrast"][data-appearance="${appearance}"]`,
        );
        const expected = themeReport(draft, appearance).inkContrast.toFixed(2);
        await expect(chip).toHaveAttribute("data-ink-contrast", expected);
      }

      // Escape removes the picker and focuses the space's own space-item. Sent
      // to the intensity slider (still focused from the `fill` above, and a
      // descendant of the dialog, so its keydown bubbles to the picker's own
      // Escape handler) rather than the dialog `<div>` itself, which carries no
      // `tabindex` and so cannot actually take focus via `.press`'s implicit
      // `.focus()`.
      await sidebar.getByTestId("theme-intensity").press("Escape");
      await expect(picker(sidebar)).toHaveCount(0);
      await expect
        .poll(() => activeTestId(sidebar))
        .toBe("space-item");
      const focusedId = await sidebar.evaluate(
        () => document.activeElement?.getAttribute("data-space-id") ?? null,
      );
      expect(focusedId).toBe(spaceId);

      // commands.run("space.editTheme") opens the picker for the active space.
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commands.run("space.editTheme");
      });
      await expect(picker(sidebar)).toBeVisible();
      await expect(picker(sidebar)).toHaveAttribute("data-space-id", spaceId);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- The command-bar UI path opens a focused picker. -------------------------
  // openSpaceThemeEditor (apps/desktop/src/main/theme-editor.ts) closes the bar
  // before focusing the sidebar, so acceptCommandBar's own close cannot move
  // focus to a page view afterwards. Under xvfb the page view never takes focus
  // even without that ordering, so the ordering itself is guarded by
  // theme-editor.test.ts; this test covers the end-to-end path.
  test("running Edit Space Theme through the command bar keeps the picker open and focused", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-cmdbar-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const spaceId = before.activeSpaceId;

      // A loaded page view so closeCommandBar() has something to focus.
      const tab = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.tabs.create("data:text/html,cmdbar-probe");
      });
      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.activate(id);
      }, tab.id);
      await waitForViewsIdle(app);

      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("commands");
        await zeo.commandBar.setQuery("edit space theme");
      });
      await expect
        .poll(async () =>
          sidebar.evaluate(async () => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            const st = await zeo.commandBar.state();
            return st.suggestions.some((s) => s.kind === "command" && s.id === "space.editTheme");
          }),
        )
        .toBe(true);
      const idx = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const st = await zeo.commandBar.state();
        return st.suggestions.findIndex((s) => s.kind === "command" && s.id === "space.editTheme");
      });
      await sidebar.evaluate(async (i) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.accept(i);
      }, idx);

      // The bar closed, the picker opened for the active space, and — the
      // regression this guards — focus stayed inside it rather than being
      // stolen back to the just-focused page view.
      await expect.poll(() => commandBarOpen(sidebar)).toBe(false);
      await expect(picker(sidebar)).toBeVisible();
      await expect(picker(sidebar)).toHaveAttribute("data-space-id", spaceId);
      const active = await activeTestId(sidebar);
      expect(active).not.toBeNull();
      const insidePicker = await sidebar.evaluate(() => {
        const root = document.querySelector('[data-testid="theme-picker"]');
        const el = document.activeElement;
        return root !== null && el instanceof Node && root.contains(el);
      });
      expect(insidePicker).toBe(true);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Removing the edited space while its picker has focus restores focus. ---
  test("deleting the edited (non-active) space closes its picker and restores focus to the remaining space's item", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-removed-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const personalId = before.activeSpaceId;
      const b = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("B");
      });

      // Open B's picker directly (mirrors a native space-context-menu click),
      // without activating B — the picker can edit a non-active space's theme.
      await sendEditThemeAction(app, b.id);
      await expect(picker(sidebar)).toBeVisible();
      await expect(picker(sidebar)).toHaveAttribute("data-space-id", b.id);
      await expect.poll(async () =>
        sidebar.evaluate(() => {
          const root = document.querySelector('[data-testid="theme-picker"]');
          const el = document.activeElement;
          return root !== null && el instanceof Node && root.contains(el);
        }),
      ).toBe(true);

      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.delete(id);
      }, b.id);

      await expect(picker(sidebar)).toHaveCount(0);
      await expect.poll(() => activeTestId(sidebar)).toBe("space-item");
      const focusedId = await sidebar.evaluate(
        () => document.activeElement?.getAttribute("data-space-id") ?? null,
      );
      expect(focusedId).toBe(personalId);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Activating a different space while the picker has focus restores focus. -
  test("activating a different space closes the edited space's picker and restores focus to the edited space's item", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-active-change-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const personalId = before.activeSpaceId;
      const c = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.create("C");
      });

      // Open the still-active Personal space's own picker.
      await sendEditThemeAction(app, personalId);
      await expect(picker(sidebar)).toBeVisible();
      await expect(picker(sidebar)).toHaveAttribute("data-space-id", personalId);
      await expect.poll(async () =>
        sidebar.evaluate(() => {
          const root = document.querySelector('[data-testid="theme-picker"]');
          const el = document.activeElement;
          return root !== null && el instanceof Node && root.contains(el);
        }),
      ).toBe(true);

      await sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.activate(id);
      }, c.id);

      await expect(picker(sidebar)).toHaveCount(0);
      await expect.poll(() => activeTestId(sidebar)).toBe("space-item");
      const focusedId = await sidebar.evaluate(
        () => document.activeElement?.getAttribute("data-space-id") ?? null,
      );
      // restoreFocusFromThemePicker prefers the EDITED space's own item over
      // the newly-active one.
      expect(focusedId).toBe(personalId);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // --- Sidebar collapse while the picker has focus must close it cleanly. -----
  // NOTE: unlike the active-space-change and edited-space-removal paths, each
  // covered by its own test directly above ("activating a different space
  // closes the edited space's picker..." and "deleting the edited (non-active)
  // space closes its picker...") and both restoring focus to a space-item, a
  // FULL collapse (`sidebarCollapsed && !sidebarRevealed`, exactly what `view.toggleSidebar`
  // produces here) sets `visibility: hidden` on the whole `<aside data-testid=
  // "sidebar">` (`.sidebar--hidden`, styles/sidebar.css) in the SAME commit
  // that unmounts the picker. A hidden element (and everything inside it,
  // including its space-items) cannot take focus per the HTML focusability
  // rules, so `restoreFocusFromThemePicker`'s `item?.focus()` is a verified
  // no-op here — confirmed by running this scenario and polling for it, which
  // never succeeds. Focus falling back to `<body>` in this one case is the
  // unavoidable, correct outcome of the sidebar itself going invisible, not a
  // regression the App.tsx fix could (or should) prevent; what IS asserted is
  // that the close is clean (no error, no stale/dangling focus reference) and
  // that un-collapsing leaves the app in a normal, focusable state again.
  test("collapsing the sidebar while the picker has focus closes it without error", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-theme-collapse-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await readSpaces(sidebar);
      const spaceId = before.activeSpaceId;

      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commands.run("space.editTheme");
      });
      await expect(picker(sidebar)).toBeVisible();
      const insidePickerBefore = await sidebar.evaluate(() => {
        const root = document.querySelector('[data-testid="theme-picker"]');
        const el = document.activeElement;
        return root !== null && el instanceof Node && root.contains(el);
      });
      expect(insidePickerBefore).toBe(true);

      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commands.run("view.toggleSidebar");
      });

      // The picker is gone and the collapse itself did not throw or hang.
      await expect(picker(sidebar)).toHaveCount(0);
      expect(await sidebar.evaluate(() => (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.state()))
        .toMatchObject({ sidebarCollapsed: true, sidebarRevealed: false });

      // Restore the sidebar; it becomes focusable again and a space-item can
      // still be reached and take focus normally (nothing left broken).
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commands.run("view.toggleSidebar");
      });
      await sidebar
        .locator(`[data-testid="space-item"][data-space-id="${spaceId}"]`)
        .focus();
      await expect.poll(() => activeTestId(sidebar)).toBe("space-item");
      const focusedId = await sidebar.evaluate(
        () => document.activeElement?.getAttribute("data-space-id") ?? null,
      );
      expect(focusedId).toBe(spaceId);
    } finally {
      await resetThemeSource(app);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
