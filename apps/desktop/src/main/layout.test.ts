import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {
    webContents = {
      loadURL: () => Promise.resolve(),
      loadFile: () => Promise.resolve(),
      focus: () => {},
      isDestroyed: () => false,
      send: () => {},
    };
    setBackgroundColor(_color: string) {}
    setBounds(_bounds: unknown) {}
    setVisible(_visible: boolean) {}
  },
}));

vi.mock("./db.js", () => ({
  writeWindowLayout: () => {},
  readWindowLayout: () => ({ mode: "single" }),
}));

vi.mock("./broadcast.js", () => ({
  broadcast: () => {},
}));

vi.mock("./views.js", () => ({
  createViewFor: () => {},
  destroyView: () => {},
  ensureActiveView: () => {},
  raiseOverlays: () => {},
}));

const h = vi.hoisted(() => ({
  layoutOverlay: vi.fn(),
}));
vi.mock("./overlay.js", () => ({
  layoutOverlay: h.layoutOverlay,
}));

import { SpaceStore } from "@zeo/core";
import { runtime } from "./state.js";
import {
  activateTab,
  applyLayout,
  doFocusOther,
  doFocusPane,
  doSplit,
  doSplitWith,
  doSwap,
  reconcileAndApply,
} from "./layout.js";

describe("applyLayout", () => {
  const originalWin = runtime.win;
  const originalFind = runtime.find;

  const originalLayout = runtime.layout;
  const originalCloseFind = runtime.closeFindSession;
  const closeFind = vi.fn(() => {
    runtime.find = { ...runtime.find, open: false };
  });

  beforeEach(() => {
    h.layoutOverlay.mockClear();
    closeFind.mockClear();
    runtime.closeFindSession = closeFind;
    runtime.win = {
      getContentSize: () => [1000, 700],
      contentView: { addChildView: () => {} },
    } as unknown as typeof runtime.win;
  });

  afterEach(() => {
    runtime.win = originalWin;
    runtime.find = originalFind;
    runtime.layout = originalLayout;
    runtime.closeFindSession = originalCloseFind;
  });

  /** Two fresh tabs in a split focused on `focused`, with that pane's tab active. */
  function split(focused: "left" | "right"): { left: string; right: string } {
    const left = runtime.store.create({ url: "https://left.test", title: "Left" }).id;
    const right = runtime.store.create({ url: "https://right.test", title: "Right" }).id;
    runtime.store.activate(focused === "left" ? left : right);
    runtime.layout = { mode: "split", left, right, ratio: 0.5, focused };
    return { left, right };
  }

  test("re-lays out an open find overlay in single mode", () => {
    runtime.find = { ...runtime.find, open: true };

    applyLayout();

    expect(h.layoutOverlay).toHaveBeenCalledTimes(1);
  });

  test("does not touch the overlay when find is closed", () => {
    runtime.find = { ...runtime.find, open: false };

    applyLayout();

    expect(h.layoutOverlay).not.toHaveBeenCalled();
  });

  test("re-lays out an open find overlay in split mode", () => {
    const { left } = split("left");
    runtime.find = { ...runtime.find, open: true, tabId: left };

    applyLayout();

    expect(closeFind).not.toHaveBeenCalled();
    expect(h.layoutOverlay).toHaveBeenCalledTimes(1);
  });

  test("closes a split-mode find bound to a tab that is no longer active", () => {
    const { left } = split("right");
    runtime.find = { ...runtime.find, open: true, tabId: left };

    applyLayout();

    expect(closeFind).toHaveBeenCalledTimes(1);
    expect(h.layoutOverlay).not.toHaveBeenCalled();
  });

  test("doFocusPane closes find bound to the pane losing focus", () => {
    const { left } = split("left");
    runtime.find = { ...runtime.find, open: true, tabId: left };

    doFocusPane("right");

    expect(closeFind).toHaveBeenCalledTimes(1);
    expect(runtime.find.open).toBe(false);
  });

  describe("focus mode (passive vs. deliberate)", () => {
    const originalCommandBar = runtime.commandBar;
    const originalOverlay = runtime.overlay;
    const originalCloseHook = runtime.closeCommandBarHook;

    const closeCommandBarHook = vi.fn();

    /** Stub pane views for `left`/`right`, tracked in `runtime.views`. */
    function stubPaneViews(left: string, right: string): void {
      for (const id of [left, right]) {
        runtime.views.set(id, {
          webContents: {
            isDestroyed: () => false,
            focus: vi.fn(),
          },
          setBounds: () => {},
          setVisible: () => {},
        } as unknown as ReturnType<typeof runtime.views.get> & object);
      }
    }

    beforeEach(() => {
      closeCommandBarHook.mockClear();
      runtime.closeCommandBarHook = closeCommandBarHook;
      runtime.commandBar = {
        open: true,
        mode: "navigate",
        initialText: "",
        query: "",
        suggestions: [],
        selectedIndex: -1,
        revision: 0,
        surface: "bar",
      };
      runtime.overlay = {
        webContents: { isDestroyed: () => false, focus: () => {}, isFocused: () => false },
        getVisible: () => true,
      } as unknown as typeof runtime.overlay;
    });

    afterEach(() => {
      runtime.commandBar = originalCommandBar;
      runtime.overlay = originalOverlay;
      runtime.closeCommandBarHook = originalCloseHook;
      runtime.views.clear();
    });

    test("passive applyLayout() does not close the bar or move focus while it owns focus", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      applyLayout();

      expect(closeCommandBarHook).not.toHaveBeenCalled();
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).not.toHaveBeenCalled();
    });

    test("passive reconcileAndApply() does not close the bar or move focus while it owns focus", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      reconcileAndApply();

      expect(closeCommandBarHook).not.toHaveBeenCalled();
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).not.toHaveBeenCalled();
    });

    test("doFocusPane closes the bar (deliberate) then focuses the newly focused pane", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      doFocusPane("right");

      expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
      const focusedView = runtime.views.get(right)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    test("passive applyLayout() leaves focus alone while the bar is open behind a hidden overlay", () => {
      runtime.overlay = {
        webContents: { isDestroyed: () => false, focus: () => {}, isFocused: () => false },
        getVisible: () => false,
      } as unknown as typeof runtime.overlay;
      const { left, right } = split("left");
      stubPaneViews(left, right);

      applyLayout();

      expect(closeCommandBarHook).not.toHaveBeenCalled();
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).not.toHaveBeenCalled();
    });

    test("a passive applyLayout() still focuses the pane once the bar is closed", () => {
      runtime.commandBar = { ...runtime.commandBar, open: false };
      const { left, right } = split("left");
      stubPaneViews(left, right);

      applyLayout();

      expect(closeCommandBarHook).not.toHaveBeenCalled();
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    test("doSwap closes the bar (deliberate) then focuses the still-focused pane", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      doSwap();

      expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
      // Swap keeps the same tab focused (it just moves to the other pane).
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    test("doFocusOther closes the bar (deliberate) then focuses the newly focused pane", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      doFocusOther();

      expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
      const focusedView = runtime.views.get(right)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    test("activateTab of the other pane tab closes the bar (deliberate) and moves focus to it", () => {
      const { left, right } = split("left");
      stubPaneViews(left, right);

      activateTab(right);

      expect(runtime.layout).toMatchObject({ mode: "split", focused: "right" });
      expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
      const focusedView = runtime.views.get(right)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    test("doSplit closes the bar (deliberate) then focuses the newly-split active tab", () => {
      // A fresh store keeps `mostRecentOtherTabId` (used by doSplit) from
      // picking up a tab created by an earlier test in this file.
      const originalStore = runtime.store;
      runtime.store = new SpaceStore();
      try {
        const left = runtime.store.create({ url: "https://left.test", title: "Left" }).id;
        const right = runtime.store.create({ url: "https://right.test", title: "Right" }).id;
        runtime.store.activate(left);
        stubPaneViews(left, right);

        void doSplit();

        expect(runtime.layout).toMatchObject({ mode: "split", left, right, focused: "left" });
        expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
        const focusedView = runtime.views.get(left)!;
        expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
      } finally {
        runtime.store = originalStore;
      }
    });

    test("doSplitWith closes the bar (deliberate) then focuses the newly-split active tab", () => {
      const left = runtime.store.create({ url: "https://left.test", title: "Left" }).id;
      const right = runtime.store.create({ url: "https://right.test", title: "Right" }).id;
      runtime.store.activate(left);
      stubPaneViews(left, right);

      void doSplitWith(right);

      expect(runtime.layout).toMatchObject({ mode: "split", left, right, focused: "left" });
      expect(closeCommandBarHook).toHaveBeenCalledTimes(1);
      const focusedView = runtime.views.get(left)!;
      expect(focusedView.webContents.focus).toHaveBeenCalledTimes(1);
    });
  });
});
