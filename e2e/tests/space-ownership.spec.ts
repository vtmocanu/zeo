import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// PRD 9.4 §6 — the space-row activation debounce. Scenarios 3/6 wait this delay
// (plus a margin) to prove a double-click's activation guard fired, so the number
// is derived from the source of truth rather than hard-coded and can never drift.
import { SPACE_ACTIVATE_DELAY_MS } from "@zeo/core";
// PRD 9.1 — shared view-URL poll helpers (VIEW_POLL_TIMEOUT_MS-bounded), so every
// WebContentsView URL/existence wait goes through one module (cold-runner timing).
import { loadViewUrl, waitForViewUrl, VIEW_POLL_TIMEOUT_MS } from "./helpers/view";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors app.spec.ts / persistence.spec.ts:
// e2e/tests -> repo root is two levels up, then into the desktop production build.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e does not depend on @zeo/core, so we redeclare only the slice these
// space-ownership tests touch (a subset of app.spec.ts's copy), keeping the spec
// import-free of @zeo/core's type surface. Structurally compatible with the
// @zeo/core contract; only the fields the assertions read are load-bearing.
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
// PRD 9.4 — `spaces.list()` returns the space slice INCLUDING every profile, so
// the composite-profile test can read a space's assigned `profileId` and the full
// profile set back over the bridge (mirrors @zeo/core's SpacesState).
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
  profiles: BridgeProfile[];
}
interface BridgeState extends BridgeSpacesState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  // PRD 9.3 — ids of the ACTIVE space's open tabs with no live view. Scenario 5
  // asserts a foreign-activated tab is NOT listed here (its view materialized).
  unloadedTabIds: string[];
}
// PRD 4.2 — one command-bar suggestion row, structurally the @zeo/core
// `Suggestion` union (redeclared import-free like the rest of this file). The
// inactive-space metadata test keys off the `tab` kind's `title`/`spaceName`.
type BridgeSuggestion =
  | { kind: "navigate"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "archived-tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "space"; spaceId: string; name: string }
  | { kind: "command"; id: string; title: string; accelerator: string | null };
// PRD 4.2 — the widened command-bar state main broadcasts (the slice this spec
// reads: mode/open plus the ranked suggestions).
interface CommandBarStateShape {
  open: boolean;
  mode: "navigate" | "new-tab" | "commands";
  initialText: string;
  query: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
  revision: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    close(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  spaces: {
    create(name: string): Promise<BridgeSpace>;
    createAndActivate(name: string): Promise<BridgeSpace>;
    activate(id: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  profiles: {
    createAndAssign(spaceId: string, name: string): Promise<BridgeProfile>;
  };
  commandBar: {
    open(mode: "navigate" | "new-tab" | "commands"): Promise<void>;
    close(): Promise<void>;
    setQuery(text: string): Promise<void>;
    state(): Promise<CommandBarStateShape>;
  };
  // PRD 9.3 — the main-pushed state broadcast subscription. Registers `listener`
  // for every stateChange main sends and returns an unsubscribe function. The
  // inactive-space metadata test counts invocations to prove a title change on a
  // tab in an INACTIVE space pushes NO snapshot to the sidebar.
  onStateChange(listener: (state: BridgeState) => void): () => void;
}

/**
 * Return the renderer window that hosts the React sidebar. Copied from
 * app.spec.ts / persistence.spec.ts: `firstWindow()` cannot be trusted because
 * each tab is a separate WebContentsView that may also surface as a window, so
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
 * Mirrors app.spec.ts / persistence.spec.ts: an empty ELECTRON_RENDERER_URL forces
 * the production loadFile path, ZEO_E2E=1 puts main in headless test mode, and
 * --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (set by the docker sidecar, which
 * runs as root). Two launches pointed at the same dir share one zeo.db — the
 * mechanism the inactive-space persistence assertion exercises.
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

/** Read the spaces-only snapshot (spaces + activeSpaceId + profiles) over the bridge. */
function readSpaces(sidebar: Page): Promise<BridgeSpacesState> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.spaces.list();
  });
}

/** Read the ACTIVE space's full tab/space snapshot over the bridge. */
function readState(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

/** A running loopback page server plus a promisified close. */
interface LocalPageServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Start a loopback HTTP server serving two titled pages on 127.0.0.1 (an ephemeral
 * port), so a tab pointed at either commits deterministically and OFFLINE — no
 * external network, no page-load timing to swallow. `/plain.html` carries a boring
 * title; `/titled.html` carries the distinctive, searchable title the
 * inactive-space metadata assertions match on. Both pages share one origin, so
 * navigating between them never resets the per-tab blocked count (which would emit
 * an unrelated broadcast and confound the "no stateChange" assertion).
 */
async function startTitledServer(): Promise<LocalPageServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/plain.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>owner-a-initial</title>");
      return;
    }
    if (pathname === "/titled.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>zeoinactivemeta-owner-a</title>");
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
    throw new Error("local page server did not bind to an inet address");
  }
  const port = (address as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Wait strictly longer than db.ts's 1000ms SAVE_DEBOUNCE_MS so the debounced save
 * after the last mutation definitely lands on disk before we close a launch. This
 * waits on a real debounce timer (not a race), so a fixed sleep is the correct
 * instrument — the same pattern persistence.spec.ts uses.
 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

// PRD 9.4 (space ownership) e2e — §8 scenarios. Each test drives the sidebar
// bridge (`window.zeo`) and asserts on the broadcast/read-back state, so the
// assertions are network-INDEPENDENT and offline. Fresh launch per test: a
// pristine store (seeded "Personal" space + one seeded tab) makes counts
// deterministic and a CI retry (fresh worker) sees identical state. The one
// relaunch scenario manages its own second launch against the same userData dir.
test.describe("PRD 9.4 space ownership", () => {
  let app!: ElectronApplication;
  let sidebar!: Page;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    // Isolate on-disk persistence per test (PRD 3.4 saves a zeo.db under userData;
    // without a per-test dir the launches would share one DB and inherit state).
    userDataDir = mkdtempSync(join(tmpdir(), "zeo-e2e-94-"));
    ({ app, sidebar } = await launch(userDataDir));
  });

  test.afterEach(async () => {
    // Guard with optional-chaining: if a launch rejected, `app` is undefined and an
    // unguarded close would throw a secondary error masking the real failure.
    await app?.close();
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = undefined;
    }
  });

  // §8.1 — the composite `spaces.createAndActivate` creates exactly one space AND
  // makes it active in a single change; a blank name REJECTS over the bridge and
  // leaves the space set untouched (createSpace throws before anything is created).
  test("composite create adds one active space; a blank name rejects and adds none", async () => {
    const before = await readSpaces(sidebar);

    const created = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.createAndActivate("Composite Create");
    });

    const after = await readSpaces(sidebar);
    // Exactly one space was added, it is the returned one, and it is now active —
    // create + activate landed as a single observable change.
    expect(after.spaces.length).toBe(before.spaces.length + 1);
    expect(after.spaces.some((s) => s.id === created.id)).toBe(true);
    expect(after.activeSpaceId).toBe(created.id);

    // A blank name rejects over the bridge; the invoke's promise must reject.
    const blank = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.spaces.createAndActivate("");
        return false;
      } catch {
        return true;
      }
    });
    expect(blank).toBe(true);

    // No space was added by the rejected create, and the active space is unchanged.
    const afterBlank = await readSpaces(sidebar);
    expect(afterBlank.spaces.length).toBe(after.spaces.length);
    expect(afterBlank.activeSpaceId).toBe(created.id);
  });

  // §8.2 — the composite `profiles.createAndAssign` assigns the created profile to
  // the space; a duplicate name (against the seeded "Default", case-insensitively)
  // and an unknown space id both REJECT and leave the profile set unchanged.
  test("composite profile assigns to the space; duplicate and unknown-space names reject", async () => {
    const initial = await readSpaces(sidebar);
    const spaceId = initial.activeSpaceId;

    const profile = await sidebar.evaluate(async (sid) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.profiles.createAndAssign(sid, "Owner Profile");
    }, spaceId);

    const afterAssign = await readSpaces(sidebar);
    // The space now points at the new profile, and the profile exists in the set.
    expect(afterAssign.spaces.find((s) => s.id === spaceId)?.profileId).toBe(profile.id);
    expect(afterAssign.profiles.some((p) => p.id === profile.id)).toBe(true);

    const profileIdsBefore = afterAssign.profiles.map((p) => p.id).sort();

    // A duplicate name rejects with the duplicate-name message. Use "DEFAULT"
    // (uppercase) against the seeded "Default" to exercise the case-insensitive
    // comparison — a stronger check than an exact-case collision.
    const dup = await sidebar.evaluate(async (sid) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.profiles.createAndAssign(sid, "DEFAULT");
        return { rejected: false, message: "" };
      } catch (err) {
        return { rejected: true, message: err instanceof Error ? err.message : String(err) };
      }
    }, spaceId);
    expect(dup.rejected).toBe(true);
    expect(dup.message).toMatch(/Profile name already exists/i);

    // The rejected duplicate created no profile.
    const afterDup = await readSpaces(sidebar);
    expect(afterDup.profiles.map((p) => p.id).sort()).toEqual(profileIdsBefore);

    // An unknown space id rejects (spaceProfileId throws before any profile is
    // created), so the profile set is again unchanged.
    const unknown = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      try {
        await zeo.profiles.createAndAssign("nonexistent-space-id", "Unknown Space Profile");
        return false;
      } catch {
        return true;
      }
    });
    expect(unknown).toBe(true);

    const afterUnknown = await readSpaces(sidebar);
    expect(afterUnknown.profiles.map((p) => p.id).sort()).toEqual(profileIdsBefore);
  });

  // §8.3 — a double-click on an INACTIVE space row opens the rename input and the
  // activation guard cancels the deferred single-click activate, so the active
  // space is unchanged even after SPACE_ACTIVATE_DELAY_MS elapses. Playwright's
  // dblclick fires both clicks within the delay window, so the second click clears
  // the pending timer — exactly the case PRD 9.4 §6 validates.
  test("double-clicking an inactive space opens rename and does not activate it", async () => {
    const personalId = (await readSpaces(sidebar)).activeSpaceId;

    // A second space, created but NOT activated, so there is an inactive row to
    // double-click while the seeded "Personal" space stays active.
    const second = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.create("Second");
    });
    await expect(sidebar.getByTestId("space-item")).toHaveCount(2);
    // Personal is still the active space before we touch the inactive row.
    expect((await readSpaces(sidebar)).activeSpaceId).toBe(personalId);

    const inactiveRow = sidebar.locator(`[data-space-id="${second.id}"]`);
    await expect(inactiveRow).toBeVisible();

    await inactiveRow.dblclick();

    // The rename input replaces the row.
    await expect(sidebar.getByTestId("space-name-input")).toBeVisible();

    // Wait out the activation delay plus a margin: the guard cancelled the deferred
    // activate, so the active space is STILL Personal (the double-clicked row never
    // became active).
    await new Promise((resolve) => setTimeout(resolve, SPACE_ACTIVATE_DELAY_MS + 150));
    expect((await readSpaces(sidebar)).activeSpaceId).toBe(personalId);
  });

  // §8.4 — a FOREIGN close: with space B active, closing a tab that belongs to the
  // inactive space A removes it from A's tab set (routed to A's owner store) while
  // B's tabs are untouched. Reading A's tabs requires switching to A afterward,
  // since the bridge's tabs.list() returns only the active space's tabs.
  test("closing a tab in an inactive space leaves the active space untouched", async () => {
    // Space A active, with one tab captured by id.
    const a = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const space = await zeo.spaces.createAndActivate("Owner A");
      const tab = await zeo.tabs.create("data:text/html,<title>owner-a-close</title>");
      return { spaceId: space.id, tabId: tab.id };
    });

    // Space B active, with its own tab, so "B unchanged" is a non-trivial assertion.
    const b = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const space = await zeo.spaces.createAndActivate("Owner B");
      const tab = await zeo.tabs.create("data:text/html,<title>owner-b-tab</title>");
      return { spaceId: space.id, tabId: tab.id };
    });

    // Precondition: B is active and shows only its own tab.
    const beforeClose = await readState(sidebar);
    expect(beforeClose.activeSpaceId).toBe(b.spaceId);
    expect(beforeClose.tabs.map((t) => t.id)).toEqual([b.tabId]);

    // Close A's tab while B is active — a foreign close that routes to A.
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.close(id);
    }, a.tabId);

    // B is unchanged: still active, still exactly its own tab.
    const afterClose = await readState(sidebar);
    expect(afterClose.activeSpaceId).toBe(b.spaceId);
    expect(afterClose.tabs.map((t) => t.id)).toEqual([b.tabId]);

    // Switch to A and confirm the closed tab is gone from A's set.
    const aTabs = await sidebar.evaluate(async (spaceId) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.spaces.activate(spaceId);
      return (await zeo.tabs.list()).tabs.map((t) => t.id);
    }, a.spaceId);
    expect(aTabs).not.toContain(a.tabId);
  });

  // §8.5 — a FOREIGN activate: with space B active, activating a tab in the
  // inactive space A RESOLVES, switches the active space to A (a cross-space
  // activate goes through a space switch first), makes that tab active, and
  // materializes its view.
  test("activating a tab in an inactive space switches to it and materializes its view", async () => {
    const aToken = "ZEOFOREIGNACT";
    const a = await sidebar.evaluate(async (token) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const space = await zeo.spaces.createAndActivate("Owner A");
      const tab = await zeo.tabs.create("data:text/html,<title>" + token + "</title>");
      return { spaceId: space.id, tabId: tab.id };
    }, aToken);

    // Space B active, with its own tab.
    const b = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      const space = await zeo.spaces.createAndActivate("Owner B");
      await zeo.tabs.create("data:text/html,<title>owner-b-tab</title>");
      return { spaceId: space.id };
    });
    expect((await readState(sidebar)).activeSpaceId).toBe(b.spaceId);

    // Foreign activate resolves.
    await sidebar.evaluate(async (id) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      await zeo.tabs.activate(id);
    }, a.tabId);

    // A is now the active space and the foreign tab is its active tab.
    await expect
      .poll(async () => readState(sidebar), { timeout: VIEW_POLL_TIMEOUT_MS })
      .toMatchObject({ activeSpaceId: a.spaceId, activeTabId: a.tabId });

    // The tab's view is materialized (its url is live) and it is not listed as an
    // unloaded tab — i.e. it became the visible active view.
    await waitForViewUrl(app, aToken);
    const after = await readState(sidebar);
    expect(after.unloadedTabIds).not.toContain(a.tabId);
  });

  // §8.6 — a double-click opens the rename input WITHOUT activating the row, and
  // pressing Escape restores the row with the active space still unchanged.
  // (Overlaps §8.3; kept separate to assert the Escape-restores path explicitly.)
  test("double-click rename opens without activating; Escape restores the row", async () => {
    const personalId = (await readSpaces(sidebar)).activeSpaceId;

    const second = await sidebar.evaluate(async () => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.spaces.create("Second");
    });
    await expect(sidebar.getByTestId("space-item")).toHaveCount(2);

    const inactiveRow = sidebar.locator(`[data-space-id="${second.id}"]`);
    await inactiveRow.dblclick();

    // The rename input opened and the active space is unchanged.
    const renameInput = sidebar.getByTestId("space-name-input");
    await expect(renameInput).toBeVisible();
    expect((await readSpaces(sidebar)).activeSpaceId).toBe(personalId);

    // Escape cancels the edit: the input closes and the row is restored.
    await renameInput.press("Escape");
    await expect(sidebar.getByTestId("space-name-input")).toHaveCount(0);
    await expect(inactiveRow).toBeVisible();

    // The active space is still the original one — Escape restored, never switched.
    expect((await readSpaces(sidebar)).activeSpaceId).toBe(personalId);
  });

  // §8.7 — inactive-space metadata: a title change on a tab in an INACTIVE space
  // (a) pushes NO stateChange to the sidebar, (b) still surfaces in the command
  // bar's catalog (which spans every space's tabs), and (c) is persisted across a
  // relaunch. The title change is driven from the MAIN process (loadURL on the
  // still-live view of A's kept active tab) so it commits deterministically while
  // B is the active space.
  test("an inactive-space title change is not broadcast but is cataloged and persisted", async () => {
    const server = await startTitledServer();
    const searchToken = "zeoinactivemeta"; // substring of the titled page's <title>
    const spaceAName = "Owner A";
    try {
      // Drop the seeded example.com tab (a lingering, offline-failing view) so the
      // measurement window below has no stray broadcast source; then build space A
      // with a tab pointed at the plain loopback page.
      const a = await sidebar.evaluate(async (base) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const seeded = await zeo.tabs.list();
        if (seeded.activeTabId !== null) {
          await zeo.tabs.close(seeded.activeTabId);
        }
        const space = await zeo.spaces.createAndActivate("Owner A");
        const tab = await zeo.tabs.create(base + "/plain.html");
        return { spaceId: space.id, tabId: tab.id };
      }, server.base);

      // The plain page committed while A is active (so hasRealTitle/origin are set;
      // a later same-origin navigation then emits no blocked-count broadcast).
      await waitForViewUrl(app, "/plain.html");

      // Switch to space B: A's active tab (T) keeps its live view (only the other
      // outgoing views are freed), so a later navigation still fires on it.
      const b = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const space = await zeo.spaces.createAndActivate("Owner B");
        return { spaceId: space.id };
      });
      expect((await readSpaces(sidebar)).activeSpaceId).toBe(b.spaceId);

      // Install a broadcast counter on the sidebar and let setup settle (the
      // blocking broadcast coalesces at 250ms; a fresh switch's broadcast is
      // synchronous), then record the baseline.
      await sidebar.evaluate(() => {
        const g = globalThis as unknown as { __zeo94: number; zeo: ZeoBridge };
        g.__zeo94 = 0;
        g.zeo.onStateChange(() => {
          g.__zeo94 += 1;
        });
      });
      const readCount = (): Promise<number> =>
        sidebar.evaluate(() => (globalThis as unknown as { __zeo94: number }).__zeo94);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const baseline = await readCount();

      // (a) Navigate A's inactive tab to the titled page from MAIN (same origin as
      // plain.html). This fires page-title-updated while A is inactive, which
      // persists + refreshes the catalog but pushes NO snapshot to the sidebar.
      await loadViewUrl(app, "/plain.html", server.base + "/titled.html");

      // Give any (erroneous) broadcast a full window to arrive, then assert none did.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await readCount()).toBe(baseline);

      // (b) The command-bar catalog carries the new inactive-space title, tagged
      // with A's space name — proving the title change actually landed (so (a) is
      // non-vacuous) and that the catalog spans inactive spaces.
      await sidebar.evaluate(async (token) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("new-tab");
        await zeo.commandBar.setQuery(token);
      }, searchToken);
      await expect
        .poll(
          async () =>
            sidebar.evaluate(async (ctx) => {
              const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
              const st = await zeo.commandBar.state();
              return st.suggestions.some(
                (s) =>
                  s.kind === "tab" &&
                  s.title.toLowerCase().includes(ctx.token) &&
                  s.spaceName === ctx.spaceName,
              );
            }, { token: searchToken, spaceName: spaceAName }),
          { timeout: VIEW_POLL_TIMEOUT_MS },
        )
        .toBe(true);
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.close();
      });

      // (c) Persist: wait out the debounced save, then relaunch against the SAME
      // userData dir. B is the active space on relaunch, so A's tab is NOT
      // materialized — the catalog reads the RESTORED store's title directly (no
      // page reload), proving the inactive-space title survived the restart. We
      // assert the token is present under A's space name; capturing the tab id here
      // confirms it is the same restored tab that belongs to A.
      await waitForDebouncedSave();
      await app.close();

      const relaunched = await launch(userDataDir!);
      app = relaunched.app;
      sidebar = relaunched.sidebar;

      await sidebar.evaluate(async (token) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("new-tab");
        await zeo.commandBar.setQuery(token);
      }, searchToken);
      await expect
        .poll(
          async () =>
            sidebar.evaluate(async (ctx) => {
              const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
              const st = await zeo.commandBar.state();
              return st.suggestions.some(
                (s) =>
                  s.kind === "tab" &&
                  s.tabId === ctx.tabId &&
                  s.title.toLowerCase().includes(ctx.token) &&
                  s.spaceName === ctx.spaceName,
              );
            }, { token: searchToken, spaceName: spaceAName, tabId: a.tabId }),
          { timeout: VIEW_POLL_TIMEOUT_MS },
        )
        .toBe(true);
    } finally {
      await server.close();
    }
  });
});
