import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts /
// persistence.spec.ts: e2e/tests -> repo root is two levels up, then the desktop
// app's production build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// downloads tests touch (structurally compatible with @zeo/core's ZeoApi). Only
// the fields we assert on are load-bearing.
//
// The PRD 6.2 `Download` record, as main returns it over IPC.downloadsList
// (downloads.items): credentials are already stripped from `url` by main, and a
// finished record carries a non-null `completedAt`. `state` is widened to string
// here since e2e asserts on literal values, not the core union.
interface DownloadRecord {
  id: string;
  url: string;
  filename: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: string;
  startedAt: number;
  completedAt: number | null;
  spaceId: string | null;
}
interface BridgeTab {
  id: string;
  url: string;
}
interface BridgeSpace {
  id: string;
  name: string;
  profileId: string;
}
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
}
interface BridgeProfile {
  id: string;
  name: string;
}
// One command-bar suggestion row. The real @zeo/core `Suggestion` is a
// discriminated union; the `download` arm carries `id`/`filename`/`state`, so we
// key the assertions off `kind === "download"`. Only those fields are load-bearing.
interface BridgeSuggestion {
  kind: string;
  id?: string;
  filename?: string;
  state?: string;
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
    list(): Promise<{ activeSpaceId: string }>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    activate(id: string): Promise<void>;
    setProfile(spaceId: string, profileId: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  profiles: {
    create(name: string): Promise<BridgeProfile>;
    delete(id: string): Promise<void>;
  };
  downloads: {
    list(): Promise<DownloadRecord[]>;
    cancel(id: string): Promise<void>;
    open(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    clearFinished(): Promise<void>;
  };
  commandBar: {
    open(mode: string): Promise<void>;
    state(): Promise<CommandBarStateShape>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
}

// Exact byte size asserted on disk: 64 KiB, matching the fixture's Content-Length
// and body length. Used as both the served length and the completion-size check.
const FILE_BYTES = 65536;
// The first partial chunk the slow endpoint flushes before holding the response
// open, so the download reaches "progressing" deterministically.
const SLOW_FIRST_CHUNK = 1024;

/** A running loopback fixture server plus a handle to release the slow response. */
interface FixtureServer {
  base: string;
  /**
   * Write the remaining bytes of every held `/slow.bin` response and end it, so a
   * slow download that is still active can be driven to completion on demand.
   * Best-effort: a response whose socket Electron already tore down (a cancelled
   * or interrupted download) is skipped.
   */
  finishSlow(): void;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port, serving two
 * attachment endpoints (mirrors blocking.spec.ts's fixture-server pattern):
 *   - `GET /file.bin` sends the whole 64 KiB body at once with a `report.bin`
 *     attachment name, so the download completes immediately.
 *   - `GET /slow.bin` sends only a first partial chunk with a `slow.bin`
 *     attachment name and a full Content-Length, then HOLDS the response open so
 *     the download stays "progressing"; {@link FixtureServer.finishSlow} releases it.
 * No pathname falls through to the network — the only origin any test touches is
 * this loopback server.
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const body = Buffer.alloc(FILE_BYTES, 0x7a); // 'z' * 65536
  const held: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/file.bin") {
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="report.bin"',
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    if (pathname === "/slow.bin") {
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="slow.bin"',
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      });
      // Flush a first chunk so receivedBytes > 0, then hold the socket open: the
      // download is registered and "progressing" but never reaches "done" until
      // finishSlow() (or a cancel/interrupt) fires.
      res.write(body.subarray(0, SLOW_FIRST_CHUNK));
      held.push(res);
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
    finishSlow: () => {
      for (const res of held.splice(0)) {
        try {
          res.end(body.subarray(SLOW_FIRST_CHUNK));
        } catch {
          // Electron already closed this download's socket (cancelled/interrupted).
        }
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Destroy any still-held slow sockets so close() is not kept open forever.
        for (const res of held.splice(0)) {
          try {
            res.destroy();
          } catch {
            // Already gone.
          }
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * The renderer window that hosts the React sidebar. Copied from
 * blocking.spec.ts / persistence.spec.ts: `firstWindow()` cannot be trusted
 * because each tab is a separate WebContentsView that may also surface as a
 * window, so poll every open window for the one exposing the sidebar, guarding a
 * navigating view's destroyed execution context with try/catch.
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
 * Launch the packaged Electron build against a temp userData dir, with the
 * downloads directory wired via ZEO_DOWNLOADS_DIR (main uses it as the save
 * directory when ZEO_E2E === "1", so no OS downloads folder is touched). Mirrors
 * blocking.spec.ts's `launch`: empty ELECTRON_RENDERER_URL (production loadFile
 * path), ZEO_E2E=1 (headless test mode), and --no-sandbox gated on
 * ZEO_E2E_NO_SANDBOX (the docker sidecar runs as root).
 */
async function launch(
  userDataDir: string,
  downloadsDir: string,
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
      ZEO_DOWNLOADS_DIR: downloadsDir,
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

/** Read the downloads list over the sidebar bridge (a live invoke round trip). */
function listDownloads(sidebar: Page): Promise<DownloadRecord[]> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.downloads.list();
  });
}

/** Read the command-bar state over the sidebar bridge. */
function commandBarState(sidebar: Page): Promise<CommandBarStateShape> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commandBar.state();
  });
}

/**
 * Poll `zeo.downloads.list()` over the sidebar bridge until `predicate` holds,
 * returning the matching list. A download is NOT a page commit, so navigation
 * never resolves when the record reaches its expected state — polling the list
 * (never a tab view) is the only deterministic wait. Throws on a deadline so a
 * stuck state fails loudly rather than hanging to the test timeout.
 */
async function pollDownloads(
  sidebar: Page,
  predicate: (items: DownloadRecord[]) => boolean,
  deadlineMs = 15_000,
): Promise<DownloadRecord[]> {
  const deadline = Date.now() + deadlineMs;
  let last: DownloadRecord[] = [];
  while (Date.now() < deadline) {
    last = await listDownloads(sidebar);
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `pollDownloads: predicate not satisfied within ${deadlineMs}ms; last list = ${JSON.stringify(last)}`,
  );
}

/**
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS before a relaunch.
 * Download rows are persisted through their own synchronous helpers (insert on
 * will-download, update on done/terminalize), so this is belt-and-braces — it also
 * lets any late download event settle before launch #1 closes. A fixed sleep on a
 * real timer, mirroring persistence.spec.ts.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

// Each test manages its OWN temp userData dir, downloads dir, and fixture server,
// torn down in `finally`, so on-disk assertions stay per-test clean. The config
// gives 60s per test; cases are grouped to keep cold starts (expensive under
// xvfb/docker) to one launch each, except the relaunch cases which need two.
test.describe("PRD 6.2 §8 downloads (offline)", () => {
  // Cases 1-3 chain on a single launch: a download completes, a second
  // de-duplicates, and removing the first drops it from the list while the file
  // stays on disk.
  test("saves a download, de-duplicates a second, and remove() drops the record while the file remains", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-downloads-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-dl-dir-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, downloadsDir);
    try {
      // --- Case 1: navigate a tab to /file.bin → it completes, and report.bin is
      // on disk at exactly 64 KiB. ---
      await createTab(sidebar, `${server.base}/file.bin`);
      const afterFirst = await pollDownloads(sidebar, (items) =>
        items.some((d) => d.filename === "report.bin" && d.state === "completed"),
      );
      const first = afterFirst.find((d) => d.filename === "report.bin")!;
      expect(existsSync(join(downloadsDir, "report.bin"))).toBe(true);
      expect(statSync(join(downloadsDir, "report.bin")).size).toBe(FILE_BYTES);
      expect(first.completedAt).not.toBeNull();

      // --- Case 2: a second /file.bin in a new tab lands as report (1).bin; the
      // original is unchanged; list() shows both, newest (the second) first. ---
      await createTab(sidebar, `${server.base}/file.bin`);
      const afterSecond = await pollDownloads(sidebar, (items) =>
        items.some((d) => d.filename === "report (1).bin" && d.state === "completed"),
      );
      expect(existsSync(join(downloadsDir, "report (1).bin"))).toBe(true);
      expect(statSync(join(downloadsDir, "report (1).bin")).size).toBe(FILE_BYTES);
      // The first file is untouched by the de-duplication.
      expect(statSync(join(downloadsDir, "report.bin")).size).toBe(FILE_BYTES);
      // Newest first: the second download (report (1).bin) sorts ahead of the first.
      expect(afterSecond.map((d) => d.filename)).toEqual(["report (1).bin", "report.bin"]);

      // --- Case 3: remove() the first (completed) download → it drops from
      // list() while report.bin stays on disk (remove never deletes the file). ---
      await sidebar.evaluate((id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.downloads.remove(id);
      }, first.id);
      const afterRemove = await pollDownloads(sidebar, (items) =>
        items.every((d) => d.id !== first.id),
      );
      expect(afterRemove.map((d) => d.filename)).toEqual(["report (1).bin"]);
      // The removed download's file is left on disk.
      expect(existsSync(join(downloadsDir, "report.bin"))).toBe(true);
      expect(statSync(join(downloadsDir, "report.bin")).size).toBe(FILE_BYTES);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  // Case 4: removing an ACTIVE download is atomic — the removal guard keeps a
  // later done event from resurrecting it, in memory and on disk across a relaunch.
  test("remove() on an active download keeps it absent from list() and persisted rows across relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-downloads-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-dl-dir-"));
    const server = await startFixtureServer();
    let removedId: string;
    try {
      // --- Launch #1: start a held /slow.bin download, remove it while active,
      // then release the slow response so its done fires against the guard. ---
      const first = await launch(userDataDir, downloadsDir);
      try {
        await createTab(first.sidebar, `${server.base}/slow.bin`);
        const progressing = await pollDownloads(first.sidebar, (items) =>
          items.some((d) => d.filename === "slow.bin" && d.state === "progressing"),
        );
        removedId = progressing.find((d) => d.filename === "slow.bin")!.id;

        await first.sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.downloads.remove(id);
        }, removedId);
        // It drops from list() immediately (remove removes from memory before it
        // broadcasts).
        const afterRemove = await pollDownloads(first.sidebar, (items) =>
          items.every((d) => d.id !== removedId),
        );
        expect(afterRemove.some((d) => d.id === removedId)).toBe(false);

        // Release the slow response: any trailing updated/done for the removed id
        // is suppressed by the removal guard and cannot recreate the record.
        server.finishSlow();
        await waitForDebouncedSave();
        const stillGone = await listDownloads(first.sidebar);
        expect(stillGone.some((d) => d.id === removedId)).toBe(false);
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dirs; the removed row never resurrects on disk. ---
      const second = await launch(userDataDir, downloadsDir);
      try {
        const items = await listDownloads(second.sidebar);
        expect(items.some((d) => d.id === removedId)).toBe(false);
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  // Case 5: a completed download persists across a relaunch with the same
  // --user-data-dir.
  test("a completed download survives relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-downloads-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-dl-dir-"));
    const server = await startFixtureServer();
    let completedId: string;
    try {
      // --- Launch #1: complete a download, then settle and close. ---
      const first = await launch(userDataDir, downloadsDir);
      try {
        await createTab(first.sidebar, `${server.base}/file.bin`);
        const items = await pollDownloads(first.sidebar, (ds) =>
          ds.some((d) => d.filename === "report.bin" && d.state === "completed"),
        );
        completedId = items.find((d) => d.filename === "report.bin")!.id;
        await waitForDebouncedSave();
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dir; the completed record is restored. ---
      const second = await launch(userDataDir, downloadsDir);
      try {
        const items = await listDownloads(second.sidebar);
        const restored = items.find((d) => d.id === completedId);
        expect(restored).toBeDefined();
        expect(restored?.filename).toBe("report.bin");
        expect(restored?.state).toBe("completed");
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  // Case 6: downloads.open opens the bar in downloads mode with the row present;
  // open(id) on a completed download whose file was deleted rejects.
  test("downloads.open shows the bar in downloads mode; open() rejects once the file is gone", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-downloads-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-dl-dir-"));
    const server = await startFixtureServer();
    const { app, sidebar } = await launch(userDataDir, downloadsDir);
    try {
      await createTab(sidebar, `${server.base}/file.bin`);
      const items = await pollDownloads(sidebar, (ds) =>
        ds.some((d) => d.filename === "report.bin" && d.state === "completed"),
      );
      const completed = items.find((d) => d.filename === "report.bin")!;

      // downloads.open runs the command that opens the bar in downloads mode and
      // leaves it open. Poll for the mode — the command dispatches and broadcasts.
      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.commands.run("downloads.open");
      });
      await expect
        .poll(async () => (await commandBarState(sidebar)).mode, {
          message: "expected downloads.open to put the bar in downloads mode",
        })
        .toBe("downloads");
      const bar = await commandBarState(sidebar);
      expect(bar.open).toBe(true);
      const row = bar.suggestions.find((s) => s.kind === "download");
      expect(row, "expected a download suggestion row in downloads mode").toBeDefined();
      expect(row?.filename).toBe("report.bin");

      // Delete the file from disk: open(id) must now reject (completed but the file
      // no longer exists), changing nothing.
      rmSync(join(downloadsDir, "report.bin"));
      await expect(
        sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.downloads.open(id);
        }, completed.id),
      ).rejects.toThrow();
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  // Case 7: deleting a profile while a download is in flight on its session
  // terminalizes that download to `interrupted` deterministically (the session is
  // cleared out from under the still-active item, which then never delivers a
  // `done`). The profile is first made space-unreferenced (its space remapped back
  // to the default profile) so deleteProfile permits the delete. The PRD's primary,
  // deterministic coverage of the no-`done` path is the m2 `terminalizeProfileDownloads`
  // unit test; this e2e is the recommended end-to-end corroboration.
  test("deleting a profile terminalizes its in-flight download as interrupted across relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-downloads-"));
    const downloadsDir = mkdtempSync(join(tmpdir(), "zeo-dl-dir-"));
    const server = await startFixtureServer();
    let slowId: string;
    try {
      // --- Launch #1: start a slow download on a second profile's session, make
      // that profile space-unreferenced, delete it, and assert the download is
      // terminalized to interrupted. ---
      const first = await launch(userDataDir, downloadsDir);
      try {
        // The default profile is the one the seeded active space already uses.
        const defaultProfileId = await first.sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const st = await zeo.spaces.list();
          const active = st.spaces.find((s) => s.id === st.activeSpaceId);
          if (active === undefined) {
            throw new Error("no active space in spaces.list()");
          }
          return active.profileId;
        });

        // A second profile + space on it, activated so a new tab starts on
        // persist:<profile>.
        const created = await first.sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          const profile = await zeo.profiles.create("DownloadsProfile");
          const space = await zeo.spaces.create("DownloadsSpace");
          await zeo.spaces.setProfile(space.id, profile.id);
          await zeo.spaces.activate(space.id);
          return { spaceId: space.id, profileId: profile.id };
        });

        await createTab(first.sidebar, `${server.base}/slow.bin`);
        const progressing = await pollDownloads(first.sidebar, (items) =>
          items.some((d) => d.filename === "slow.bin" && d.state === "progressing"),
        );
        slowId = progressing.find((d) => d.filename === "slow.bin")!.id;

        // Remap the space back to the default profile so the second profile is
        // referenced by no space; the session-level DownloadItem survives the view
        // teardown and keeps progressing on persist:<profile>.
        await first.sidebar.evaluate(
          (args) => {
            const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
            return zeo.spaces.setProfile(args.spaceId, args.defaultProfileId);
          },
          { spaceId: created.spaceId, defaultProfileId },
        );

        // Delete the now-unreferenced profile: teardown terminalizes the in-flight
        // download (interrupted, persisted, filename released) before the partition
        // is cleared, without waiting for a `done`.
        await first.sidebar.evaluate((pid) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.profiles.delete(pid);
        }, created.profileId);

        const terminal = await pollDownloads(first.sidebar, (items) =>
          items.some((d) => d.id === slowId && d.state === "interrupted"),
        );
        const record = terminal.find((d) => d.id === slowId)!;
        expect(record.state).toBe("interrupted");
        // Terminalized, not left progressing: a finished state carries completedAt.
        expect(record.completedAt).not.toBeNull();
        await waitForDebouncedSave();
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dirs; the record stays interrupted (never resurfaces
      // as progressing via the next-launch sweep). ---
      const second = await launch(userDataDir, downloadsDir);
      try {
        const items = await listDownloads(second.sidebar);
        const restored = items.find((d) => d.id === slowId);
        expect(restored).toBeDefined();
        expect(restored?.state).toBe("interrupted");
      } finally {
        await second.app.close();
      }
    } finally {
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    }
  });
});
