import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// PRD 10.2 — the geometry formulas main applies to every native view. The
// assertions compare the live bounds against these helpers (never a copied
// formula), so the spec follows @zeo/core if a constant moves.
import {
  CARD_INSET,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TRAFFIC_LIGHT_POSITION,
  WINDOW_ROW_HEIGHT,
  contentRect,
  settingsBounds,
  splitPaneBounds,
} from "@zeo/core";
import type { ChromeState, Rect, WindowLayout, ZeoApi } from "@zeo/core";
import { VIEW_POLL_TIMEOUT_MS, waitForViewUrl } from "./helpers/view";

// Absolute path to the built Electron main entry (see split.spec.ts).
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

type ZeoBridge = Pick<ZeoApi, "tabs" | "commands" | "chrome" | "splitView">;

/** The sidebar window: the one renderer exposing `data-testid="sidebar"`. */
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
        // A navigating tab view's context can be momentarily destroyed.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No renderer window exposing data-testid="sidebar" was found');
}

/** Launch against `dir`, a fresh temp userData dir, so every test starts at the default chrome. */
async function launch(dir: string): Promise<{ app: ElectronApplication; sidebar: Page }> {
  const app = await electron.launch({
    args: [
      mainPath,
      "--user-data-dir=" + dir,
      ...(process.env.ZEO_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", ZEO_E2E: "1" },
  });
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

function chromeState(sidebar: Page): Promise<ChromeState> {
  return sidebar.evaluate(() => (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.state());
}

function setSidebarWidth(sidebar: Page, px: number): Promise<void> {
  return sidebar.evaluate(
    (w) => (globalThis as unknown as { zeo: ZeoBridge }).zeo.chrome.setSidebarWidth(w),
    px,
  );
}

function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate(
    (cmd) =>
      (globalThis as unknown as { zeo: ZeoBridge }).zeo.commands.run(
        cmd as Parameters<ZeoBridge["commands"]["run"]>[0],
      ),
    id,
  );
}

function splitLayout(sidebar: Page): Promise<WindowLayout> {
  return sidebar.evaluate(() =>
    (globalThis as unknown as { zeo: ZeoBridge }).zeo.splitView.state(),
  );
}

/** The main window's content size, as main reads it for every bounds formula. */
function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0].getContentSize();
    return { width, height };
  });
}

/**
 * The native bounds of the window's child view whose URL contains `sub` (a tab
 * token, `view=divider`, `view=settings`), read in main the way app.spec.ts's
 * `overlayNativeBounds` does. `null` when no such child is attached.
 */
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

/** `globalThis.__zeoWindowButtonsVisible`, which main mirrors under ZEO_E2E=1. */
function windowButtonsVisible(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(() => (globalThis as Record<string, unknown>).__zeoWindowButtonsVisible);
}

/** Create a `data:` tab carrying `token`, make it active, and wait for its view. */
async function activeTokenTab(
  app: ElectronApplication,
  sidebar: Page,
  token: string,
): Promise<string> {
  const id = await sidebar.evaluate(async (tok) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const tab = await zeo.tabs.create("data:text/html," + tok);
    await zeo.tabs.activate(tab.id);
    return tab.id;
  }, token);
  await waitForViewUrl(app, token);
  return id;
}

/** The expected card rect for the live content size and chrome. */
async function expectedCard(app: ElectronApplication, sidebar: Page): Promise<Rect> {
  const { width, height } = await contentSize(app);
  return contentRect(width, height, await chromeState(sidebar));
}

