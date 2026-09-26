import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// PRD 9.1 — shared view-URL poll helpers (VIEW_POLL_TIMEOUT_MS-bounded).
import { waitForViewGone, waitForViewUrl } from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors app.spec.ts: e2e/tests -> repo
// root is two levels up, then into the desktop app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e does not depend on @zeo/core, so we redeclare only the slice these
// persistence tests touch (a subset of app.spec.ts's copy). Structurally
// compatible with @zeo/core; only the fields we assert on are load-bearing.
interface BridgeTab {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  pinned: boolean;
}
interface BridgeSpace {
  id: string;
  name: string;
  profileId: string;
  createdAt: number;
}
interface BridgeProfile {
  id: string;
  name: string;
  createdAt: number;
}
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
}
interface BridgeState extends BridgeSpacesState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  archived: BridgeTab[];
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    archive(id: string): Promise<void>;
    pin(id: string): Promise<void>;
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
}

/**
 * Return the renderer window that hosts the React sidebar. Copied from
 * app.spec.ts: `firstWindow()` cannot be trusted because each tab is a separate
 * WebContentsView that may also surface as a window, so poll every open window
 * for the one exposing the sidebar, guarding a navigating view's destroyed
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
 * Launch the packaged Electron build against a specific on-disk userData dir.
 * Electron honors `--user-data-dir`, so two launches pointed at the same dir
 * share the same `zeo.db` — the whole mechanism these tests exercise. Mirrors
 * app.spec.ts's launch: empty ELECTRON_RENDERER_URL forces the production
 * loadFile path, ZEO_E2E=1 puts main in headless test mode, and --no-sandbox is
 * gated on ZEO_E2E_NO_SANDBOX (set by the docker sidecar which runs as root).
 */
async function launch(
  userDataDir: string,
): Promise<{ app: ElectronApplication; sidebar: Page }> {
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
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS so the debounced
 * save after the LAST mutation definitely lands on disk before we close launch
 * #1. This waits on a real debounce timer (not a race), so a fixed sleep is the
 * correct instrument — before-quit alone is deliberately not relied upon.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

/** Read the full tab/space snapshot over the sidebar bridge. */
function readState(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

/** Read the spaces-only snapshot over the sidebar bridge. */
function readSpaces(sidebar: Page): Promise<BridgeSpacesState> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.list();
  });
}

/** Every live WebContents URL in the main process (renderer + tab views). */
function allWebContentsUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((wc) => wc.getURL()),
  );
}

