import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted spies for clearTodayTabs's per-tab teardown: the vi.mock factories
// below wrap the REAL unloadView/preserveSurvivingPane/broadcast (so every
// other test in this file keeps their true behavior) while also recording
// calls, so clearTodayTabs's contract (unloadView + preserveSurvivingPane
// per archived id, one broadcast, none when nothing archived) is observable.
const h = vi.hoisted(() => ({
  unloadView: vi.fn<(id: string) => void>(),
  preserveSurvivingPane: vi.fn<(closedId: string) => void>(),
  broadcast: vi.fn<(opts?: { persist?: boolean }) => void>(),
}));

vi.mock("./views.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./views.js")>();
  h.unloadView.mockImplementation(actual.unloadView);
  return { ...actual, unloadView: h.unloadView };
});

vi.mock("./layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout.js")>();
  h.preserveSurvivingPane.mockImplementation(actual.preserveSurvivingPane);
  return { ...actual, preserveSurvivingPane: h.preserveSurvivingPane };
});

vi.mock("./broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./broadcast.js")>();
  h.broadcast.mockImplementation(actual.broadcast);
  return { ...actual, broadcast: h.broadcast };
});

// tabs.ts imports electron at runtime (`ipcMain`, `Menu`, `clipboard`) and, like
// its transitive imports (views/layout/history/zoom), self-registers IPC via a
// top-level `ipcMain.handle(...)` block at module load. Mock electron the same
// way db.test.ts does so the import resolves with no real Electron: the only
// electron API actually invoked at load is `ipcMain.handle`; the rest just need
// to exist as named bindings the modules import (used only inside functions).
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
    setApplicationMenu: () => {},
  },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => {} },
  session: { fromPartition: () => ({}), defaultSession: {} },
  app: { getPath: () => "" },
  BrowserWindow: class {},
  WebContentsView: class {},
  nativeTheme: {},
}));

import type { WebContentsView } from "electron";
import { SpaceStore, initialBlockingState } from "@zeo/core";
import type { Space, Tab } from "@zeo/core";
import { runtime } from "./state.js";
import { forgetTab, openPopupAsTab, clearTodayTabs, showTabContextMenu } from "./tabs.js";

describe("forgetTab", () => {
  const tabId = "tab-1";
  const otherId = "tab-2";

  beforeEach(() => {
    // Reset the shared runtime to a clean, Electron-free baseline: a hand-built
    // store, empty per-tab collections, and default blocking state.
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
    runtime.tabOrigin.clear();
    runtime.lastHistoryKey.clear();
    runtime.lastVisitId.clear();
    runtime.hasRealTitle.clear();
    runtime.blocking = initialBlockingState(true, "none");
  });

  test("clears every per-tab map entry and the blocked count, leaving views untouched", () => {
    // Seed the four per-tab collections and a blocked count for the target id,
    // plus a sibling id whose state must survive the forget.
    runtime.tabOrigin.set(tabId, "https://a.test");
    runtime.tabOrigin.set(otherId, "https://b.test");
    runtime.lastHistoryKey.set(tabId, "key-1");
    runtime.lastHistoryKey.set(otherId, "key-2");
    runtime.lastVisitId.set(tabId, 11);
    runtime.lastVisitId.set(otherId, 22);
    runtime.hasRealTitle.add(tabId);
    runtime.hasRealTitle.add(otherId);
    runtime.blocking = {
      ...runtime.blocking,
      blockedByTab: { [tabId]: 3, [otherId]: 1 },
    };
    // A live view entry for the target id: forgetTab must NOT touch runtime.views
    // (each caller owns its own destroyView). The map now stores the bare view.
    const trackedView = {} as WebContentsView;
    runtime.views.set(tabId, trackedView);

    forgetTab(tabId);

    // The target id is gone from every per-tab map and from the blocked counts.
    expect(runtime.tabOrigin.has(tabId)).toBe(false);
    expect(runtime.lastHistoryKey.has(tabId)).toBe(false);
    expect(runtime.lastVisitId.has(tabId)).toBe(false);
    expect(runtime.hasRealTitle.has(tabId)).toBe(false);
    expect(tabId in runtime.blocking.blockedByTab).toBe(false);

    // The sibling id's state is untouched (forgetTab drops exactly one id).
    expect(runtime.tabOrigin.get(otherId)).toBe("https://b.test");
    expect(runtime.lastHistoryKey.get(otherId)).toBe("key-2");
    expect(runtime.lastVisitId.get(otherId)).toBe(22);
    expect(runtime.hasRealTitle.has(otherId)).toBe(true);
    expect(runtime.blocking.blockedByTab[otherId]).toBe(1);

    // views is left entirely alone (forgetTab does NOT destroy the view).
    expect(runtime.views.get(tabId)).toBe(trackedView);
    expect(runtime.views.size).toBe(1);
  });
});