/** Box of every `window-card` element, in document order. */
function cardBoxes(sidebar: Page): Promise<Rect[]> {
  return sidebar.getByTestId("window-card").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

const TOKEN = "ZEOCHROME_ACTIVE";

test.describe("PRD 10.2 frameless chrome", () => {
  let app: ElectronApplication;
  let sidebar: Page;
  // Unset until this test's launch succeeds, so a failed launch (the cold
  // "Electron failed to install" flake) does not add a teardown error.
  let launched = false;
  let dir: string | undefined;

  test.beforeEach(async () => {
    launched = false;
    dir = mkdtempSync(join(tmpdir(), "zeo-chrome-"));
    ({ app, sidebar } = await launch(dir));
    launched = true;
  });

  test.afterEach(async () => {
    if (launched) {
      await app.close();
    }
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("window row: drag region of the window-row height, no-drag buttons", async () => {
    const row = await sidebar.getByTestId("window-row").evaluate((el) => ({
      region: getComputedStyle(el).getPropertyValue("-webkit-app-region"),
      height: el.getBoundingClientRect().height,
    }));
    expect(row).toEqual({ region: "drag", height: WINDOW_ROW_HEIGHT });
    for (const id of ["sidebar-toggle", "nav-back", "nav-forward", "nav-reload"]) {
      await expect(sidebar.getByTestId(id)).toHaveCSS("-webkit-app-region", "no-drag");
    }
  });

  test("window row: traffic lights at TRAFFIC_LIGHT_POSITION (14, 16)", async () => {
    test.skip(
      process.platform !== "darwin",
      "getWindowButtonPosition is macOS-only (plan Decision 2: main calls the window-button APIs only on darwin)",
    );
    const pos = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getWindowButtonPosition(),
    );
    expect(pos).toEqual(TRAFFIC_LIGHT_POSITION);
  });

  test("geometry: the active view and the window card equal contentRect at several content sizes", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    // 640×400 is MIN_WINDOW_SIZE; the window minimum applies to the frame, so the
    // content size main measures is read back rather than assumed. Every
    // read-back is recorded so an OS clamp that collapses the cases is caught.
    const measured: string[] = [];
    for (const [w, h] of [
      [1280, 800],
      [900, 600],
      [640, 400],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
        },
        { w, h },
      );
      await expect
        .poll(
          async () => {
            const bounds = await nativeBounds(app, TOKEN);
            const want = await expectedCard(app, sidebar);
            return JSON.stringify(bounds) === JSON.stringify(want) ? "ok" : { bounds, want };
          },
          { message: `view bounds at ${w}×${h}` },
        )
        .toBe("ok");
      const got = await contentSize(app);
      measured.push(`${w}×${h}->${got.width}×${got.height}`);
      // The renderer's viewport is the content area, so the card it draws uses
      // the same size main does.
      await expect
        .poll(
          async () => {
            const want = await expectedCard(app, sidebar);
            const cards = await cardBoxes(sidebar);
            return JSON.stringify(cards) === JSON.stringify([want]) ? "ok" : { cards, want };
          },
          { message: `window-card box at ${w}×${h}` },
        )
        .toBe("ok");
    }
    test.info().annotations.push({ type: "content-sizes", description: measured.join(", ") });
    // Three requested sizes must have produced three distinct measured sizes;
    // otherwise the loop checked one geometry three times.
    const sizes = measured.map((m) => m.split("->")[1]);
    expect(new Set(sizes).size, `measured content sizes: ${measured.join(", ")}`).toBe(3);
  });

  test("width: setSidebarWidth moves the card and resizes the sidebar, clamped to 200–360", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    const { width: W, height: H } = await contentSize(app);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);

    await setSidebarWidth(sidebar, 300);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(300);
    await expect
      .poll(() => nativeBounds(app, TOKEN))
      .toEqual({ x: 300, y: CARD_INSET, width: W - 300 - CARD_INSET, height: H - 2 * CARD_INSET });
    await expect
      .poll(async () => (await sidebar.getByTestId("sidebar").boundingBox())?.width)
      .toBe(300);

    await setSidebarWidth(sidebar, 1000);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(SIDEBAR_MAX_WIDTH);

    await setSidebarWidth(sidebar, 50);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(SIDEBAR_MIN_WIDTH);
    await expect
      .poll(async () => (await sidebar.getByTestId("sidebar").boundingBox())?.width)
      .toBe(SIDEBAR_MIN_WIDTH);
  });

  test("width: dragging the resize handle +40 px from 240 ends at 280", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(240);
    const handle = sidebar.getByTestId("sidebar-resize-handle");
    await expect(handle).toHaveAttribute("role", "separator");
    await expect(handle).toHaveAttribute("aria-valuenow", "240");
    const box = await handle.boundingBox();
    if (box === null) {
      throw new Error("resize handle has no box");
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await sidebar.mouse.move(x, y);
    await sidebar.mouse.down();
    await sidebar.mouse.move(x + 40, y, { steps: 8 });
    await sidebar.mouse.up();
    await expect.poll(async () => (await chromeState(sidebar)).sidebarWidth).toBe(280);
    await expect(handle).toHaveAttribute("aria-valuenow", "280");
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(280);
  });

  test("width: the resize handle is hit-testable across the sticky pinned section", async () => {
    // Pin a tab so the sticky pinned section exists, then hit-test the handle's
    // strip at the vertical middle of the pinned band.
    const id = await activeTokenTab(app, sidebar, TOKEN);
    await sidebar.evaluate(
      (tabId) => (globalThis as unknown as { zeo: ZeoBridge }).zeo.tabs.pin(tabId),
      id,
    );
    const pinned = sidebar.getByTestId("pinned-section");
    await expect(pinned).toBeVisible();
    const band = await pinned.boundingBox();
    if (band === null) {
      throw new Error("pinned section has no box");
    }
    const { sidebarWidth } = await chromeState(sidebar);
    const hit = await sidebar.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("data-testid") ?? null,
      { x: sidebarWidth - 3, y: band.y + band.height / 2 },
    );
    expect(hit).toBe("sidebar-resize-handle");
  });

  test("toggle: view.toggleSidebar collapses to an 8 px inset and hides the window buttons, and back", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    const { width: W, height: H } = await contentSize(app);
    expect(await windowButtonsVisible(app)).toBe(true);

    await runCommand(sidebar, "view.toggleSidebar");
    expect(await chromeState(sidebar)).toEqual({
      sidebarWidth: 240,
      sidebarCollapsed: true,
      sidebarRevealed: false,
    });
    await expect
      .poll(() => nativeBounds(app, TOKEN))
      .toEqual({ x: 8, y: 8, width: W - 16, height: H - 16 });
    expect(await windowButtonsVisible(app)).toBe(false);
    await expect(sidebar.getByTestId("sidebar")).toHaveClass(/sidebar--hidden/);

    await runCommand(sidebar, "view.toggleSidebar");
    expect(await chromeState(sidebar)).toEqual({
      sidebarWidth: 240,
      sidebarCollapsed: false,
      sidebarRevealed: false,
    });
    await expect
      .poll(() => nativeBounds(app, TOKEN))
      .toEqual({ x: 240, y: 8, width: W - 248, height: H - 16 });
    expect(await windowButtonsVisible(app)).toBe(true);
    await expect(sidebar.getByTestId("sidebar")).not.toHaveClass(/sidebar--hidden/);
  });

  test("toggle: the sidebar-toggle button runs view.toggleSidebar", async () => {
    await sidebar.getByTestId("sidebar-toggle").click();
    await expect.poll(async () => (await chromeState(sidebar)).sidebarCollapsed).toBe(true);
  });

  test("toggle: the View menu has Toggle Sidebar bound to CmdOrCtrl+S", async () => {
    const item = await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((i) => i.label === "View");
      const found = view?.submenu?.items.find((i) => i.label === "Toggle Sidebar");
      return found === undefined ? null : { accelerator: found.accelerator ?? null };
    });
    expect(item).toEqual({ accelerator: "CmdOrCtrl+S" });
  });

  test("reveal: the left edge reveals a collapsed sidebar and pushes the card; leaving hides it after the delay", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    await runCommand(sidebar, "view.toggleSidebar");
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(CARD_INSET);

    await sidebar.mouse.move(2, 300);
    await expect.poll(async () => (await chromeState(sidebar)).sidebarRevealed).toBe(true);
    const { sidebarWidth } = await chromeState(sidebar);
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(sidebarWidth);
    expect(await windowButtonsVisible(app)).toBe(true);
    await expect(sidebar.getByTestId("sidebar")).not.toHaveClass(/sidebar--hidden/);

    await sidebar.evaluate(() => {
      document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
    });
    // The hide waits SIDEBAR_HIDE_DELAY_MS (400 ms): an immediate read is still revealed.
    expect((await chromeState(sidebar)).sidebarRevealed).toBe(true);
    await expect
      .poll(async () => (await chromeState(sidebar)).sidebarRevealed, { timeout: 2_000 })
      .toBe(false);
    await expect
      .poll(async () => (await nativeBounds(app, TOKEN))?.x, { timeout: 2_000 })
      .toBe(CARD_INSET);
    expect(await windowButtonsVisible(app)).toBe(false);
    await expect(sidebar.getByTestId("sidebar")).toHaveClass(/sidebar--hidden/);
  });

  test("reveal: a width change during the hide delay still hides the sidebar", async () => {
    // Covers the useSidebarReveal hook's wiring: the broadcast that a width change
    // triggers mid-delay must neither drop nor restart the pending hide.
    await activeTokenTab(app, sidebar, TOKEN);
    await runCommand(sidebar, "view.toggleSidebar");
    await sidebar.mouse.move(2, 300);
    await expect.poll(async () => (await chromeState(sidebar)).sidebarRevealed).toBe(true);

    await sidebar.evaluate(() => {
      document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
    });
    await setSidebarWidth(sidebar, 300);
    const mid = await chromeState(sidebar);
    expect(mid).toEqual({ sidebarWidth: 300, sidebarCollapsed: true, sidebarRevealed: true });
    await expect
      .poll(async () => (await chromeState(sidebar)).sidebarRevealed, { timeout: 2_000 })
      .toBe(false);
    await expect
      .poll(async () => (await nativeBounds(app, TOKEN))?.x, { timeout: 2_000 })
      .toBe(CARD_INSET);
    expect((await chromeState(sidebar)).sidebarWidth).toBe(300);
  });

  test("reveal: the window losing focus hides a revealed sidebar at once", async () => {
    await activeTokenTab(app, sidebar, TOKEN);
    await runCommand(sidebar, "view.toggleSidebar");
    await sidebar.mouse.move(2, 300);
    await expect.poll(async () => (await chromeState(sidebar)).sidebarRevealed).toBe(true);
    // Emits the window's own `blur` event: an OS focus change is not reliably
    // delivered under xvfb (no window manager), and this is the handler under test.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit("blur");
    });
    expect((await chromeState(sidebar)).sidebarRevealed).toBe(false);
    await expect.poll(async () => (await nativeBounds(app, TOKEN))?.x).toBe(CARD_INSET);
  });

  test("split: the panes and divider equal splitPaneBounds and two window cards are drawn", async () => {
    const left = "ZEOCHROME_LEFT";
    const right = "ZEOCHROME_RIGHT";
    await activeTokenTab(app, sidebar, right);
    await activeTokenTab(app, sidebar, left);
    await runCommand(sidebar, "view.split");
    const layout = await splitLayout(sidebar);
    if (layout.mode !== "split") {
      throw new Error(`expected a split layout, got ${layout.mode}`);
    }
    await waitForViewUrl(app, "view=divider");
    const { width: W, height: H } = await contentSize(app);
    const want = splitPaneBounds(W, H, await chromeState(sidebar), layout.ratio);
    // The divider is exactly the 8 px gap between the panes.
    expect(want.divider.width).toBe(8);

    // Which token is on which side is the split rule's business (split.spec);
    // here each pane's view is matched to the side the layout reports for it.
    const tabs = await sidebar.evaluate(() =>
      (globalThis as unknown as { zeo: ZeoBridge }).zeo.tabs.list(),
    );
    const urlOf = (id: string): string => tabs.tabs.find((t) => t.id === id)?.url ?? "";
    const leftToken = urlOf(layout.left).includes(left) ? left : right;
    const rightToken = leftToken === left ? right : left;

    await expect.poll(() => nativeBounds(app, leftToken)).toEqual(want.left);
    await expect.poll(() => nativeBounds(app, rightToken)).toEqual(want.right);
    await expect.poll(() => nativeBounds(app, "view=divider")).toEqual(want.divider);

    await expect(sidebar.getByTestId("window-card")).toHaveCount(2);
    await expect(sidebar.locator('[data-testid="window-card"][data-pane="left"]')).toHaveCount(1);
    await expect(sidebar.locator('[data-testid="window-card"][data-pane="right"]')).toHaveCount(1);
    await expect.poll(() => cardBoxes(sidebar)).toEqual([want.left, want.right]);

    // A width change re-lays out the split (relayoutWindow's split branch).
    await setSidebarWidth(sidebar, 300);
    const wider = splitPaneBounds(W, H, await chromeState(sidebar), layout.ratio);
    expect(wider.left.x).toBe(300);
    await expect.poll(() => nativeBounds(app, leftToken)).toEqual(wider.left);
    await expect.poll(() => nativeBounds(app, rightToken)).toEqual(wider.right);
    await expect.poll(() => nativeBounds(app, "view=divider")).toEqual(wider.divider);
  });

  test("settings: the settings view covers the whole window, before and after a chrome change", async () => {
    await runCommand(sidebar, "settings.open");
    await waitForViewUrl(app, "view=settings");
    // PRD 10.6: the settings view is full-window (settingsBounds(W, H)); its
    // renderer paints the scrim and centers the sheet, so the chrome no longer
    // shapes the view.
    const settingsCoversWindow = async (): Promise<unknown> => {
      const [bounds, size] = await Promise.all([
        nativeBounds(app, "view=settings"),
        contentSize(app),
      ]);
      const want = settingsBounds(size.width, size.height);
      return JSON.stringify(bounds) === JSON.stringify(want) ? "ok" : { bounds, want };
    };
    await expect.poll(settingsCoversWindow).toBe("ok");
    const { width: W, height: H } = await contentSize(app);
    expect(await nativeBounds(app, "view=settings")).toEqual({ x: 0, y: 0, width: W, height: H });

    // A collapse re-runs relayoutWindow; the view stays full-window (x 0, not
    // the collapsed card's CARD_INSET).
    await runCommand(sidebar, "view.toggleSidebar");
    expect((await chromeState(sidebar)).sidebarCollapsed).toBe(true);
    await expect.poll(settingsCoversWindow).toBe("ok");
    expect(await nativeBounds(app, "view=settings")).toEqual({ x: 0, y: 0, width: W, height: H });
  });
});
