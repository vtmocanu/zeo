import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// command-bar.ts self-registers IPC via a top-level ipcMain.handle block, and
// (transitively, through the modules it imports for its side effects) touches
// several other Electron-backed main modules. Mock electron with just the
// surface actually invoked at load (ipcMain.handle), matching tabs.test.ts and
// spaces.test.ts.
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
}));

// Mock every collaborator module command-bar.ts imports, standing in for
// exactly the exports it uses from each — none of these need real Electron,
// database, or window/view behavior for the module-graph tests here.
const h = vi.hoisted(() => ({
  searchHistory: vi.fn(() => []),
  pushCommandBar: vi.fn(),
  layoutOverlay: vi.fn(() => true),
  createTab: vi.fn(),
  navigateTab: vi.fn(),
  restoreTab: vi.fn(),
  switchSpace: vi.fn(),
  activateTab: vi.fn(),
  doSplitWith: vi.fn(() => Promise.resolve()),
  teardownQuickBrowse: vi.fn(),
  openDownloadById: vi.fn(),
  logHistoryError: vi.fn(),
}));

vi.mock("./db.js", () => ({ searchHistory: h.searchHistory }));
vi.mock("./broadcast.js", () => ({ pushCommandBar: h.pushCommandBar }));
vi.mock("./overlay.js", () => ({ layoutOverlay: h.layoutOverlay }));
vi.mock("./tabs.js", () => ({
  createTab: h.createTab,
  navigateTab: h.navigateTab,
  restoreTab: h.restoreTab,
}));
vi.mock("./spaces.js", () => ({ switchSpace: h.switchSpace }));
vi.mock("./layout.js", () => ({ activateTab: h.activateTab, doSplitWith: h.doSplitWith }));
vi.mock("./quick-browse.js", () => ({ teardownQuickBrowse: h.teardownQuickBrowse }));
vi.mock("./downloads.js", () => ({ openDownloadById: h.openDownloadById }));
vi.mock("./history.js", () => ({ logHistoryError: h.logHistoryError }));

import { SpaceStore } from "@zeo/core";
import type { CommandContext, Tab } from "@zeo/core";
import { runtime } from "./state.js";
import {
  acceptCommandBar,
  closeCommandBar,
  openCommandBar,
  refreshCommandState,
  setQueryCommandBar,
} from "./command-bar.js";

/** A full, all-defaults CommandContext, matching commands.test.ts's helper. */
function fakeContext(): CommandContext {
  return {
    activeTab: null,
    spaceCount: 1,
    settingsOpen: false,
    quickBrowseOpen: false,
    hasFinishedDownload: false,
    find: { open: false, hasQuery: false },
    layoutMode: "single",
    openTabCount: 1,
    favoritesFull: false,
    clearableTabCount: 0,
  };
}

describe("command-bar module graph", () => {
  test("importing command-bar.ts registers closeCommandBarHook and onStateApplied", () => {
    expect(runtime.closeCommandBarHook).toBe(closeCommandBar);
    expect(runtime.onStateApplied).toBe(refreshCommandState);
  });
});

