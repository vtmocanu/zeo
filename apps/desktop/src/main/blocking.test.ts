import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// blocking.ts (and its transitive imports) self-register IPC via top-level
// ipcMain.handle at load and import several electron bindings used only inside
// functions. Mock electron the same way tabs.test.ts does; session.fromPartition
// returns a tagged stub so the attach call can be asserted.
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => {} },
  session: { fromPartition: (partition: string) => ({ partition }), defaultSession: {} },
  app: { getPath: () => "" },
  BrowserWindow: class {},
  WebContentsView: class {},
  nativeTheme: {},
}));

import { initialBlockingState } from "@zeo/core";
import { runtime } from "./state.js";
import { attachBlockerToProfileSession } from "./blocking.js";

describe("attachBlockerToProfileSession", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runtime.blocking = initialBlockingState(true, "none");
    runtime.blocker = null;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    runtime.blocker = null;
  });

  test("enabled + attach succeeds: attaches the persist:<id> session and logs nothing", () => {
    const attach = vi.fn();
    runtime.blocking = { ...runtime.blocking, enabled: true };
    runtime.blocker = { attach } as unknown as typeof runtime.blocker;
    attachBlockerToProfileSession("p1");
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({ partition: "persist:p1" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("enabled + attach throws: logs with the profile id and does not rethrow", () => {
    const attach = vi.fn(() => {
      throw new Error("disposed");
    });
    runtime.blocking = { ...runtime.blocking, enabled: true };
    runtime.blocker = { attach } as unknown as typeof runtime.blocker;
    expect(() => attachBlockerToProfileSession("p1")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain("p1");
  });

  test("disabled: does not attach", () => {
    const attach = vi.fn();
    runtime.blocking = { ...runtime.blocking, enabled: false };
    runtime.blocker = { attach } as unknown as typeof runtime.blocker;
    attachBlockerToProfileSession("p1");
    expect(attach).not.toHaveBeenCalled();
  });

  test("no blocker: does not throw and does not log", () => {
    runtime.blocking = { ...runtime.blocking, enabled: true };
    runtime.blocker = null;
    expect(() => attachBlockerToProfileSession("p1")).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
