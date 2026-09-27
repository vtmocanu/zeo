import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {
    webContents = {
      loadURL: () => Promise.resolve(),
      loadFile: () => Promise.resolve(),
      focus: () => {},
      isDestroyed: () => false,
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

import { runtime } from "./state.js";
import { applyLayout, doFocusPane } from "./layout.js";

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
});
