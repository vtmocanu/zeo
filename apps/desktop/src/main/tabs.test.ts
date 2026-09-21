import { beforeEach, describe, expect, test, vi } from "vitest";

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

import { SpaceStore, initialBlockingState } from "@zeo/core";
import { runtime } from "./state.js";
import type { TrackedView } from "./state.js";
import { forgetTab } from "./tabs.js";

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
    // (each caller owns its own destroyView).
    const trackedView: TrackedView = {
      view: {} as TrackedView["view"],
      spaceId: "space-1",
    };
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
