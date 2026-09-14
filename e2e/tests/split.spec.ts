import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors persistence.spec.ts: e2e/tests ->
// repo root is two levels up, then into the desktop app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e does not depend on @zeo/core, so (as in the sibling specs) we redeclare only
// the slice these split-view tests touch. These stay structurally compatible with
// @zeo/core's ZeoApi / Tab / WindowLayout / CommandBarState; only the fields we
// assert on are load-bearing.
interface BridgeTab {
  id: string;
  url: string;
  title: string;
  pinned: boolean;
}
interface BridgeState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  archived: BridgeTab[];
}
/** Which of the two split panes: the `"left"` one or the `"right"` one. */
type PaneSide = "left" | "right";
/** The active space's window layout, mirroring @zeo/core's `WindowLayout`. */
type BridgeLayout =
  | { mode: "single" }
  | { mode: "split"; left: string; right: string; ratio: number; focused: PaneSide };
/** The geometry the divider view reads back, mirroring @zeo/core's `DividerGeometry`. */
interface DividerGeometryShape {
  ratio: number;
  dividableWidth: number;
}
// One command-bar suggestion row, structurally the @zeo/core `Suggestion` union
// (redeclared import-free like the rest of this file). Split-mode rows are
// `kind: "tab"` and carry the open tab's `tabId`; only `kind`/`tabId` are
// load-bearing here.
interface BridgeSuggestion {
  kind: string;
  tabId?: string;
  id?: string;
  title?: string;
}
interface CommandBarStateShape {
  open: boolean;
  mode: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    close(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
  commandBar: {
    accept(index?: number, revision?: number): Promise<void>;
    state(): Promise<CommandBarStateShape>;
  };
  // The PRD 7.1 split-view bridge slice. `focusPane` is typed with a `string`
  // param (wider than @zeo/core's `PaneSide`) so the invalid-payload test can pass
  // a value that is not "left"/"right" without a cast; the runtime guard in main
  // rejects it with a TypeError.
  splitView: {
    split(): Promise<void>;
    splitWith(tabId: string): Promise<void>;
    unsplit(): Promise<void>;
    swap(): Promise<void>;
    focusPane(pane: string): Promise<void>;
    focusOther(): Promise<void>;
    setRatio(ratio: number): Promise<void>;
    dividerGeometry(): Promise<DividerGeometryShape>;
    state(): Promise<BridgeLayout>;
  };
}

/** The split branch of {@link BridgeLayout} (its `mode` narrowed to `"split"`). */
type BridgeSplit = Extract<BridgeLayout, { mode: "split" }>;

/**
 * Narrow a {@link BridgeLayout} to its split branch, throwing (with the actual
 * mode) when it is single — so a test that expected a split fails with a clear
 * message rather than a downstream `undefined` read.
 */
function asSplit(layout: BridgeLayout): BridgeSplit {
  if (layout.mode !== "split") {
    throw new Error(`expected a split layout, got "${layout.mode}"`);
  }
  return layout;
}

/**
 * Return the renderer window that hosts the React sidebar. Copied from
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
        // A tab's WebContentsView can surface as a window and, while it is
        // navigating, its execution context may be momentarily destroyed. Skip
        // any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/**
 * The overlay/pane {@link Page} whose url includes `urlSubstring`. Each auxiliary
 * surface (the command-bar overlay at `?view=command-bar`, the split divider at
 * `?view=divider`) and each tab renders in its own WebContentsView that surfaces
 * as its own Page; we identify it by a unique in-url probe. Mirrors the
 * `tabWindow`/`commandBarWindow` idiom in blocking.spec.ts / app.spec.ts: poll
 * every open window, guarding `url()` with try/catch since a navigating view's
 * context can be momentarily destroyed.
 */
async function windowByUrl(app: ElectronApplication, urlSubstring: string): Promise<Page> {
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

  throw new Error(`No window whose url includes "${urlSubstring}" was found within 20s`);
}

/**
 * Launch the packaged Electron build against a specific on-disk userData dir.
 * Electron honors `--user-data-dir`, so two launches pointed at the same dir share
 * the same `zeo.db` — the whole mechanism the persistence cases exercise. Copied
 * verbatim from persistence.spec.ts: empty ELECTRON_RENDERER_URL forces the
 * production loadFile path, ZEO_E2E=1 puts main in headless test mode, and
 * --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (set by the docker sidecar which
 * runs as root).
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
  const sidebar = await sidebarWindow(app);
  return { app, sidebar };
}

/**
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS so the debounced save
 * after the LAST mutation (including a divider-ratio drag, which persists on a
 * debounce) definitely lands on disk before we close launch #1. This waits on a
 * real debounce timer (not a race), so a fixed sleep is the correct instrument —
 * copied from persistence.spec.ts.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

/** Read the active space's window layout over the sidebar bridge. */
function splitState(sidebar: Page): Promise<BridgeLayout> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.splitView.state();
  });
}

