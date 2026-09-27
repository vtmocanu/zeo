import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  WebContentsView: class {},
}));

vi.mock("./broadcast.js", () => ({
  broadcast: () => {},
  pushCommandBar: () => {},
}));

const h = vi.hoisted(() => ({
  layoutOverlay: vi.fn(() => false),
}));
vi.mock("./overlay.js", () => ({
  layoutOverlay: h.layoutOverlay,
}));

vi.mock("./command-bar.js", () => ({
  closeCommandBar: () => {},
}));

import { runtime } from "./state.js";
import { openFindSession } from "./find.js";

describe("openFindSession", () => {
  const originalSettingsOpen = runtime.settingsOpen;
  const originalFind = runtime.find;

  beforeEach(() => {
    h.layoutOverlay.mockClear();
    runtime.store.create({ url: "https://active.test", title: "Active" });
    runtime.settingsOpen = false;
    runtime.find = { ...runtime.find, open: false };
  });

  afterEach(() => {
    runtime.settingsOpen = originalSettingsOpen;
    runtime.find = originalFind;
  });

  test("no-op while settings is open", () => {
    runtime.settingsOpen = true;

    openFindSession();

    expect(runtime.find.open).toBe(false);
    expect(h.layoutOverlay).not.toHaveBeenCalled();
  });

  test("opens a session on the active tab when settings is closed", () => {
    openFindSession();

    expect(runtime.find.open).toBe(true);
  });
});
