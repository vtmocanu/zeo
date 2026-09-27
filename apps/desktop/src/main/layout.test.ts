import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {},
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

  beforeEach(() => {
    h.layoutOverlay.mockClear();
    runtime.win = {
      getContentSize: () => [1000, 700],
    } as unknown as typeof runtime.win;
  });

  afterEach(() => {
    runtime.win = originalWin;
    runtime.find = originalFind;
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
});