describe("openPopupAsTab", () => {
  // The seeded "Personal" space stays ACTIVE throughout; `other` is a second,
  // INACTIVE space. Each space owns one tab so we can prove a popup lands in the
  // OWNER's space and nowhere else. Only the inactive-owner branch is exercised
  // here: the active-owner branch materializes a real WebContentsView (mocked as
  // an empty class), so it is left to m4 e2e.
  let activeSpaceId: string;
  let activeOwner: Tab;
  let other: Space;
  let inactiveOwner: Tab;

  beforeEach(() => {
    // broadcast() (fired by the inactive-space branch) schedules a debounced
    // store save via a real setTimeout; fake timers keep that timer from
    // outliving the test. We never advance/run them (do NOT persist), and clear
    // + restore in afterEach so no handle leaks into the next test.
    vi.useFakeTimers();

    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();

    activeSpaceId = runtime.store.activeSpaceId;
    activeOwner = runtime.store.create({ url: "https://active-owner.test", title: "a" });
    other = runtime.store.createSpace("Other");
    inactiveOwner = runtime.store.createInSpace(other.id, { url: "https://inactive-owner.test" });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("a null/unknown owner is a no-op — no tab, no view, anywhere", () => {
    openPopupAsTab("no-such-tab", "https://evil.test");

    // The active space is untouched, the owner space is untouched, and no view
    // was materialized.
    expect(runtime.store.list().map((t) => t.id)).toEqual([activeOwner.id]);
    expect(runtime.store.tabsOfSpace(other.id).map((t) => t.id)).toEqual([inactiveOwner.id]);
    expect(runtime.views.size).toBe(0);
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "blob:https://x.test/abc",
    "chrome://settings",
    "not a url",
    "",
  ])("drops non-http(s)/unparseable url %j into an inactive space", (url) => {
    // Owner is the INACTIVE space, so the view branch is never touched: a drop
    // must add NO tab and create no view. Asserting the exact tab list (not just
    // "no view") is what makes this gate the protocol check — remove it and the
    // tab count would grow.
    openPopupAsTab(inactiveOwner.id, url);

    expect(runtime.store.tabsOfSpace(other.id).map((t) => t.id)).toEqual([inactiveOwner.id]);
    expect(runtime.views.size).toBe(0);
  });

  test("a valid https popup lands in the OWNER (inactive) space, no view, active space untouched", () => {
    openPopupAsTab(inactiveOwner.id, "https://popup.test/child");

    const ownerTabs = runtime.store.tabsOfSpace(other.id);
    const created = ownerTabs.find((t) => t.url === "https://popup.test/child");
    // The new tab exists in the owner space, alongside the original owner tab.
    expect(created).toBeDefined();
    expect(ownerTabs.map((t) => t.id)).toEqual([inactiveOwner.id, created!.id]);
    // It is the owner space's own active tab (createInSpace activates it).
    expect(runtime.store.activeTabIdOf(other.id)).toBe(created!.id);

    // The ACTIVE space is entirely unchanged: same active space id, same tab list.
    expect(runtime.store.activeSpaceId).toBe(activeSpaceId);
    expect(runtime.store.list().map((t) => t.id)).toEqual([activeOwner.id]);

    // No view materialized for an inactive-space popup (lazy: it appears on the
    // next space switch).
    expect(runtime.views.size).toBe(0);
  });

  test("an http popup into an inactive space is accepted the same way", () => {
    openPopupAsTab(inactiveOwner.id, "http://plain.test/");

    const ownerTabs = runtime.store.tabsOfSpace(other.id);
    const created = ownerTabs.find((t) => t.url === "http://plain.test/");
    expect(created).toBeDefined();
    expect(ownerTabs.map((t) => t.id)).toEqual([inactiveOwner.id, created!.id]);
    expect(runtime.views.size).toBe(0);
  });
});

describe("clearTodayTabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
    h.unloadView.mockClear();
    h.preserveSurvivingPane.mockClear();
    h.broadcast.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("archives only the pinned/favorite-excluded today tabs, in list() order, leaving pinned and favorite tabs open", () => {
    const store = runtime.store;
    const pinned = store.create({ url: "https://p.test", title: "P" });
    store.pin(pinned.id);
    const a = store.create({ url: "https://a.test", title: "A" });
    const b = store.create({ url: "https://b.test", title: "B" });
    const favoriteTab = store.create({ url: "https://f.test", title: "F" });
    store.addFavorite(favoriteTab.id);

    clearTodayTabs();

    const openIds = store.list().map((t) => t.id);
    expect(openIds).toEqual([pinned.id, favoriteTab.id]);
    // archived() is newest-first; both share one archiveToday stamp, so ties
    // break by descending archivalSeq — b (archived second) sorts first.
    const archivedIds = store.archived().map((t) => t.id);
    expect(archivedIds).toEqual([b.id, a.id]);

    // unloadView and preserveSurvivingPane run once per archived id (a, b —
    // archiveToday's own return order), and the layout/broadcast fire exactly
    // once for the whole batch, not once per tab.
    expect(h.unloadView.mock.calls.map(([id]) => id)).toEqual([a.id, b.id]);
    expect(h.preserveSurvivingPane.mock.calls.map(([id]) => id)).toEqual([a.id, b.id]);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  test("is a no-op with no today tabs to archive: no unloadView, no preserveSurvivingPane, no broadcast", () => {
    const store = runtime.store;
    const pinned = store.create({ url: "https://p.test", title: "P" });
    store.pin(pinned.id);

    clearTodayTabs();

    expect(store.list().map((t) => t.id)).toEqual([pinned.id]);
    expect(store.archived()).toEqual([]);
    expect(h.unloadView).not.toHaveBeenCalled();
    expect(h.preserveSurvivingPane).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });
});

describe("showTabContextMenu", () => {
  beforeEach(() => {
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
  });

  function itemsFor(id: string): { id: string; enabled: boolean }[] {
    return showTabContextMenu(id, 0, 0).items.map(({ id: itemId, enabled }) => ({ id: itemId, enabled }));
  }

  test("Move to Bottom on the last today tab is disabled when an open favorite tab follows (three-way group)", () => {
    const store = runtime.store;
    const today = store.create({ url: "https://today.test", title: "Today" });
    const favoriteTab = store.create({ url: "https://fav.test", title: "Fav" });
    store.addFavorite(favoriteTab.id);

    // list() order is [today, favoriteTab] (list() returns pinned, then today,
    // then favorite; the group key is what matters here). The today
    // group contains ONLY `today`, so it is both first and last in its own
    // group — Move to Bottom must be disabled, not enabled because a
    // differently-grouped favorite tab happens to follow it in list() order.
    const moveToBottom = itemsFor(today.id).find((i) => i.id === "moveToBottom")!;
    expect(moveToBottom.enabled).toBe(false);
  });

  test("Move to Bottom stays enabled between two today tabs, unaffected by a trailing favorite", () => {
    const store = runtime.store;
    const first = store.create({ url: "https://a.test", title: "A" });
    store.create({ url: "https://b.test", title: "B" });
    const favoriteTab = store.create({ url: "https://fav.test", title: "Fav" });
    store.addFavorite(favoriteTab.id);

    const moveToBottom = itemsFor(first.id).find((i) => i.id === "moveToBottom")!;
    expect(moveToBottom.enabled).toBe(true);
  });
});
