import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// PRD 9.1 — shared view-URL poll helper (VIEW_POLL_TIMEOUT_MS-bounded).
import { waitForViewUrl, waitForViewsIdle } from "./helpers/view";
// PRD 10.6 — the sheet geometry and the token probe the sheet cases compare
// against, so the spec follows @zeo/core and tokens.css if a value moves.
import { settingsBounds, settingsSheetRect } from "@zeo/core";
import type { Rect } from "@zeo/core";
import { tokenBackground } from "./helpers/token";

// Absolute path to the built Electron main entry, resolved from this test file
// (e2e is ESM, so no __dirname). Layout mirrors blocking.spec.ts / history.spec.ts:
// e2e/tests -> repo root is two levels up, then the desktop app's build output.
const mainPath = fileURLToPath(new URL("../../apps/desktop/out/main/index.js", import.meta.url));

// --- Minimal typed view of the preload-injected `window.zeo` bridge. ------------
// The bridge types are not imported from @zeo/core (only its geometry is); we
// redeclare the slice these settings tests touch (structurally @zeo/core's ZeoApi).
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
    activate(id: string): Promise<void>;
    list(): Promise<BridgeState>;
  };
  // PRD 10.6 — the find slice the settings/find exclusion case drives.
  find: {
    open(): Promise<void>;
    state(): Promise<{ open: boolean }>;
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
  // §8 bullet a: the settings view lists the five sections in registry order.
  test("lists the five sections in registry order", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      const rows = settings.locator('.settings__sections [data-testid^="settings-section-"]');
      await expect(rows).toHaveCount(5);
      const ids = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")),
      );
      expect(ids).toEqual([
        "settings-section-general",
        "settings-section-blocking",
        "settings-section-profiles",
        "settings-section-history",
        "settings-section-about",
      ]);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // §7/§8: the About section shows the product name and a non-empty running
  // version, read straight off the broadcast TabsState.appVersion (set once at
  // launch from app.getVersion()). The unpackaged e2e build reports the desktop
  // package's placeholder version, so this asserts shape, not a specific number.
  test("shows the About section with a non-empty version", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      await settings.getByTestId("settings-section-about").click();
      await expect(settings.locator(SELECTED("about"))).toHaveCount(1);
      const version = settings.getByTestId("settings-about-version");
      await expect(version).toBeVisible();
      expect(await version.textContent()).toMatch(/\S/);
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
      // The clicked section button holds DOM focus — the precondition this test
      // exercises (Enter arriving while a section button is focused). Asserting it
      // keeps the test from silently decaying into a pass on unfixed code if focus
      // behavior ever changed.
      await expect(settings.getByTestId("settings-section-blocking")).toBeFocused();

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
      await expect(settings.getByTestId("settings-history-stats")).toHaveText(
        historyStatsLabel(2, 2),
      );

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
      await expect(settings.getByTestId("settings-history-stats")).toHaveText(
        historyStatsLabel(0, 0),
      );
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // The settings renderer stays mounted across a close (main only detaches the
  // native view), so an open confirm dialog and its stats must not survive a
  // close/reopen: closing must reset the dialog, and reopening must re-read
  // stats rather than show whatever was current when it closed.
  test("closing settings resets an open clear dialog; reopening re-reads stats and refocuses Cancel", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);

      let settings = await openSettings(app, sidebar, "settings.openHistory");
      await expect(settings.getByTestId("settings-history-stats")).toHaveText(
        historyStatsLabel(1, 1),
      );
      await settings.getByTestId("settings-history-clear").click();
      const dialog = settings.getByTestId("settings-history-clear-dialog");
      await expect(dialog).toBeVisible();

      // Close settings (via the settings.close command) while the dialog is open.
      await runCommand(sidebar, "settings.close");
      await expect
        .poll(() => settingsOpen(sidebar), { message: "expected settings.close to close settings" })
        .toBe(false);

      // Seed another visit while settings is closed: a stale reopen would still
      // show "1 entries".
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);

      settings = await openSettings(app, sidebar, "settings.openHistory");
      // The dialog is not already open on reopen.
      await expect(settings.getByTestId("settings-history-clear-dialog")).toHaveCount(0);
      await expect(settings.getByTestId("settings-history-stats")).toHaveText(
        historyStatsLabel(2, 2),
      );

      await settings.getByTestId("settings-history-clear").click();
      const reopenedDialog = settings.getByTestId("settings-history-clear-dialog");
      await expect(reopenedDialog).toBeVisible();
      const cancel = settings.getByTestId("settings-history-clear-cancel");
      await expect(cancel).toBeFocused();
      const focusedTestId = await settings.evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
      );
      expect(focusedTestId).toBe("settings-history-clear-cancel");
      await expect(reopenedDialog).toContainText("This removes 2 entries and 2 visits.");
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // A rejected history.stats() must not disable the clear trigger forever, and
  // a rejected history.clear() must keep the dialog open with an inline error
  // instead of silently doing nothing — and a same-tick double confirm must
  // fire history.clear() only once.
  test("a failed stats read still enables the trigger; a failed clear keeps the dialog open with an inline error", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("zeo:history:stats");
        ipcMain.handle("zeo:history:stats", () => {
          throw new Error("boom");
        });
      });

      const settings = await openSettings(app, sidebar, "settings.openHistory");
      const trigger = settings.getByTestId("settings-history-clear");
      await expect(trigger).toBeEnabled();
      await expect(settings.getByTestId("settings-history-stats")).toContainText("unavailable");

      await trigger.click();
      const dialog = settings.getByTestId("settings-history-clear-dialog");
      await expect(dialog).toBeVisible();
      // Count-free wording: no counts are known.
      await expect(dialog).toContainText("This removes all browsing history.");
      await expect(dialog).not.toContainText("entries");

      // Replace the clear handler with one that counts invocations and rejects
      // only once the test releases it (via __zeoReleaseHistoryClear), so the
      // disabled-Confirm assertion below has no timing dependence on a fixed
      // delay racing the test.
      await app.evaluate(({ ipcMain }) => {
        const g = globalThis as unknown as {
          __zeoHistoryClearCalls: number;
          __zeoReleaseHistoryClear?: () => void;
        };
        g.__zeoHistoryClearCalls = 0;
        ipcMain.removeHandler("zeo:history:clear");
        ipcMain.handle("zeo:history:clear", () => {
          g.__zeoHistoryClearCalls += 1;
          return new Promise((_resolve, reject) => {
            g.__zeoReleaseHistoryClear = () => reject(new Error("clear failed"));
          });
        });
      });

      const confirm = settings.getByTestId("settings-history-clear-confirm");
      await confirm.dblclick();
      await expect(confirm).toBeDisabled();
      expect(
        await app.evaluate(
          () => (globalThis as unknown as { __zeoHistoryClearCalls: number }).__zeoHistoryClearCalls,
        ),
      ).toBe(1);

      // Release the pending clear so it rejects.
      await app.evaluate(() => {
        (globalThis as unknown as { __zeoReleaseHistoryClear?: () => void }).__zeoReleaseHistoryClear?.();
      });

      const error = settings.getByTestId("settings-history-clear-dialog-error");
      await expect(error).toBeVisible();
      await expect(error).toHaveAttribute("role", "alert");
      await expect(dialog).toBeVisible();
      await expect(confirm).toBeEnabled();
      // ConfirmDialog's `useEffect([error])` refocuses Cancel once the inline
      // error appears, so focus returns into the dialog instead of staying
      // wherever the disabled Confirm left it.
      await expect(settings.getByTestId("settings-history-clear-cancel")).toBeFocused();
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // A clear started in one settings session must not touch a later session:
  // `sessionRef` in HistorySection is bumped on every open/close transition,
  // and `onConfirmClear`'s continuations compare against it before touching
  // state. Here the clear is still in flight when settings is closed and
  // reopened, and the reopened session opens its own dialog; once the stale
  // promise is released (and rejects), that dialog must be untouched (no
  // error, Confirm enabled) rather than inheriting the stale failure.
  test("a stale clear from a superseded session leaves the reopened dialog untouched", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);

      // A rejecting `zeo:history:clear` handler gated behind
      // `__zeoReleaseHistoryClear`, same pattern as the failed-clear test
      // above, plus a `__zeoHistoryClearReleased` flag the test can poll to
      // know the rejection has actually been delivered to main before it
      // asserts anything about the (ignored) renderer-side settle.
      await app.evaluate(({ ipcMain }) => {
        const g = globalThis as unknown as {
          __zeoHistoryClearReleased: boolean;
          __zeoReleaseHistoryClear?: () => void;
        };
        g.__zeoHistoryClearReleased = false;
        ipcMain.removeHandler("zeo:history:clear");
        ipcMain.handle("zeo:history:clear", () => {
          return new Promise((_resolve, reject) => {
            g.__zeoReleaseHistoryClear = () => {
              g.__zeoHistoryClearReleased = true;
              reject(new Error("stale clear"));
            };
          });
        });
      });

      let settings = await openSettings(app, sidebar, "settings.openHistory");
      await settings.getByTestId("settings-history-clear").click();
      await expect(settings.getByTestId("settings-history-clear-dialog")).toBeVisible();
      await settings.getByTestId("settings-history-clear-confirm").click();
      // The clear is now in flight (Confirm disabled) when settings closes.
      await expect(settings.getByTestId("settings-history-clear-confirm")).toBeDisabled();

      // Close settings the same way the close/reopen test does, while the
      // clear from this (now superseded) session is still pending.
      await runCommand(sidebar, "settings.close");
      await expect
        .poll(() => settingsOpen(sidebar), { message: "expected settings.close to close settings" })
        .toBe(false);

      settings = await openSettings(app, sidebar, "settings.openHistory");
      // The dialog is not already open on reopen (a fresh session).
      await expect(settings.getByTestId("settings-history-clear-dialog")).toHaveCount(0);

      // Open the dialog in the new session BEFORE the stale clear settles, so
      // an unguarded settle would land in live, rendered state: its error would
      // show in this dialog.
      await settings.getByTestId("settings-history-clear").click();
      const reopenedDialog = settings.getByTestId("settings-history-clear-dialog");
      await expect(reopenedDialog).toBeVisible();

      // Release the stale clear now that a newer session is live, and wait for
      // main to have rejected it.
      await app.evaluate(() => {
        (globalThis as unknown as { __zeoReleaseHistoryClear?: () => void }).__zeoReleaseHistoryClear?.();
      });
      await expect
        .poll(
          () =>
            app.evaluate(
              () =>
                (globalThis as unknown as { __zeoHistoryClearReleased: boolean })
                  .__zeoHistoryClearReleased,
            ),
          { message: "expected the stale clear handler to have rejected" },
        )
        .toBe(true);
      // Barrier: IPC replies reach the renderer in order, so once a later
      // `history.stats()` round-trip resolves, the stale rejection's
      // continuation has already run.
      await settings.evaluate(async () => {
        await (
          window as unknown as { zeo: { history: { stats(): Promise<unknown> } } }
        ).zeo.history.stats();
      });

      // The stale settle never touched this session: the open dialog shows no
      // error and its Confirm stays enabled.
      await expect(reopenedDialog).toBeVisible();
      await expect(settings.getByTestId("settings-history-clear-dialog-error")).toHaveCount(0);
      await expect(settings.getByTestId("settings-history-clear-confirm")).toBeEnabled();
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

