import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts / history.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// e2e deliberately does NOT depend on @zeo/core; we redeclare only the slice these
// PRD 6.5 settings tests touch (structurally compatible with @zeo/core's ZeoApi).
// Only the fields we assert on are load-bearing. `setSearchEngine` is typed with a
// plain `string` id (not the catalog union) so a test can pass an INVALID id and
// assert the TypeError rejection, mirroring how blocking.spec.ts types allowSite.
interface BridgeProfile {
  id: string;
  name: string;
}
interface BridgeSpace {
  id: string;
  profileId: string;
}
interface BridgeTab {
  id: string;
  url: string;
  title?: string;
}
// PRD 6.5 — main attaches `settings`/`settingsSection`/`settingsSectionNonce` to
// the full snapshot returned by `tabs.list()`, alongside the space slice
// (`spaces`/`profiles`) and `settingsOpen`. Only the fields these tests read are
// declared; all are optional except the ones every case relies on.
interface BridgeState {
  tabs: BridgeTab[];
  activeTabId: string | null;
  activeSpaceId: string;
  spaces: BridgeSpace[];
  profiles: BridgeProfile[];
  settingsOpen?: boolean;
  settings: { searchEngine: string };
  settingsSection: string;
  settingsSectionNonce: number;
}
interface BridgeSpacesState {
  spaces: BridgeSpace[];
  activeSpaceId: string;
  profiles: BridgeProfile[];
}
// PRD 4.2/6.5 — one command-bar suggestion row. The real @zeo/core `Suggestion`
// is a discriminated union; the row-0 `search` arm carries `url`/`label`, so we
// redeclare a minimal view with those OPTIONAL and key assertions off `kind`.
interface BridgeSuggestion {
  kind: string;
  url?: string;
  label?: string;
}
interface CommandBarStateShape {
  open: boolean;
  mode: string;
  suggestions: BridgeSuggestion[];
  selectedIndex: number;
}
// PRD 6.1 — one recorded history visit; only `url` is load-bearing here (the
// history-section seeding polls `recent().length`).
interface HistoryVisit {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}
interface ZeoBridge {
  tabs: {
    create(url?: string): Promise<BridgeTab>;
    navigate(id: string, url: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  spaces: {
    setProfile(spaceId: string, profileId: string): Promise<void>;
    list(): Promise<BridgeSpacesState>;
  };
  profiles: {
    create(name: string): Promise<BridgeProfile>;
    delete(id: string): Promise<void>;
  };
  commandBar: {
    open(mode: string): Promise<void>;
    setQuery(text: string): Promise<void>;
    state(): Promise<CommandBarStateShape>;
    accept(index?: number, revision?: number): Promise<void>;
    close(): Promise<void>;
  };
  commands: {
    run(id: string): Promise<void>;
  };
  history: {
    recent(limit?: number): Promise<HistoryVisit[]>;
    clear(): Promise<void>;
    stats(): Promise<{ entries: number; visits: number }>;
  };
  settings: {
    get(): Promise<{ searchEngine: string }>;
    setSearchEngine(id: string): Promise<void>;
  };
}

/**
 * The renderer window that hosts the React sidebar. Copied from
 * blocking.spec.ts / history.spec.ts: `firstWindow()` cannot be trusted because
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
        // A tab's WebContentsView can surface as a window and, while navigating,
        // its execution context may be momentarily destroyed. Skip it this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="sidebar" was found within 15s');
}

/**
 * The settings {@link Page}: main mounts the settings surface in its own
 * `WebContentsView` loaded with `?view=settings`, which surfaces as its own
 * Playwright window (Electron pages come from every CDP page target). Poll every
 * open window for the one whose url carries `view=settings`, guarding a
 * still-loading view's context with try/catch. Mirrors blocking.spec.ts.
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

/**
 * Launch the packaged Electron build against a temp userData dir. Mirrors
 * history.spec.ts's `launch`: empty ELECTRON_RENDERER_URL forces main's
 * production loadFile path, ZEO_E2E=1 puts main in headless test mode, and
 * --no-sandbox is gated on ZEO_E2E_NO_SANDBOX (the docker sidecar runs as root).
 * Settings needs no adblock filters, so this launch omits them.
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

/** Run command `id` over the sidebar bridge (e.g. `settings.open`). */
function runCommand(sidebar: Page, id: string): Promise<void> {
  return sidebar.evaluate((cmd) => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.commands.run(cmd);
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

/** The current default search engine id, read over the sidebar bridge. */
function currentSearchEngine(sidebar: Page): Promise<string> {
  return sidebar.evaluate(async () => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return (await zeo.settings.get()).searchEngine;
  });
}

/** Open the settings view via `id`, waiting until `settingsOpen` reads true. */
async function openSettings(app: ElectronApplication, sidebar: Page, id: string): Promise<Page> {
  await runCommand(sidebar, id);
  await expect
    .poll(() => settingsOpen(sidebar), { message: `expected settingsOpen === true after ${id}` })
    .toBe(true);
  const settings = await settingsWindow(app);
  await expect(settings.getByTestId("settings")).toHaveCount(1);
  return settings;
}

/** The `tabs.list()` snapshot over the sidebar bridge. */
function tabsList(sidebar: Page): Promise<BridgeState> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.tabs.list();
  });
}

