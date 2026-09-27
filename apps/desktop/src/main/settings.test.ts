import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {
    webContents = {
      loadURL: () => Promise.resolve(),
      loadFile: () => Promise.resolve(),
      focus: () => {},
    };
    setBackgroundColor(_color: string) {}
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
    const closeFindSession = vi.fn();
    runtime.closeFindSession = closeFindSession;

    openSettings();

    expect(closeFindSession).toHaveBeenCalledWith(false);
    expect(runtime.settingsOpen).toBe(true);
  });

  test("is a no-op past the find-close hook when there is no window", () => {
    runtime.win = null;
    const closeFindSession = vi.fn();
    runtime.closeFindSession = closeFindSession;

    expect(() => openSettings()).not.toThrow();
    expect(closeFindSession).not.toHaveBeenCalled();
  });
});
