import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runtime } from "./state.js";
import {
  commandBarOwnsFocus,
  focusTabViewDeliberately,
  onOverlayBlur,
  onTabViewFocus,
} from "./command-bar-focus.js";

/** A minimal fake `WebContents` covering only what this module reads. */
function fakeWebContents(opts: { focused?: boolean; destroyed?: boolean } = {}): {
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  focus: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    isFocused: () => opts.focused ?? false,
    focus: vi.fn(),
  };
}

/** A minimal fake overlay `WebContentsView`, visible by default. */
function fakeOverlay(opts: { visible?: boolean; focused?: boolean; destroyed?: boolean } = {}): {
  webContents: ReturnType<typeof fakeWebContents>;
  getVisible: () => boolean;
} {
  return {
    webContents: fakeWebContents({ focused: opts.focused, destroyed: opts.destroyed }),
    getVisible: () => opts.visible ?? true,
  };
}

describe("command-bar-focus", () => {
  const closeCommandBar = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    closeCommandBar.mockClear();
    runtime.closeCommandBarHook = closeCommandBar;
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
    runtime.overlay = fakeOverlay() as unknown as typeof runtime.overlay;
    runtime.win = {} as unknown as typeof runtime.win;
    runtime.views.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.closeCommandBarHook = null;
    runtime.overlay = null;
    runtime.win = null;
    runtime.views.clear();
  });

  test("a steal (focus then deferred blur check) refocuses the overlay and never closes", () => {
    onTabViewFocus();
    expect(runtime.overlay!.webContents.focus).toHaveBeenCalledTimes(1);

    onOverlayBlur();
    vi.runAllTimers();

    // The steal flag carries the decision even though nothing reports focused
    // yet at the deferred check (the tab view's own focus already fired above,
    // and Electron's blur/focus ordering across WebContents is not guaranteed).
    expect(closeCommandBar).not.toHaveBeenCalled();
    expect(runtime.overlay!.webContents.focus).toHaveBeenCalledTimes(2);
  });

  test("a late steal (a tab view reports focused at the deferred check, no flag) keeps the bar open", () => {
    const view = { webContents: fakeWebContents({ focused: true }) };
    runtime.views.set("tab-1", view as unknown as Parameters<typeof runtime.views.set>[1]);

    onOverlayBlur();
    vi.runAllTimers();

    expect(closeCommandBar).not.toHaveBeenCalled();
    expect(runtime.overlay!.webContents.focus).toHaveBeenCalledTimes(1);
  });

  test("a plain blur (nothing focused, no steal) closes the bar", () => {
    onOverlayBlur();
    vi.runAllTimers();

    expect(closeCommandBar).toHaveBeenCalledTimes(1);
    expect(runtime.overlay!.webContents.focus).not.toHaveBeenCalled();
  });

  test("onTabViewFocus is a no-op when the bar is closed", () => {
    runtime.commandBar = { ...runtime.commandBar, open: false };

    onTabViewFocus();

    expect(runtime.overlay!.webContents.focus).not.toHaveBeenCalled();
  });

  test("onTabViewFocus is a no-op on the find surface", () => {
    runtime.commandBar = { ...runtime.commandBar, surface: "find" };

    onTabViewFocus();

    expect(runtime.overlay!.webContents.focus).not.toHaveBeenCalled();
  });

  test("onTabViewFocus does nothing when the overlay is hidden", () => {
    runtime.overlay = fakeOverlay({ visible: false }) as unknown as typeof runtime.overlay;

    onTabViewFocus();

    expect(runtime.overlay!.webContents.focus).not.toHaveBeenCalled();
    expect(commandBarOwnsFocus()).toBe(false);
  });

  test("focusTabViewDeliberately closes first, then focuses, when the bar owns focus", () => {
    const wc = fakeWebContents();
    const calls: string[] = [];
    closeCommandBar.mockImplementation(() => calls.push("close"));
    wc.focus.mockImplementation(() => calls.push("focus"));

    focusTabViewDeliberately(wc as unknown as Electron.WebContents);

    expect(calls).toEqual(["close", "focus"]);
  });

  test("focusTabViewDeliberately does not close when the bar is already closed", () => {
    runtime.commandBar = { ...runtime.commandBar, open: false };
    const wc = fakeWebContents();

    focusTabViewDeliberately(wc as unknown as Electron.WebContents);

    expect(closeCommandBar).not.toHaveBeenCalled();
    expect(wc.focus).toHaveBeenCalledTimes(1);
  });
});
