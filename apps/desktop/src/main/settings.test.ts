import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  setBackgroundColor: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {
    webContents = {
      loadURL: () => Promise.resolve(),
      loadFile: () => Promise.resolve(),
      focus: () => {},
    };
    setBackgroundColor(color: string) {
      h.setBackgroundColor(color);
    }
    setBounds(_bounds: unknown) {}
    setVisible(_visible: boolean) {}
  },
}));

vi.mock("./db.js", () => ({
  writeSearchEngine: () => {},
  writeQuickBrowseExternal: () => {},
}));

vi.mock("./broadcast.js", () => ({
  broadcast: () => {},
}));

import { runtime } from "./state.js";
import { openSettings } from "./settings.js";

describe("openSettings", () => {
  const originalWin = runtime.win;
  const originalOverlay = runtime.overlay;
  const originalSettingsView = runtime.settingsView;
  const originalSettingsOpen = runtime.settingsOpen;
  const originalCloseFindSession = runtime.closeFindSession;

  beforeEach(() => {
    h.setBackgroundColor.mockClear();
    runtime.win = {
      contentView: { addChildView: () => {} },
      getContentSize: () => [1000, 700],
    } as unknown as typeof runtime.win;
    runtime.overlay = null;
    runtime.settingsView = null;
    runtime.settingsOpen = false;
  });

  afterEach(() => {
    runtime.win = originalWin;
    runtime.overlay = originalOverlay;
    runtime.settingsView = originalSettingsView;
    runtime.settingsOpen = originalSettingsOpen;
    runtime.closeFindSession = originalCloseFindSession;
  });

  test("closes an open find session before adding the view", () => {
    const order: string[] = [];
    const closeFindSession = vi.fn(() => {
      order.push("closeFindSession");
    });
    runtime.closeFindSession = closeFindSession;
    const addChildView = vi.fn(() => {
      order.push("addChildView");
    });
    runtime.win = {
      contentView: { addChildView },
      getContentSize: () => [1000, 700],
    } as unknown as typeof runtime.win;

    openSettings();

    expect(closeFindSession).toHaveBeenCalledWith(false);
    expect(runtime.settingsOpen).toBe(true);
    expect(order).toEqual(["closeFindSession", "addChildView"]);
  });

  test("sets a transparent background on the settings view", () => {
    runtime.closeFindSession = () => {};

    openSettings();

    expect(h.setBackgroundColor).toHaveBeenCalledWith("#00000000");
  });

  test("does nothing (not even closing find) when there is no window", () => {
    runtime.win = null;
    const closeFindSession = vi.fn();
    runtime.closeFindSession = closeFindSession;

    expect(() => openSettings()).not.toThrow();
    expect(closeFindSession).not.toHaveBeenCalled();
  });
});
