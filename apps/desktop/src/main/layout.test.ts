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
import { applyLayout } from "./layout.js";

describe("applyLayout", () => {
  const originalWin = runtime.win;
  const originalFind = runtime.find;

  const originalLayout = runtime.layout;

  beforeEach(() => {
    h.layoutOverlay.mockClear();
    runtime.win = {
      getContentSize: () => [1000, 700],
      contentView: { addChildView: () => {} },
    } as unknown as typeof runtime.win;
  });

  afterEach(() => {
    runtime.win = originalWin;
    runtime.find = originalFind;
    runtime.layout = originalLayout;
  });

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
    const left = runtime.store.create({ url: "https://left.test", title: "Left" });
    const right = runtime.store.create({ url: "https://right.test", title: "Right" });
    runtime.layout = {
      mode: "split",
      left: left.id,
      right: right.id,
      ratio: 0.5,
      focused: "left",
    };
    runtime.find = { ...runtime.find, open: true };

    applyLayout();

    expect(h.layoutOverlay).toHaveBeenCalledTimes(1);
  });
});