/** Read the full tab snapshot over the sidebar bridge. */
function listTabs(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

/** Read the command-bar state over the sidebar bridge (a live invoke round trip). */
function commandBarState(sidebar: Page): Promise<CommandBarStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

/** Run command `id` over the sidebar bridge (e.g. `view.split`). */
function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd);
  }, id);
}

/** Enter a split of the active tab (left) with the chosen `tabId` (right). */
function splitWith(sidebar: Page, tabId: string): Promise<void> {
  return sidebar.evaluate((id) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.splitView.splitWith(id);
  }, tabId);
}

/**
 * Seed a deterministic set of tabs for the split cases. Each token becomes a
 * distinct `data:text/html,<token>` tab (no network, like persistence.spec.ts's
 * in-url probes; none a substring of another, so a `url().includes(token)` match
 * identifies exactly one pane view). The FIRST created tab is left active (the
 * intended left pane), and the fresh-launch seeded tab is closed so ONLY these
 * tokened tabs remain — making `split()` (left = active, right = most-recent
 * other) pick our two tabs, not the seeded one. Returns the new tab ids in token
 * order.
 */
function seedTabs(sidebar: Page, tokens: string[]): Promise<string[]> {
  return sidebar.evaluate(async (toks) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    const before = await zeo.tabs.list();
    const seeded = before.activeTabId;
    const ids: string[] = [];
    // Serialize per-tab navigations: await each create before the next.
    for (const t of toks) {
      const tab = await zeo.tabs.create("data:text/html," + t);
      ids.push(tab.id);
    }
    // Make the first created tab active (intended left pane).
    await zeo.tabs.activate(ids[0]);
    // Drop the seeded tab (never active now) so only the tokened tabs remain.
    if (seeded !== null && !ids.includes(seeded)) {
      await zeo.tabs.close(seeded);
    }
    return ids;
  }, tokens);
}

/**
 * Drag the split divider horizontally by `dx` CSS px (positive = rightward, which
 * raises the left-pane ratio) and return the resulting `splitView.state().ratio`.
 *
 * Mirrors app.spec.ts's `dragRowOnce` renderer-acknowledged drag: after moving to
 * the settle position we poll the renderer-set global (`__zeoDivider`, written by
 * Divider.tsx's pointermove handler) and retry the settle move until it reflects a
 * ratio that has moved in the drag direction — NEVER a bare stepped move followed
 * by a blind release. The whole gesture is retried (up to 5 times) so a transient
 * geometry-seed lag settles; a genuinely un-seeded divider (dividableWidth 0/NaN)
 * never acknowledges, so the drag throws — which is exactly the failure the
 * geometry-handshake case relies on.
 */