// Each test manages its OWN two launches against a per-test temp userData dir,
// so there is no shared beforeEach launch. The config gives 60s per test; two
// cold starts fit. IDs are captured from launch #1's evaluate and reused as
// strings in launch #2 — they persist across the process boundary, which is
// exactly the property under test.
test.describe("PRD 3.4 relaunch persistence", () => {
  test("restored spaces, tabs, order, pins, archived, and active ids survive relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-persist-"));

    // Distinct in-URL tokens; none is a substring of another, so a URL
    // `includes(token)` match identifies exactly one tab's view. All tab URLs
    // are data: URLs (no network fetch), so CI navigation cannot flake this.
    const tokenActive = "ZEOPERSIST_ACTIVE";
    const tokenOther = "ZEOPERSIST_OTHER";
    const tokenWork = "ZEOPERSIST_WORK";

    // --- Launch #1: build the state, then wait out the debounce and close. ---
    const first = await launch(userDataDir);
    let ids: {
      personalId: string;
      workId: string;
      t0: string;
      ta: string;
      tb: string;
      tc: string;
      tw: string;
    };
    try {
      ids = await first.sidebar.evaluate(
        async (tokens) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const initial = await zeo.tabs.list();
          const personalId = initial.activeSpaceId;
          const t0 = initial.activeTabId;
          if (t0 === null) {
            throw new Error("expected a seeded active tab on fresh launch");
          }
          // Personal: create TA (active token) then TB (other token).
          const ta = (await zeo.tabs.create("data:text/html," + tokens.active)).id;
          const tb = (await zeo.tabs.create("data:text/html," + tokens.other)).id;
          // Pin the seeded tab T0.
          await zeo.tabs.pin(t0);
          // Create TC (about:blank) then archive it.
          const tc = (await zeo.tabs.create("about:blank")).id;
          await zeo.tabs.archive(tc);
          // Make TA Personal's active tab.
          await zeo.tabs.activate(ta);
          // Second space "Work": activate it, create TW there.
          const work = await zeo.spaces.create("Work");
          await zeo.spaces.activate(work.id);
          const tw = (await zeo.tabs.create("data:text/html," + tokens.work)).id;
          // Re-activate Personal so the ACTIVE space at save time is Personal,
          // its active tab TA — so after relaunch exactly ONE view (TA) is
          // materialized.
          await zeo.spaces.activate(personalId);
          return { personalId, workId: work.id, t0, ta, tb, tc, tw };
        },
        { active: tokenActive, other: tokenOther, work: tokenWork },
      );

      // Distinct ids for all seven records.
      expect(new Set(Object.values(ids)).size).toBe(7);

      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    // --- Launch #2: same dir; assert the restored state. ---
    const second = await launch(userDataDir);
    try {
      // Spaces list and active space (by NAME->id; ids are the restored originals).
      const spaces = await readSpaces(second.sidebar);
      expect(spaces.spaces.map((s) => s.name)).toEqual(["Personal", "Work"]);
      expect(spaces.activeSpaceId).toBe(ids.personalId);

      // Personal is active after relaunch: assert its tab structure.
      const personal = await readState(second.sidebar);
      // Order: pinned (T0) then unpinned in creation order (TA, TB).
      expect(personal.tabs.map((t) => t.id)).toEqual([ids.t0, ids.ta, ids.tb]);
      // Exactly T0 is pinned.
      expect(personal.tabs.filter((t) => t.pinned).map((t) => t.id)).toEqual([ids.t0]);
      // TC came back archived.
      expect(personal.archived.map((t) => t.id)).toContain(ids.tc);
      // Personal's active tab restored to TA.
      expect(personal.activeTabId).toBe(ids.ta);

      // --- Lazy-view assertion (transition form, not a bare negative). ---
      // With Personal active, TA's view materializes; poll until its token is
      // present in the live WebContents URLs.
      await waitForViewUrl(second.app, tokenActive);

      // Exactly ONE tab view is materialized: only TA. TB and TW are restored
      // but not yet materialized (TB inactive in Personal; TW in inactive Work).
      const urlsAfterRestore = await allWebContentsUrls(second.app);
      expect(urlsAfterRestore.filter((u) => u.includes("ZEOPERSIST_")).length).toBe(1);
      // Belt and braces: TB's token is absent before we activate it — poll to
      // absence (a view can linger a tick), mirroring the migration stale check.
      await waitForViewGone(second.app, tokenOther);

      // Activate TB (its id persisted from launch #1): its view must materialize
      // ONLY now, on activation — the lazy-restore transition.
      await second.sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.tabs.activate(id);
      }, ids.tb);
      await waitForViewUrl(second.app, tokenOther);

      // Switch to Work: it shows only its own tab TW, active is TW.
      const work = await second.sidebar.evaluate(async (id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.spaces.activate(id);
        return zeo.tabs.list();
      }, ids.workId);
      expect(work.activeSpaceId).toBe(ids.workId);
      expect(work.tabs.map((t) => t.id)).toEqual([ids.tw]);
      expect(work.activeTabId).toBe(ids.tw);
    } finally {
      await second.app.close();
    }
  });

  test("an all-archived database relaunches without seeding a new tab", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-persist-"));

    // --- Launch #1: archive every open tab, leaving an archived-only DB. ---
    const first = await launch(userDataDir);
    let archivedCount: number;
    try {
      archivedCount = await first.sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        // Seeded T0 plus one more, so at least two tabs get archived.
        await zeo.tabs.create("about:blank");
        let state = await zeo.tabs.list();
        while (state.tabs.length > 0) {
          await zeo.tabs.archive(state.tabs[0].id);
          state = await zeo.tabs.list();
        }
        return state.archived.length;
      });
      expect(archivedCount).toBeGreaterThanOrEqual(2);

      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    // --- Launch #2: an archived-only DB restores WITHOUT re-seeding. ---
    const second = await launch(userDataDir);
    try {
      const state = await readState(second.sidebar);
      // No new default tab was seeded — hasData() saw the archived rows.
      expect(state.tabs).toHaveLength(0);
      // The archived set survived intact.
      expect(state.archived).toHaveLength(archivedCount);
    } finally {
      await second.app.close();
    }
  });

  test("two spaces on distinct profiles keep distinct cookie state across relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-persist-"));

    // --- Launch #1: two profiles/spaces, a cookie per partition, flushed. ---
    const first = await launch(userDataDir);
    let profileIds: { idA: string; idB: string };
    try {
      profileIds = await first.sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const profA = await zeo.profiles.create("PersistProfA");
        const profB = await zeo.profiles.create("PersistProfB");
        const spaceA = await zeo.spaces.create("SA");
        const spaceB = await zeo.spaces.create("SB");
        await zeo.spaces.setProfile(spaceA.id, profA.id);
        await zeo.spaces.setProfile(spaceB.id, profB.id);
        return { idA: profA.id, idB: profB.id };
      });
      expect(profileIds.idA).not.toBe(profileIds.idB);

      // In MAIN: set a distinct cookie on each partition and flush to disk so it
      // survives quit independent of the debounced state save. The cookie MUST
      // carry an expirationDate — without one it is a session cookie that
      // Electron keeps only in memory and never writes to disk (flushStore only
      // flushes PERSISTENT cookies), so it would not survive relaunch.
      await first.app.evaluate(
        async ({ session }, data) => {
          const expirationDate = Math.floor(Date.now() / 1000) + 3600;
          const a = session.fromPartition("persist:" + data.idA);
          await a.cookies.set({ url: "https://zeo.test/", name: "iso", value: "A", expirationDate });
          await a.cookies.flushStore();
          const b = session.fromPartition("persist:" + data.idB);
          await b.cookies.set({ url: "https://zeo.test/", name: "iso", value: "B", expirationDate });
          await b.cookies.flushStore();
        },
        profileIds,
      );

      await waitForDebouncedSave();
    } finally {
      await first.app.close();
    }

    // --- Launch #2: read each partition's cookie store back. ---
    const second = await launch(userDataDir);
    try {
      const spacesAfter = await readSpaces(second.sidebar);
      const profileByName = new Map(
        spacesAfter.spaces.map((s) => [s.name, s.profileId]),
      );
      expect(profileByName.get("SA")).toBe(profileIds.idA);
      expect(profileByName.get("SB")).toBe(profileIds.idB);

      const result = await second.app.evaluate(
        async ({ session }, data) => {
          const a = await session
            .fromPartition("persist:" + data.idA)
            .cookies.get({ url: "https://zeo.test/" });
          const b = await session
            .fromPartition("persist:" + data.idB)
            .cookies.get({ url: "https://zeo.test/" });
          return {
            aHasA: a.some((c) => c.name === "iso" && c.value === "A"),
            aHasB: a.some((c) => c.value === "B"),
            bHasB: b.some((c) => c.name === "iso" && c.value === "B"),
            bHasA: b.some((c) => c.value === "A"),
          };
        },
        profileIds,
      );

      // Profile A's store kept iso=A and never saw B; profile B the mirror image.
      expect(result.aHasA).toBe(true);
      expect(result.aHasB).toBe(false);
      expect(result.bHasB).toBe(true);
      expect(result.bHasA).toBe(false);
    } finally {
      await second.app.close();
    }
  });
});