/**
 * The exact "loaded" rendering of the settings history stats row, mirroring
 * `historyStatsText`'s `"loaded"` branch (apps/ui/src/history-clear.ts), so
 * tests can assert the full text rather than a substring.
 */
function historyStatsLabel(entries: number, visits: number): string {
  return `${entries} entries · ${visits} visits`;
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
  // waitForViewUrl polls the main process, bounded by VIEW_POLL_TIMEOUT_MS.
  await waitForViewUrl(app, "about:blank");
  await sidebar.evaluate(() => {
    const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
    return zeo.history.clear();
  });
  expect(await recent(sidebar)).toEqual([]);
  return id;
}

// --- PRD 10.6 settings sheet ---------------------------------------------------

/** The main window's content size, as main reads it for `settingsBounds`. */
function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0].getContentSize();
    return { width, height };
  });
}

/** Resize the main window's content area (main relays out every view on resize). */
function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

/**
 * The settings child view's native bounds, read in main among the window's
 * child views by its `view=settings` url. `null` when it is not attached (the
 * view is removed from the window on close).
 */
function settingsViewBounds(app: ElectronApplication): Promise<Rect | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (const child of win.contentView.children) {
      const wc = (child as { webContents?: { getURL(): string } }).webContents;
      if (wc != null && wc.getURL().includes("view=settings")) {
        const b = child.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
    return null;
  });
}

