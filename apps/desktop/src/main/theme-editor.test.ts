import { describe, expect, test, vi } from "vitest";

// Hoisted fakes so the ./command-bar.js mock below can close over a spy while
// still letting us assert call ORDER relative to the runtime.win fakes created
// per-test (vi.mock factories are hoisted above imports and may only read
// hoisted state).
const h = vi.hoisted(() => ({
  closeCommandBar: vi.fn(),
}));

vi.mock("./command-bar.js", () => ({
  closeCommandBar: h.closeCommandBar,
}));

import { IPC } from "@zeo/core";
import { runtime } from "./state.js";
import { openSpaceThemeEditor } from "./theme-editor.js";

describe("openSpaceThemeEditor", () => {
  test("closes the command bar BEFORE sending edit-theme and focusing the window", () => {
    const calls: string[] = [];
    h.closeCommandBar.mockImplementation(() => calls.push("close"));
    const send = vi.fn((..._args: unknown[]) => calls.push("send"));
    const focus = vi.fn(() => calls.push("focus"));
    runtime.win = { webContents: { send, focus } } as unknown as typeof runtime.win;

    openSpaceThemeEditor("space-1");

    expect(calls).toEqual(["close", "send", "focus"]);
    expect(send).toHaveBeenCalledWith(IPC.spaceMenuAction, {
      action: "edit-theme",
      spaceId: "space-1",
    });

    runtime.win = null;
  });

  test("is a no-op past closeCommandBar when there is no window", () => {
    h.closeCommandBar.mockClear();
    runtime.win = null;

    expect(() => openSpaceThemeEditor("space-1")).not.toThrow();
    expect(h.closeCommandBar).toHaveBeenCalledTimes(1);
  });
});