describe("command-bar background re-rank and accept remap", () => {
  let tabA: Tab;
  let tabB: Tab;

  beforeEach(() => {
    vi.clearAllMocks();
    // A deterministic clock so lastActiveAt ordering (and thus suggestion
    // order) is stable across runs, unlike the real Date.now()-backed default.
    let clock = 0;
    let seq = 0;
    runtime.store = new SpaceStore({
      idFactory: () => `id-${seq++}`,
      now: () => clock++,
    });
    tabA = runtime.store.create({ url: "https://a.test", title: "Tab A" });
    tabB = runtime.store.create({ url: "https://b.test", title: "Tab B" });
    // tabC is created last so it becomes the active tab (its own suggestion
    // is never asserted on beyond that).
    runtime.store.create({ url: "https://c.test", title: "Tab C" });
    // The most recently created tab (tabC) is active; new-tab mode's
    // empty-query list is every OTHER open tab, MRU-first: [tabB, tabA].
    runtime.commandContextOf = fakeContext;
    runtime.rebuildMenu = null;
    runtime.executeCommand = null;
    openCommandBar("new-tab");
  });

  afterEach(() => {
    closeCommandBar();
    runtime.commandContextOf = null;
  });

  test("openCommandBar ranks the initial list MRU-first, excluding the active tab", () => {
    const suggestions = runtime.commandBar.suggestions;
    expect(suggestions.map((s) => (s.kind === "tab" ? s.tabId : null))).toEqual([tabB.id, tabA.id]);
    expect(runtime.commandBar.selectedIndex).toBe(0);
  });

  test("a background refresh keeps selection on the same row by identity, bumps revision, and appends to commandBarPrevious", () => {
    // Select row 1 (tabA), matching a user having arrowed down.
    runtime.commandBar.selectedIndex = 1;
    const revisionBefore = runtime.commandBar.revision;
    const suggestionsBefore = runtime.commandBar.suggestions;

    // A background event unrelated to the bar's own query: tabA's title
    // changes (e.g. the page finished loading its <title>).
    runtime.store.updateMeta(tabA.id, { title: "Tab A (loaded)" });
    refreshCommandState();

    expect(runtime.commandBar.revision).toBeGreaterThan(revisionBefore);
    // tabA is still at index 1 (title changes don't reorder), but selection is
    // recomputed by identity, not preserved by raw index equality — confirmed
    // below by pinning the resolved suggestion's identity.
    expect(runtime.commandBar.selectedIndex).toBe(1);
    const selected = runtime.commandBar.suggestions[runtime.commandBar.selectedIndex];
    expect(selected?.kind === "tab" && selected.tabId).toBe(tabA.id);
    expect(
      runtime.commandBarPrevious.some(
        (p) => p.revision === revisionBefore && p.suggestions === suggestionsBefore,
      ),
    ).toBe(true);
  });

  test("a background refresh that reorders rows remaps selection to the row's new index", () => {
    runtime.commandBar.selectedIndex = 1; // tabA

    // tabB closes elsewhere (e.g. the user closed it from the tab strip)
    // while the bar stays open; tabA now sits at index 0.
    runtime.store.close(tabB.id);
    refreshCommandState();

    expect(runtime.commandBar.suggestions.map((s) => (s.kind === "tab" ? s.tabId : null))).toEqual([
      tabA.id,
    ]);
    expect(runtime.commandBar.selectedIndex).toBe(0);
  });

  test("setQueryCommandBar resets selectedIndex to 0 and empties commandBarPrevious", () => {
    runtime.store.close(tabB.id);
    refreshCommandState();
    expect(runtime.commandBarPrevious.length).toBeGreaterThan(0);

    setQueryCommandBar("tab");

    expect(runtime.commandBar.selectedIndex).toBe(0);
    expect(runtime.commandBarPrevious).toEqual([]);
  });

  test("openCommandBar and closeCommandBar empty commandBarPrevious", () => {
    runtime.store.close(tabB.id);
    refreshCommandState();
    expect(runtime.commandBarPrevious.length).toBeGreaterThan(0);

    closeCommandBar();
    expect(runtime.commandBarPrevious).toEqual([]);

    openCommandBar("new-tab");
    expect(runtime.commandBarPrevious).toEqual([]);
  });

  test("accept(index, oldRevision) after a background re-rank remaps to the row's new index", () => {
    runtime.commandBar.selectedIndex = 1; // tabA, at index 1 in [tabB, tabA]
    const oldRevision = runtime.commandBar.revision;

    runtime.store.close(tabB.id); // tabA moves to index 0
    refreshCommandState();

    // A click rendered against the OLD list at index 1 (tabA) is remapped to
    // tabA's current index (0) and performs its action (activateTab), not
    // whatever now sits at raw index 1 (out of range in the new 1-row list).
    acceptCommandBar(1, oldRevision);

    expect(h.activateTab).toHaveBeenCalledWith(tabA.id);
  });

  test("accept(index, revision) after a typed query throws revision stale", () => {
    const oldRevision = runtime.commandBar.revision;
    setQueryCommandBar("something else entirely");

    expect(() => acceptCommandBar(0, oldRevision)).toThrow(/accept revision stale/);
    expect(h.activateTab).not.toHaveBeenCalled();
  });

  test("accept throws index out of range for an out-of-range index against the CURRENT revision", () => {
    const currentRevision = runtime.commandBar.revision;

    expect(() => acceptCommandBar(99, currentRevision)).toThrow(/accept index out of range: 99/);
  });

  test("accept throws index out of range for an out-of-range index against a saved PREVIOUS revision", () => {
    const oldRevision = runtime.commandBar.revision; // list had 2 rows: [tabB, tabA]

    runtime.store.close(tabB.id);
    refreshCommandState();

    // Index 5 was never valid even in the old 2-row list.
    expect(() => acceptCommandBar(5, oldRevision)).toThrow(/accept index out of range: 5/);
  });

  test("accept throws row gone when the rendered row has left the current list entirely", () => {
    const oldRevision = runtime.commandBar.revision; // list had 2 rows: [tabB, tabA]

    runtime.store.close(tabB.id); // tabB is gone, not just reordered
    refreshCommandState();

    // Index 0 in the OLD list named tabB, which no longer exists anywhere in
    // the current suggestions — resolveAcceptIndex returns null, but (unlike
    // the out-of-range cases) the index itself was valid for the list it was
    // rendered against.
    expect(() => acceptCommandBar(0, oldRevision)).toThrow(/accept row gone: 0/);
    expect(h.activateTab).not.toHaveBeenCalled();
  });
});