/** The sheet's client rect plus the viewport it was laid out in. */
function sheetGeometry(
  settings: Page,
): Promise<{ rect: Rect; innerWidth: number; innerHeight: number }> {
  return settings.getByTestId("settings").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
}

/**
 * Wait out a close that must NOT happen. A close is an async bridge round trip
 * from the settings view, so an immediate read cannot tell "did not close"
 * from "has not closed yet"; this holds `settingsOpen === true` over a window
 * well past that round trip.
 */
async function expectStaysOpen(sidebar: Page, why: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(await settingsOpen(sidebar), why).toBe(true);
}

test.describe("PRD 10.6 settings sheet", () => {
  test("the settings view covers the whole window before and after a resize", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      await openSettings(app, sidebar, "settings.open");
      const coversWindow = async (): Promise<unknown> => {
        const [bounds, size] = await Promise.all([settingsViewBounds(app), contentSize(app)]);
        const want = { x: 0, y: 0, width: size.width, height: size.height };
        // settingsBounds is the formula main applies; it must be the full window.
        expect(settingsBounds(size.width, size.height)).toEqual(want);
        return JSON.stringify(bounds) === JSON.stringify(want) ? "ok" : { bounds, want };
      };
      await expect.poll(coversWindow).toBe("ok");
      const before = await contentSize(app);

      await setContentSize(app, 900, 520);
      await expect.poll(() => contentSize(app)).toEqual({ width: 900, height: 520 });
      // The size really changed, so the second check is not the first one again.
      expect(before).not.toEqual({ width: 900, height: 520 });
      await expect.poll(coversWindow).toBe("ok");
      expect(await settingsViewBounds(app)).toEqual({ x: 0, y: 0, width: 900, height: 520 });
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("the sheet sits at settingsSheetRect at 1280×800, 900×520 and 640×400", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      const measured: string[] = [];
      for (const [w, h] of [
        [1280, 800],
        [900, 520],
        [640, 400],
      ]) {
        await setContentSize(app, w, h);
        // The renderer re-lays the sheet on `resize`; wait until its viewport is
        // the new content size, then compare against the formula for THAT size.
        await expect
          .poll(
            async () => {
              const size = await contentSize(app);
              const g = await sheetGeometry(settings);
              const want = settingsSheetRect(g.innerWidth, g.innerHeight);
              return g.innerWidth === size.width &&
                g.innerHeight === size.height &&
                JSON.stringify(g.rect) === JSON.stringify(want)
                ? "ok"
                : { size, geometry: g, want };
            },
            { message: `sheet rect at ${w}×${h}` },
          )
          .toBe("ok");
        const g = await sheetGeometry(settings);
        measured.push(`${w}×${h}->${g.innerWidth}×${g.innerHeight}`);
        // The sheet always fits with its margin, down to the minimum window.
        expect(g.rect.width).toBeGreaterThan(0);
        expect(g.rect.x).toBeGreaterThanOrEqual(0);
        expect(g.rect.y).toBeGreaterThanOrEqual(0);
      }
      test.info().annotations.push({ type: "viewport-sizes", description: measured.join(", ") });
      // Three distinct viewports, or the loop checked one geometry three times.
      const sizes = measured.map((m) => m.split("->")[1]);
      expect(new Set(sizes).size, `measured viewports: ${measured.join(", ")}`).toBe(3);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("the page is transparent and the scrim paints --scrim", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      const look = await settings.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
      }));
      expect(look).toEqual({ html: "rgba(0, 0, 0, 0)", body: "rgba(0, 0, 0, 0)" });

      const scrim = await tokenBackground(settings, "--scrim");
      expect(scrim).not.toBe("rgba(0, 0, 0, 0)");
      await expect(settings.getByTestId("settings-scrim")).toHaveCSS("background-color", scrim);
      // The scrim fills the viewport.
      const box = await settings.getByTestId("settings-scrim").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, w: innerWidth, h: innerHeight };
      });
      expect(box).toEqual({ x: 0, y: 0, width: box.w, height: box.h, w: box.w, h: box.h });
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("a scrim click and the close button close the sheet; clicks inside it do not", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      let settings = await openSettings(app, sidebar, "settings.open");
      const corner = await settings.evaluate(() => ({ x: 4, y: window.innerHeight - 4 }));

      // The bottom-left corner is scrim (the sheet has a 24 px margin at least),
      // over where the sidebar sits: the click closes the sheet.
      const hit = await settings.evaluate(
        (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("data-testid") ?? null,
        corner,
      );
      expect(hit).toBe("settings-scrim");
      await settings.mouse.click(corner.x, corner.y);
      await expect
        .poll(() => settingsOpen(sidebar), { message: "expected a scrim click to close settings" })
        .toBe(false);

      // A click inside the sheet (its panel title) does not close it.
      settings = await openSettings(app, sidebar, "settings.open");
      await settings.locator(".settings__panel-title").click();
      await expectStaysOpen(sidebar, "a click inside the sheet must not close it");

      // A press that starts inside the sheet and is released over the scrim (a
      // text selection dragged out) does not close it either: the click lands on
      // the scrim, but the press did not.
      const title = await settings.locator(".settings__panel-title").boundingBox();
      if (title === null) {
        throw new Error("panel title has no box");
      }
      await settings.mouse.move(title.x + 4, title.y + title.height / 2);
      await settings.mouse.down();
      await settings.mouse.move(corner.x, corner.y, { steps: 6 });
      await settings.mouse.up();
      await expectStaysOpen(
        sidebar,
        "a press inside the sheet released on the scrim must not close it",
      );

      // The close button closes it.
      await expect(settings.getByTestId("settings-close")).toHaveAccessibleName("Close settings");
      await settings.getByTestId("settings-close").click();
      await expect
        .poll(() => settingsOpen(sidebar), { message: "expected settings-close to close settings" })
        .toBe(false);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("the selected section row paints --accent-soft and the sheet is a labelled dialog", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.open");
      const sheet = settings.getByTestId("settings");
      await expect(sheet).toHaveAttribute("role", "dialog");
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      await expect(sheet).toHaveAccessibleName("Settings");
      await expect(settings.getByTestId("settings-section-blocking")).toHaveText(
        "Content blocking",
      );

      const accentSoft = await tokenBackground(settings, "--accent-soft");
      await expect(settings.locator(SELECTED("general"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-section-general")).toHaveCSS(
        "background-color",
        accentSoft,
      );
      // An unselected row does not (the probe discriminates).
      await expect(settings.getByTestId("settings-section-about")).not.toHaveCSS(
        "background-color",
        accentSoft,
      );

      // The fill follows the selection, and holds while the pointer is still
      // over the clicked row (the selected fill outranks :hover).
      const about = settings.getByTestId("settings-section-about");
      await about.click();
      await expect(settings.locator(SELECTED("about"))).toHaveCount(1);
      expect(
        await about.evaluate((el) => el.matches(":hover")),
        "the pointer is still over the clicked row",
      ).toBe(true);
      await expect(about).toHaveCSS("background-color", accentSoft);
      // Control: hovering an unselected row does paint the hover fill, so the
      // :hover rule is live in this page and the check above discriminates.
      const hover = await tokenBackground(settings, "--popover-hover");
      expect(hover).not.toBe(accentSoft);
      const general = settings.getByTestId("settings-section-general");
      await general.hover();
      await expect(general).toHaveCSS("background-color", hover);

      // Resting (pointer off the nav): the selected row keeps the fill.
      const panel = await settings.locator(".settings__panel-title").boundingBox();
      if (panel === null) {
        throw new Error("panel title has no box");
      }
      await settings.mouse.move(panel.x + 4, panel.y + panel.height / 2);
      await expect(settings.getByTestId("settings-section-about")).toHaveCSS(
        "background-color",
        accentSoft,
      );
      await expect(settings.getByTestId("settings-section-general")).not.toHaveCSS(
        "background-color",
        accentSoft,
      );
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("every General well holds rows, and a well's second row has a 1 px top border", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    try {
      const settings = await openSettings(app, sidebar, "settings.openGeneral");
      await expect(settings.locator(SELECTED("general"))).toHaveCount(1);
      await expect(settings.getByTestId("settings-search-engine-google")).toHaveCount(1);

      const wells = await settings.locator(".settings__panel .settings__well").evaluateAll((els) =>
        els.map((well) => {
          const rows = Array.from(well.children).filter((c) =>
            c.classList.contains("settings__row"),
          );
          const border = (el: Element | undefined): string =>
            el === undefined
              ? ""
              : `${getComputedStyle(el).borderTopWidth} ${getComputedStyle(el).borderTopStyle}`;
          return { rows: rows.length, first: border(rows[0]), second: border(rows[1]) };
        }),
      );
      expect(wells.length, "General renders at least one well").toBeGreaterThan(0);
      for (const [i, well] of wells.entries()) {
        expect(well.rows, `well ${i} holds a row`).toBeGreaterThanOrEqual(1);
        // The first row has no separator; only a row after a row does.
        expect(well.first, `well ${i} first row`).toBe("0px none");
        if (well.rows >= 2) {
          expect(well.second, `well ${i} second row`).toBe("1px solid");
        }
      }
      // At least one multi-row well, or the separator check never ran.
      expect(
        wells.some((w) => w.rows >= 2),
        JSON.stringify(wells),
      ).toBe(true);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("history clear goes through an alertdialog: Escape and Cancel keep history, confirm clears", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const server = await startHistoryFixtureServer();
    const { app, sidebar } = await launch(userDataDir);
    try {
      const tabId = await freshHistory(app, sidebar);
      await navigateAndRecord(sidebar, tabId, `${server.base}/a.html`, 1);
      await navigateAndRecord(sidebar, tabId, `${server.base}/b.html`, 2);
      await waitForViewsIdle(app);

      const settings = await openSettings(app, sidebar, "settings.openHistory");
      const stats = settings.getByTestId("settings-history-stats");
      await expect(stats).toContainText("2 entries");
      await expect(stats).toContainText("2 visits");
      const trigger = settings.getByTestId("settings-history-clear");
      const dialog = settings.getByTestId("settings-history-clear-dialog");
      const cancel = settings.getByTestId("settings-history-clear-cancel");
      const confirm = settings.getByTestId("settings-history-clear-confirm");
      // The trigger is gated on loaded stats; once they show, it is enabled.
      await expect(trigger).toBeEnabled();

      // --- Escape: the dialog closes, the sheet stays, history is intact. ---
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("role", "alertdialog");
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(dialog).toContainText("This removes 2 entries and 2 visits.");
      await expect(cancel).toBeFocused();
      // Tab and Shift+Tab cycle between the two buttons.
      await settings.keyboard.press("Tab");
      await expect(confirm).toBeFocused();
      await settings.keyboard.press("Tab");
      await expect(cancel).toBeFocused();
      await settings.keyboard.press("Shift+Tab");
      await expect(confirm).toBeFocused();
      await settings.keyboard.press("Shift+Tab");
      await expect(cancel).toBeFocused();

      await settings.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expectStaysOpen(sidebar, "Escape in the dialog must not close the settings sheet");
      expect(await historyStats(sidebar)).toEqual({ entries: 2, visits: 2 });
      await expect(stats).toContainText("2 entries");

      // --- Cancel: same, and focus returns to the trigger. ---
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await settingsOpen(sidebar)).toBe(true);
      expect(await historyStats(sidebar)).toEqual({ entries: 2, visits: 2 });
      await expect(stats).toContainText("2 entries");

      // --- Section nav is inert while the dialog is open, even with focus on
      // <body> (outside the dialog): ArrowDown + Enter must not switch the
      // section, which would unmount the History section and its dialog. ---
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(settings.locator(SELECTED("history"))).toHaveCount(1);
      const focusedTag = await settings.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return document.activeElement?.tagName ?? null;
      });
      // The keys really land on <body>, not inside the dialog.
      expect(focusedTag).toBe("BODY");
      await settings.keyboard.press("ArrowDown");
      await settings.keyboard.press("Enter");
      // The count already holds before the keys, so let React commit any
      // re-render they caused (two frames) before reading it.
      await settings.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(dialog).toHaveCount(1);
      await expect(settings.locator(SELECTED("history"))).toHaveCount(1);
      await expect(settings.locator(HIGHLIGHT("history"))).toHaveCount(1);
      await expect(stats).toContainText("2 entries");
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      expect(await historyStats(sidebar)).toEqual({ entries: 2, visits: 2 });

      // --- Confirm: clears. ---
      await trigger.click();
      await expect(dialog).toBeVisible();
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(stats).toContainText("0 entries");
      await expect(stats).toContainText("0 visits");
      expect(await historyStats(sidebar)).toEqual({ entries: 0, visits: 0 });
      expect(await settingsOpen(sidebar)).toBe(true);
    } finally {
      await app.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("opening settings closes an open find session, and find stays closed while settings is open", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "zeo-settings-"));
    const { app, sidebar } = await launch(userDataDir);
    const findOpen = (): Promise<boolean> =>
      sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return (await zeo.find.state()).open;
      });
    try {
      await sidebar.evaluate(async () => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        const tab = await zeo.tabs.create("data:text/html,ZEOSETTINGS_FIND");
        await zeo.tabs.activate(tab.id);
      });
      await waitForViewUrl(app, "ZEOSETTINGS_FIND");
      await waitForViewsIdle(app);

      await sidebar.evaluate(() => {
        const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
        return zeo.find.open();
      });
      await expect.poll(findOpen, { message: "expected find to open" }).toBe(true);

      await openSettings(app, sidebar, "settings.open");
      await expect
        .poll(findOpen, { message: "expected settings.open to close the find session" })
        .toBe(false);

      // While settings is open, neither the command nor the bridge reopens find.
      await runCommand(sidebar, "find.open").catch(() => undefined);
      await sidebar
        .evaluate(() => {
          const zeo = (globalThis as unknown as { zeo: ZeoBridge }).zeo;
          return zeo.find.open();
        })
        .catch(() => undefined);
      // openFindSession is synchronous in main, so the state is final here.
      expect(await findOpen()).toBe(false);
      expect(await settingsOpen(sidebar)).toBe(true);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