// PRD 9.5 M3 — window bounds + maximized state persist across a relaunch, and a
// saved position that is now off-screen (e.g. a detached display) is dropped so
// the restored window is never lost off the visible desktop. Both tests run their
// own two launches against a per-test temp userData dir (same shape as the PRD 3.4
// suite above); app.evaluate runs in the MAIN process, so BrowserWindow/screen are
// available. waitForDebouncedSave (1300ms) clears the 500ms window-state debounce.
test.describe("PRD 9.5 window-state restore", () => {
  test("restores window size and position across relaunch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeo-winstate-"));

    // --- Launch #1: resize/reposition the (un-maximized) window, then persist. ---
    // Derive the target frame from the live primary work area so it fits ENTIRELY
    // on-screen: a hardcoded 900×700 is clamped down to the work-area height on a
    // small display (e.g. the macOS CI runner's ~677px-tall work area), so
    // resolveWindowBounds would legitimately shrink the restore and the exact
    // round-trip below would fail. Capping at 900×700 minus a 120px margin (and
    // flooring at the 640×400 minimum window size), inset 60px into the work area,
    // guarantees no size-clamp and no position-drop on any display, so the frame
    // round-trips losslessly.
    const first = await launch(dir);
    const workArea = await first.app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    );
    const width = Math.max(640, Math.min(900, workArea.width - 120));
    const height = Math.max(400, Math.min(700, workArea.height - 120));
    const x = workArea.x + 60;
    const y = workArea.y + 60;
    try {
      await first.app.evaluate(
        ({ BrowserWindow }, frame) => {
          const w = BrowserWindow.getAllWindows()[0];
          // Ensure the frame (not a maximized state) is what getNormalBounds saves;
          // setBounds then fires move + resize, scheduling the debounced save.
          w.unmaximize?.();
          w.setBounds(frame);
        },
        { x, y, width, height },
      );
      await waitForDebouncedSave();
    } finally {
      // The close/before-quit flush also persists the current normal bounds.
      await first.app.close();
    }

    // --- Launch #2: the restored window opens with the saved frame. ---
    const second = await launch(dir);
    try {
      const bounds = await second.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getNormalBounds(),
      );
      // The frame was chosen to fit the work area, so the restore is lossless;
      // ±1 absorbs platform rounding of window geometry.
      expect(Math.abs(bounds.width - width)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.height - height)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.x - x)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.y - y)).toBeLessThanOrEqual(1);
    } finally {
      await second.app.close();
    }
  });

  test("an off-screen saved position falls back to an on-screen window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeo-winstate-"));

    // --- Launch #1: pre-write an off-screen row, then die WITHOUT a graceful
    // close so the close/before-quit flush cannot overwrite it with the live
    // (on-screen) bounds. The db is created at schema v11 on this fresh dir. ---
    const first = await launch(dir);
    await first.app.evaluate(() => {
      (
        globalThis as unknown as { __zeoWriteWindowState: (s: unknown) => void }
      ).__zeoWriteWindowState({ x: -5000, y: -5000, width: 900, height: 700, maximized: false });
    });
    // writeWindowState is synchronous (better-sqlite3), so the row is durable now.
    // Kill abruptly so before-quit/close don't re-save the live (on-screen) bounds.
    await first.app.evaluate(() => {
      process.exit(0);
    }).catch(() => {});
    await first.app.close().catch(() => {});

    // --- Launch #2: the off-screen position is dropped and the window is
    // centered fully within the primary display's work area. ---
    const second = await launch(dir);
    try {
      const bounds = await second.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getNormalBounds(),
      );
      const workArea = await second.app.evaluate(({ screen }) =>
        screen.getPrimaryDisplay().workArea,
      );
      // The 900×700 size was on-screen-sized, so it is preserved; only the
      // off-screen position is dropped, and main centers it explicitly on
      // the primary work area (see createWindow's centerInWorkArea).
      expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
      expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
      // "restores on-screen and centered" (PRD 9.5): the window's center
      // should match the work area's center within a few pixels of rounding.
      const centerXDelta = Math.abs(
        bounds.x + bounds.width / 2 - (workArea.x + workArea.width / 2),
      );
      const centerYDelta = Math.abs(
        bounds.y + bounds.height / 2 - (workArea.y + workArea.height / 2),
      );
      expect(centerXDelta).toBeLessThanOrEqual(4);
      expect(centerYDelta).toBeLessThanOrEqual(4);
    } finally {
      await second.app.close();
    }
  });
});