async function dragDivider(divider: Page, sidebar: Page, dx: number): Promise<number> {
  const before = asSplit(await splitState(sidebar)).ratio;
  const handle = divider.getByTestId("divider-handle");
  await handle.waitFor({ state: "visible" });
  const box = await handle.boundingBox();
  if (box === null) {
    throw new Error("divider handle had no bounding box");
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const dir = dx >= 0 ? 1 : -1;

  const seen = (): Promise<number | null> =>
    divider.evaluate(
      () => (globalThis as { __zeoDivider?: { ratio: number } }).__zeoDivider?.ratio ?? null,
    );

  for (let gesture = 0; gesture < 5; gesture += 1) {
    // Clear the ack so a stale value from a prior gesture can't read as fresh.
    await divider.evaluate(() => {
      delete (globalThis as { __zeoDivider?: unknown }).__zeoDivider;
    });
    await divider.mouse.move(startX, startY);
    await divider.mouse.down();
    // Nudge to begin the drag, then travel to the settle position.
    await divider.mouse.move(startX + dir * 4, startY, { steps: 3 });
    await divider.mouse.move(startX + dx, startY, { steps: 12 });

    let acknowledged = false;
    for (let attempt = 0; attempt < 20 && !acknowledged; attempt += 1) {
      await divider.mouse.move(startX + dx, startY);
      const ratio = await seen();
      acknowledged = ratio !== null && (dir > 0 ? ratio > before : ratio < before);
    }
    await divider.mouse.up();

    if (acknowledged) {
      // setRatio rides an async IPC; wait for main's layout ratio to reflect the
      // drag before reading it back.
      await expect
        .poll(async () => {
          const layout = await splitState(sidebar);
          return (
            layout.mode === "split" && (dir > 0 ? layout.ratio > before : layout.ratio < before)
          );
        })
        .toBe(true);
      return asSplit(await splitState(sidebar)).ratio;
    }
  }
  throw new Error(`divider drag was never acknowledged (start ratio ${before}, dx ${dx})`);
}

// Each test manages its OWN launch(es) against a per-test temp userData dir, so
// there is no shared beforeEach launch (mirroring persistence.spec.ts). Tab ids
// captured from launch #1 are reused as strings in launch #2 — they persist across
// the process boundary, which is the property the persistence cases test.
test.describe("PRD 7.1 split view", () => {
  // §9.1 — split via view.split (bridge and command), two side-by-side panes.
  test("view.split enters a split with two side-by-side panes and one focused pane", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const [left, right] = await seedTabs(sidebar, ["ZEOSPLIT_L", "ZEOSPLIT_R"]);

      // Split via the bridge.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.splitView.split();
      });

      const split = asSplit(await splitState(sidebar));
      expect(split.left).toBe(left);
      expect(split.right).toBe(right);

      // Both pane views are materialized side by side (found by their in-url probes).
      await windowByUrl(app, "ZEOSPLIT_L");
      await windowByUrl(app, "ZEOSPLIT_R");

      // The sidebar shows two paned rows and EXACTLY ONE focused pane.
      await expect(sidebar.getByTestId("tab-pane")).toHaveCount(2);
      await expect(sidebar.locator(".tab-item--pane-focused")).toHaveCount(1);

      // Collapse, then split again via the command — the other entry point.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.splitView.unsplit();
      });
      expect((await splitState(sidebar)).mode).toBe("single");
      await expect(sidebar.getByTestId("tab-pane")).toHaveCount(0);

      await runCommand(sidebar, "view.split");
      expect((await splitState(sidebar)).mode).toBe("split");
      await expect(sidebar.getByTestId("tab-pane")).toHaveCount(2);
      await expect(sidebar.locator(".tab-item--pane-focused")).toHaveCount(1);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §9.2 — split against a chosen tab via the command-bar "split" mode.
  test("view.splitChoose splits against the chosen tab as the right pane", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const [active, chosen] = await seedTabs(sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);

      await runCommand(sidebar, "view.splitChoose");

      // The bar opens in "split" mode.
      const bar = await commandBarState(sidebar);
      expect(bar.mode).toBe("split");

      // Exactly one command-bar suggestion, the one other open tab, rendered as a
      // data-kind="tab" row. Read from main's command-bar state (deterministic)
      // rather than polling the overlay DOM, which races the renderer's render.
      expect(bar.suggestions.filter((s) => s.kind === "tab")).toHaveLength(1);

      // Accept the row for the chosen tab (over the bridge, avoiding the overlay
      // blur-close race noted in repo memory).
      const index = bar.suggestions.findIndex((s) => s.kind === "tab" && s.tabId === chosen);
      expect(
        index,
        'expected a data-kind="tab" suggestion for the other open tab',
      ).toBeGreaterThanOrEqual(0);
      await sidebar.evaluate((i) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commandBar.accept(i);
      }, index);

      await expect.poll(async () => (await splitState(sidebar)).mode).toBe("split");
      const split = asSplit(await splitState(sidebar));
      expect(split.left).toBe(active);
      expect(split.right).toBe(chosen);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §9.3 — dragging the divider moves the ratio toward the drag, within [0.2, 0.8].
  test("dragging the divider moves the split ratio toward the drag within [0.2, 0.8]", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const [, right] = await seedTabs(sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
      await splitWith(sidebar, right);
      expect(asSplit(await splitState(sidebar)).ratio).toBeCloseTo(0.5, 5);

      const divider = await windowByUrl(app, "view=divider");
      const ratio = await dragDivider(divider, sidebar, 280);

      // Rightward drag raised the left-pane ratio, and it stayed clamped.
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeGreaterThanOrEqual(0.2);
      expect(ratio).toBeLessThanOrEqual(0.8);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §9.4 — focus other pane moves focus and the active tab; swap exchanges panes.
  test("view.focusOtherPane moves focus and the active tab; view.swapPanes exchanges panes keeping ratio", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const [left, right] = await seedTabs(sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
      await splitWith(sidebar, right);

      // Move the ratio off the default 0.5 so the swap's "ratio preserved"
      // assertion below can distinguish preserved from reset-to-default.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.splitView.setRatio(0.68);
      });
      expect(asSplit(await splitState(sidebar)).ratio).toBeCloseTo(0.68, 5);

      let split = asSplit(await splitState(sidebar));
      expect(split.focused).toBe("left");
      expect((await listTabs(sidebar)).activeTabId).toBe(left);

      await runCommand(sidebar, "view.focusOtherPane");
      split = asSplit(await splitState(sidebar));
      expect(split.focused).toBe("right");
      // The active tab follows focus to the other pane.
      expect((await listTabs(sidebar)).activeTabId).toBe(right);

      const ratioBefore = split.ratio;
      await runCommand(sidebar, "view.swapPanes");
      const swapped = asSplit(await splitState(sidebar));
      expect(swapped.left).toBe(right);
      expect(swapped.right).toBe(left);
      expect(swapped.ratio).toBeCloseTo(ratioBefore, 5);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §9.5 — closing a paned tab, or activating a non-paned tab, collapses to single.
  test("closing a paned tab, or activating a non-paned tab, collapses the split to single", async () => {
    // Scenario A: closing a paned tab collapses; the surviving pane stays active.
    {
      const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
      const { app, sidebar } = await launch(userDataDir);
      try {
        const [left, right] = await seedTabs(sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
        await splitWith(sidebar, right); // left active/focused, right the other pane
        await sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.tabs.close(id);
        }, right);

        expect((await splitState(sidebar)).mode).toBe("single");
        expect((await listTabs(sidebar)).activeTabId).toBe(left);
      } finally {
        await app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }

    // Scenario B: activating a NON-paned tab collapses the split to single.
    {
      const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
      const { app, sidebar } = await launch(userDataDir);
      try {
        const [, right, other] = await seedTabs(sidebar, [
          "ZEOSPLIT_A",
          "ZEOSPLIT_B",
          "ZEOSPLIT_C",
        ]);
        await splitWith(sidebar, right); // panes are A (left) and B (right); C is non-paned
        await sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.tabs.activate(id);
        }, other);

        expect((await splitState(sidebar)).mode).toBe("single");
        expect((await listTabs(sidebar)).activeTabId).toBe(other);
      } finally {
        await app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  // §9.6 — the split (panes + divider ratio) is persisted and restored across
  // relaunch; a pre-relaunch paned-tab close restores a single layout.
  test("a split with a dragged ratio is restored across relaunch; a pre-relaunch close restores single", async () => {
    // Scenario A: split + non-default ratio survive relaunch.
    {
      const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
      let left: string;
      let right: string;
      let savedRatio: number;

      const first = await launch(userDataDir);
      try {
        const ids = await seedTabs(first.sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
        left = ids[0];
        right = ids[1];
        await splitWith(first.sidebar, right);
        const divider = await windowByUrl(first.app, "view=divider");
        savedRatio = await dragDivider(divider, first.sidebar, 280);
        expect(savedRatio).toBeGreaterThan(0.5);
        await waitForDebouncedSave();
      } finally {
        await first.app.close();
      }

      const second = await launch(userDataDir);
      try {
        const split = asSplit(await splitState(second.sidebar));
        expect(split.left).toBe(left);
        expect(split.right).toBe(right);
        expect(split.ratio).toBeCloseTo(savedRatio, 2);
        // Both paned tabs came back as open tabs.
        const openIds = (await listTabs(second.sidebar)).tabs.map((t) => t.id);
        expect(openIds).toContain(left);
        expect(openIds).toContain(right);
      } finally {
        await second.app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }

    // Scenario B: a paned tab closed BEFORE relaunch restores a single layout.
    {
      const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));

      const first = await launch(userDataDir);
      try {
        const [, right] = await seedTabs(first.sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
        await splitWith(first.sidebar, right);
        await first.sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.tabs.close(id);
        }, right);
        expect((await splitState(first.sidebar)).mode).toBe("single");
        await waitForDebouncedSave();
      } finally {
        await first.app.close();
      }

      const second = await launch(userDataDir);
      try {
        expect((await splitState(second.sidebar)).mode).toBe("single");
      } finally {
        await second.app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  // §9.7 — the FIRST divider drag after a restored split tracks the drag. Guards
  // the mount-time dividerGeometry() seed: a divider lacking geometry would feed
  // NaN/0 and pin the ratio to the default instead of tracking, so the drag would
  // never acknowledge and this test would fail.
  test("the first divider drag after a restored split tracks the drag (mount-time geometry seed)", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));

    const first = await launch(userDataDir);
    try {
      const [, right] = await seedTabs(first.sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
      await splitWith(first.sidebar, right);
      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    const second = await launch(userDataDir);
    try {
      expect(asSplit(await splitState(second.sidebar)).ratio).toBeCloseTo(0.5, 5);

      // Immediately drag the restored divider — no intervening resize or layout
      // change — so only the mount-time geometry seed can make the ratio track.
      const divider = await windowByUrl(second.app, "view=divider");
      const ratio = await dragDivider(divider, second.sidebar, 280);
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThanOrEqual(0.8);
    } finally {
      await second.app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §9.8 — an invalid focusPane payload rejects with a TypeError and changes nothing.
  test("splitView.focusPane rejects an invalid pane with a TypeError and changes nothing", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-split-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const [, right] = await seedTabs(sidebar, ["ZEOSPLIT_A", "ZEOSPLIT_B"]);
      await splitWith(sidebar, right);
      const before = await splitState(sidebar);

      const rejection = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.splitView.focusPane("middle");
          return { rejected: false, name: "", message: "" };
        } catch (err) {
          const e = err as { name?: string; message?: string };
          return {
            rejected: true,
            name: e?.name ?? "",
            message: String(e?.message ?? err),
          };
        }
      });
      expect(rejection.rejected).toBe(true);
      // Over Electron IPC the main-thread TypeError surfaces as a rejection whose
      // name is "TypeError" or whose message carries the "TypeError" prefix / the
      // guard's "focusPane" text — accept any of those forms (mirrors
      // settings.spec.ts's setSearchEngine assertion).
      expect(
        rejection.name === "TypeError" ||
          rejection.message.includes("TypeError") ||
          rejection.message.includes("focusPane"),
      ).toBe(true);

      // The invalid call changed nothing.
      expect(await splitState(sidebar)).toEqual(before);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