// A section-list row is "selected" when the renderer marks it aria-current="page"
// (the shown body). A section body is identified by a testid unique to it.
const SELECTED = (id: string): string => `[data-testid="settings-section-${id}"][aria-current="page"]`;
const HIGHLIGHT = (id: string): string =>
  `[data-testid="settings-section-${id}"].settings__section-item--highlight`;

test.describe("PRD 6.5 settings sections + search engine (offline)", () => {
  // §8 bullet a: the settings view lists the four sections in registry order.
  test("lists the four sections in registry order", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      const rows = settings.locator('.settings__sections [data-testid^="settings-section-"]');
      await expect(rows).toHaveCount(4);
      const ids = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")),
      );
      expect(ids).toEqual([
        "settings-section-general",
        "settings-section-blocking",
        "settings-section-profiles",
        "settings-section-history",
      ]);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet b: keyboard section switching. A fresh open selects General; two
  // ArrowDowns + Enter select Profiles (its body shown); two ArrowUps + Enter walk
  // the highlight back to General and re-select it. Driven as real DOM key events
  // into the settings view, where the section-nav listeners live at window level.
  test("switches the shown section with ArrowDown/ArrowUp + Enter", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      // A fresh open selects General (main defaults settingsSection to "general").
      await expect(settings.locator(SELECTED("general"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-search-engine-google")).toHaveCount(1);

      // ArrowDown x2 moves the highlight general -> blocking -> profiles.
      await settings.keyboard.press("ArrowDown");
      await settings.keyboard.press("ArrowDown");
      await expect(settings.locator(HIGHLIGHT("profiles"))).toHaveCount(1);
      // Enter selects the highlighted Profiles section: its body is now shown.
      await settings.keyboard.press("Enter");
      await expect(settings.locator(SELECTED("profiles"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-profile-create")).toHaveCount(1);
      // The previous body is gone (only the selected section's body renders).
      await expect(settings.getByTestId("settings-search-engine-google")).toHaveCount(0);

      // ArrowUp x2 walks the highlight back profiles -> blocking -> general; Enter
      // re-selects General, so its body is the one shown again.
      await settings.keyboard.press("ArrowUp");
      await settings.keyboard.press("ArrowUp");
      await expect(settings.locator(HIGHLIGHT("general"))).toHaveCount(1);
      await settings.keyboard.press("Enter");
      await expect(settings.locator(SELECTED("general"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-search-engine-google")).toHaveCount(1);
      await expect(settings.getByTestId("settings-profile-create")).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet b (focused-button path): Enter selects the HIGHLIGHTED section even
  // when a section-list <button> holds DOM focus after a mouse click — it must not
  // re-activate the clicked button. Guards the fix that defers Enter to native
  // handling only for text fields and action buttons OUTSIDE the section nav.
  test("Enter selects the highlighted section from a focused section button", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      // Click the Blocking row: it takes DOM focus and becomes the selection.
      await settings.getByTestId("settings-section-blocking").click();
      await expect(settings.locator(SELECTED("blocking"))).toHaveCount(1);

      // ArrowDown moves the highlight blocking -> profiles while focus stays on the
      // clicked Blocking button.
      await settings.keyboard.press("ArrowDown");
      await expect(settings.locator(HIGHLIGHT("profiles"))).toHaveCount(1);

      // Enter selects the HIGHLIGHTED Profiles section, not the focused Blocking
      // button (whose own activation is suppressed by preventDefault).
      await settings.keyboard.press("Enter");
      await expect(settings.locator(SELECTED("profiles"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-profile-create")).toHaveCount(1);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet c: the section re-selection regression the per-open nonce fixes.
  // openProfiles (Profiles shown) -> locally click History -> openProfiles AGAIN
  // must re-reveal Profiles (not leave History shown). Without the nonce bump the
  // unchanged section id would not move the renderer's local selection.
  test("re-selects a section on a repeated section-open command (nonce regression)", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.openProfiles");
      await expect(settings.locator(SELECTED("profiles"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-profile-create")).toHaveCount(1);

      // Locally select History by clicking its row — main's settingsSection stays
      // "profiles"; only the renderer's local selection moves.
      await settings.getByTestId("settings-section-history").click();
      await expect(settings.locator(SELECTED("history"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-history-retention")).toHaveCount(1);

      // Re-run openProfiles: the nonce bumps, so the renderer re-selects Profiles
      // even though the pushed section id ("profiles") is unchanged.
      await runCommand(sidebar, "settings.openProfiles");
      await expect(settings.locator(SELECTED("profiles"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-profile-create")).toHaveCount(1);
      // History's body is no longer the one shown.
      await expect(settings.getByTestId("settings-history-retention")).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet d: picking Google drives the command bar's search row and its
  // accept navigates the active tab to a google search url (asserted via stored
  // state only — the load itself is never awaited, so this stays offline).
  test("picking Google routes the command-bar search row and accept navigates the active tab", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.openGeneral");
      await settings.getByTestId("settings-search-engine-google").click();
      // The controlled radio + the persisted engine both reflect Google.
      await expect(settings.getByTestId("settings-search-engine-google")).toBeChecked();
      await expect.poll(() => currentSearchEngine(sidebar)).toBe("google");

      // The active seeded tab, whose url we will assert changes after accept.
      const activeTabId = (await tabsList(sidebar)).activeTabId;
      expect(activeTabId).not.toBeNull();

      // Open navigate mode, type a non-URL query; row 0 is the Google search row.
      const state = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.open("navigate");
        await zeo.commandBar.setQuery("hello");
        return zeo.commandBar.state();
      });
      expect(state.suggestions[0]?.kind).toBe("search");
      expect(state.suggestions[0]?.label).toBe('Search Google for "hello"');

      // Accept row 0: in navigate mode it navigates the active tab to the search
      // url. tabs.navigate updates the stored url synchronously before the load is
      // even kicked off, so poll the state (never a real network fetch).
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        await zeo.commandBar.accept(0);
      });
      await expect
        .poll(async () => {
          const st = await tabsList(sidebar);
          return st.tabs.find((t) => t.id === st.activeTabId)?.url ?? "";
        }, { message: "expected accept to navigate the active tab to a google search url" })
        .toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet e: the search-engine choice persists across relaunch. Launch #1
  // picks Google (written synchronously by setSearchEngine, so no debounce wait);
  // launch #2 against the SAME userData dir still reports Google and its command
  // bar still names Google in the search row.
  test("the search-engine choice persists across relaunch", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    try {
      // --- Launch #1: pick Google via the settings UI, then close. ---
      const first = await launch(userDataDir);
      try {
        const settings = await openSettings(first.app, first.sidebar, "settings.openGeneral");
        await settings.getByTestId("settings-search-engine-google").click();
        await expect.poll(() => currentSearchEngine(first.sidebar)).toBe("google");
      } finally {
        await first.app.close();
      }

      // --- Launch #2: same dir; the persisted choice is restored. ---
      const second = await launch(userDataDir);
      try {
        expect(await currentSearchEngine(second.sidebar)).toBe("google");
        const state = await second.sidebar.evaluate(async () => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          await zeo.commandBar.open("navigate");
          await zeo.commandBar.setQuery("hello");
          return zeo.commandBar.state();
        });
        expect(state.suggestions[0]?.kind).toBe("search");
        expect(state.suggestions[0]?.label).toBe('Search Google for "hello"');
      } finally {
        await second.app.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet f: setSearchEngine with an id outside the catalog REJECTS with a
  // TypeError and changes nothing (the prior engine still reports back).
  test("setSearchEngine rejects an unknown id with a TypeError and changes nothing", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const before = await currentSearchEngine(sidebar);

      const rejection = await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        try {
          await zeo.settings.setSearchEngine("not-an-engine");
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
      // "unknown search engine" text — accept any of those forms.
      expect(
        rejection.name === "TypeError" ||
          rejection.message.includes("TypeError") ||
          rejection.message.includes("unknown search engine"),
      ).toBe(true);

      // The unknown-id path changed nothing.
      expect(await currentSearchEngine(sidebar)).toBe(before);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet g: the controlled-radio invariant — after a rejected setSearchEngine
  // the checked General control still equals the persisted engine, never the
  // rejected value (the radios are bound to broadcast state, which a rejection,
  // which does not broadcast, never moves). A UI-path forced failure is not
  // feasible offline — the radio can only ever emit a valid catalog id — so the
  // rejection is triggered over the bridge with an invalid id, per §8's fallback.
  test("a rejected setSearchEngine leaves the checked General control on the persisted engine", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.openGeneral");
      // Persist a known, non-default engine via the UI so the invariant is not
      // vacuously true of the default.
      await settings.getByTestId("settings-search-engine-bing").click();
      await expect(settings.getByTestId("settings-search-engine-bing")).toBeChecked();
      await expect.poll(() => currentSearchEngine(sidebar)).toBe("bing");

      // A rejected set (invalid id) over the bridge changes nothing and never
      // broadcasts, so the checked radio stays on the persisted engine.
      await expect(
        sidebar.evaluate(() => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.settings.setSearchEngine("not-an-engine");
        }),
      ).rejects.toThrow();

      expect(await currentSearchEngine(sidebar)).toBe("bing");
      await expect(settings.getByTestId("settings-search-engine-bing")).toBeChecked();
      // No other catalog radio is checked (the invariant: exactly the persisted one).
      await expect(settings.getByTestId("settings-search-engine-duckduckgo")).not.toBeChecked();
      await expect(settings.getByTestId("settings-search-engine-google")).not.toBeChecked();
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet h: the profiles section creates, renames, and guards deletion. A
  // profile a space still points at cannot be deleted (control disabled + bridge
  // delete rejects); once no space uses it, deletion succeeds.
  test("profiles section creates, renames, and guards deletion by space usage", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.openProfiles");

      // Create a profile via the UI create row.
      await settings.getByTestId("settings-profile-create-name").fill("TestProfile");
      await settings.getByTestId("settings-profile-create").click();

      // It appears in TabsState.profiles; capture its id.
      await expect
        .poll(async () => (await tabsList(sidebar)).profiles.some((p) => p.name === "TestProfile"), {
          message: "expected the created profile to appear in TabsState.profiles",
        })
        .toBe(true);
      const profileId = (await tabsList(sidebar)).profiles.find(
        (p) => p.name === "TestProfile",
      )!.id;

      // Its row renders with the create name.
      await expect(settings.getByTestId(`settings-profile-name-${profileId}`)).toHaveValue(
        "TestProfile",
      );

      // Rename it via the row's rename control; TabsState reflects the new name.
      const nameInput = settings.getByTestId(`settings-profile-name-${profileId}`);
      await nameInput.fill("RenamedProfile");
      await settings.getByTestId(`settings-profile-rename-${profileId}`).click();
      await expect
        .poll(
          async () => (await tabsList(sidebar)).profiles.find((p) => p.id === profileId)?.name,
          { message: "expected the rename to reflect in TabsState.profiles" },
        )
        .toBe("RenamedProfile");

      // Point the active space at the new profile (remembering its original profile
      // so we can free it again below).
      const spacesState = await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.spaces.list();
      });
      const spaceId = spacesState.activeSpaceId;
      const originalProfileId = spacesState.spaces.find((s) => s.id === spaceId)!.profileId;
      expect(originalProfileId).not.toBe(profileId);
      await sidebar.evaluate(
        (args) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.spaces.setProfile(args.spaceId, args.profileId);
        },
        { spaceId, profileId },
      );

      // While referenced: the delete control is disabled AND a bridge delete rejects.
      await expect(settings.getByTestId(`settings-profile-delete-${profileId}`)).toBeDisabled();
      await expect(
        sidebar.evaluate((id) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.profiles.delete(id);
        }, profileId),
      ).rejects.toThrow();
      expect((await tabsList(sidebar)).profiles.some((p) => p.id === profileId)).toBe(true);

      // Free the profile by pointing the space back at its original profile.
      await sidebar.evaluate(
        (args) => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.spaces.setProfile(args.spaceId, args.profileId);
        },
        { spaceId, profileId: originalProfileId },
      );

      // Now unreferenced: the control re-enables and the bridge delete succeeds.
      await expect(settings.getByTestId(`settings-profile-delete-${profileId}`)).toBeEnabled();
      await sidebar.evaluate((id) => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.profiles.delete(id);
      }, profileId);
      await expect
        .poll(async () => (await tabsList(sidebar)).profiles.some((p) => p.id === profileId), {
          message: "expected the freed profile to be deleted from TabsState.profiles",
        })
        .toBe(false);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §8 bullet i: the history section shows retention + live stats and clears only
  // behind the two-step confirm. History is seeded via real loopback navigations
  // (polling recorded visits like the PRD 6.1 tests) so the counts are
  // deterministic offline.
  test("history section shows retention and stats and clears only after confirm", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      // Start from an empty, deterministic history, then seed exactly two visits
      // at two distinct urls (two entries, two visits).
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);

      const settings = await openSettings(app, sidebar, "settings.openHistory");

      // Retention is the fixed 90-day window from HISTORY_RETENTION_MS.
      await expect(settings.getByTestId("settings-history-retention")).toContainText("90 days");
      // Stats reflect the two seeded entries/visits (read on the section's mount,
      // so poll the rendered text).
      await expect(settings.getByTestId("settings-history-stats")).toContainText("2 entries");
      await expect(settings.getByTestId("settings-history-stats")).toContainText("2 visits");

      // A single click of Clear does NOT clear — it only reveals the confirm step.
      await settings.getByTestId("settings-history-clear").click();
      await expect(settings.getByTestId("settings-history-clear-confirm")).toHaveCount(1);
      expect(await historyStats(sidebar)).toEqual({ entries: 2, visits: 2 });

      // Confirm actually clears: stats drop to zero in both the bridge and the UI.
      await settings.getByTestId("settings-history-clear-confirm").click();
      await expect
        .poll(() => historyStats(sidebar), {
          message: "expected history.stats() to report zero after confirm",
        })
        .toEqual({ entries: 0, visits: 0 });
      await expect(settings.getByTestId("settings-history-stats")).toContainText("0 entries");
      await expect(settings.getByTestId("settings-history-stats")).toContainText("0 visits");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// --- History seeding fixtures (mirrors history.spec.ts). ------------------------

/** A running loopback fixture server plus a promisified close. */
interface HistoryFixtureServer {
  base: string;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an ephemeral port serving two titled
 * HTML pages (`/a.html` Alpha, `/b.html` Beta), all `text/html; charset=utf-8`.
 * Loopback only, so every recording is network-independent.
 */
async function startHistoryFixtureServer(): Promise<HistoryFixtureServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    const sendHtml = (markup: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(markup);
    };
    if (pathname === "/a.html") {
      sendHtml("<!doctype html><meta charset=utf-8><title>Alpha page</title><p>alpha</p>");
      return;
    }
    if (pathname === "/b.html") {
      sendHtml("<!doctype html><meta charset=utf-8><title>Beta page</title><p>beta</p>");
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
    throw new Error("history fixture server did not bind to an inet address");
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

/** `history.recent()` over the sidebar bridge. */
function recent(sidebar: Page): Promise<HistoryVisit[]> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.recent();
  });
}

/** `history.stats()` over the sidebar bridge. */
function historyStats(sidebar: Page): Promise<{ entries: number; visits: number }> {
  return sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.stats();
  });
}

/** Navigate a tab over the sidebar bridge (records synchronously in did-navigate). */
function navigate(sidebar: Page, id: string, url: string): Promise<void> {
  return sidebar.evaluate(
    (args) => {
      const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
      return zeo.tabs.navigate(args.id, args.url);
    },
    { id, url },
  );
}

/**
 * Navigate a history url and WAIT until its visit has been recorded before
 * returning. `tabs.navigate` resolves as soon as loadURL is CALLED, not when the
 * load commits, so poll `recent()` until it reaches the expected running count.
 * Mirrors history.spec.ts's navigateAndRecord.
 */
async function navigateAndRecord(
  sidebar: Page,
  id: string,
  url: string,
  expectedRecentLen: number,
): Promise<void> {
  await navigate(sidebar, id, url);
  await expect
    .poll(async () => (await recent(sidebar)).length, {
      message: `expected ${expectedRecentLen} recorded visit(s) after navigating ${url}`,
    })
    .toBe(expectedRecentLen);
}

/**
 * Return the active tab to a pristine, empty-history baseline: navigate it to
 * about:blank (a non-history url that records nothing) and clear history. Mirrors
 * history.spec.ts's freshHistory — the seeded tab points at an external url which,
 * if it ever committed under CI, would record a stray visit; navigating away
 * cancels that load and the clear removes anything that committed first, so every
 * test starts from an empty, deterministic history. Returns the active tab id.
 */
async function freshHistory(app: ElectronApplication, sidebar: Page): Promise<string> {
  const id = (await tabsList(sidebar)).activeTabId ?? (await tabsList(sidebar)).tabs[0]!.id;
  await navigate(sidebar, id, "about:blank");
  // Wait until the tab's WebContentsView has COMMITTED about:blank before clearing
  // (the app renderers are file://, so only the seeded tab is ever about:blank).
  await expect
    .poll(() => {
      for (const w of app.windows()) {
        try {
          if (w.url() === "about:blank") {
            return true;
          }
        } catch {
          // A navigating WebContentsView can momentarily lose its context.
        }
      }
      return false;
    })
    .toBe(true);
  await sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.clear();
  });
  expect(await recent(sidebar)).toEqual([]);
  return id;
}
