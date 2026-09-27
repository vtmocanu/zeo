import { describe, expect, it } from "vitest";
import {
  commandBarPanelRect,
  settingsBounds,
  settingsSheetRect,
  findAnchorRect,
  findPillRect,
  findBarBounds,
  windowCardRects,
  quickBrowsePageBounds,
  splitPaneBounds,
  DIVIDER_WIDTH,
  QUICK_BROWSE_CHROME_HEIGHT,
} from "./layout.js";
import { contentRect, DEFAULT_CHROME_STATE, type ChromeState } from "./chrome.js";
import type { WindowLayout } from "./split-view.js";

const SINGLE: WindowLayout = { mode: "single" };
const SPLIT_RIGHT: WindowLayout = { mode: "split", left: "a", right: "b", ratio: 0.4, focused: "right" };
const ZERO = { x: 0, y: 0, width: 0, height: 0 };

const COLLAPSED: ChromeState = { sidebarWidth: 240, sidebarCollapsed: true, sidebarRevealed: false };

describe("commandBarPanelRect", () => {
  it("centers the input-only panel under the window at the top ratio", () => {
    expect(commandBarPanelRect(1280, 800, 0)).toEqual({ x: 300, y: 160, width: 680, height: 58 });
  });

  it("grows the height by the list padding, rows and group headings", () => {
    expect(commandBarPanelRect(1280, 800, 1, 1).height).toBe(138);
    expect(commandBarPanelRect(1280, 800, 2, 2).height).toBe(206);
  });

  it("clamps the width to the window on a narrow window", () => {
    const bounds = commandBarPanelRect(700, 800, 0);
    expect(bounds.width).toBe(652);
    expect(bounds.x).toBe(24);
  });

  it("matches the minimum window size", () => {
    expect(commandBarPanelRect(640, 400, 0)).toEqual({ x: 24, y: 80, width: 592, height: 58 });
  });

  it("returns an all-zero rect when the window is too narrow", () => {
    expect(commandBarPanelRect(48, 800, 3, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("returns an all-zero rect when the room below the top is too short for the input", () => {
    // y = round(100 * 0.2) = 20; room = 100 - 20 - 24 = 56 < 58.
    expect(commandBarPanelRect(1280, 100, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("clamps the height so the bottom edge never passes the window", () => {
    expect(commandBarPanelRect(1280, 400, 45, 1).height).toBe(296);
  });

  it("ignores groups when there are no rows, and treats negative rows as 0", () => {
    expect(commandBarPanelRect(1280, 800, 0, 3).height).toBe(58);
    expect(commandBarPanelRect(1280, 800, -2, 0)).toEqual(commandBarPanelRect(1280, 800, 0, 0));
  });
});

describe("findPillRect / findBarBounds", () => {
  it("seats the pill 8 px inside the top-right of the default card and grows the view by 16", () => {
    const anchor = findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SINGLE, null);
    expect(anchor).toEqual({ x: 240, y: 8, width: 1032, height: 784 });
    expect(findPillRect(anchor)).toEqual({ x: 904, y: 16, width: 360, height: 38 });
    expect(findBarBounds(anchor)).toEqual({ x: 888, y: 0, width: 392, height: 70 });
  });

  it("keeps the pill at the same spot when the sidebar is collapsed and not revealed", () => {
    const anchor = findAnchorRect(1280, 800, COLLAPSED, SINGLE, null);
    expect(anchor.x).toBe(8);
    expect(findPillRect(anchor)).toEqual({ x: 904, y: 16, width: 360, height: 38 });
  });

  it("clamps the pill width to the anchor minus both insets", () => {
    const anchor = { x: 0, y: 0, width: 200, height: 400 };
    expect(findPillRect(anchor).width).toBe(184);
  });

  it("returns all-zero pill and bounds when the anchor cannot seat a pill", () => {
    const anchor = { x: 0, y: 0, width: 16, height: 400 };
    expect(findPillRect(anchor)).toEqual(ZERO);
    expect(findBarBounds(anchor)).toEqual(ZERO);
  });
});

describe("findAnchorRect", () => {
  it("is contentRect in single mode", () => {
    expect(findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SINGLE, "a")).toEqual(
      contentRect(1280, 800, DEFAULT_CHROME_STATE),
    );
  });

  it("is the matching split pane when the tab is a pane", () => {
    const panes = splitPaneBounds(1280, 800, DEFAULT_CHROME_STATE, 0.4);
    expect(findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SPLIT_RIGHT, "a")).toEqual(panes.left);
    expect(findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SPLIT_RIGHT, "b")).toEqual(panes.right);
  });

  it("falls back to contentRect in split for a null or unrelated tab", () => {
    const r = contentRect(1280, 800, DEFAULT_CHROME_STATE);
    expect(findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SPLIT_RIGHT, null)).toEqual(r);
    expect(findAnchorRect(1280, 800, DEFAULT_CHROME_STATE, SPLIT_RIGHT, "z")).toEqual(r);
  });
});

describe("windowCardRects", () => {
  it("draws one unfocused single card at contentRect", () => {
    expect(windowCardRects(1280, 800, DEFAULT_CHROME_STATE, SINGLE)).toEqual([
      { pane: "single", rect: contentRect(1280, 800, DEFAULT_CHROME_STATE), focused: false },
    ]);
  });

  it("draws the two split panes with the focused one marked", () => {
    const panes = splitPaneBounds(1280, 800, DEFAULT_CHROME_STATE, 0.4);
    expect(windowCardRects(1280, 800, DEFAULT_CHROME_STATE, SPLIT_RIGHT)).toEqual([
      { pane: "left", rect: panes.left, focused: false },
      { pane: "right", rect: panes.right, focused: true },
    ]);
  });
});

describe("quickBrowsePageBounds", () => {
  it("starts the page view at y 48 in the default window", () => {
    expect(quickBrowsePageBounds(480, 640)).toEqual({ x: 0, y: 48, width: 480, height: 592 });
  });

  it("fills the width below the chrome bar for a normal window", () => {
    expect(quickBrowsePageBounds(480, 640)).toEqual({
      x: 0,
      y: QUICK_BROWSE_CHROME_HEIGHT,
      width: 480,
      height: 640 - QUICK_BROWSE_CHROME_HEIGHT,
    });
  });

  it("floors the height at 0 when the window is shorter than the chrome bar", () => {
    const bounds = quickBrowsePageBounds(480, QUICK_BROWSE_CHROME_HEIGHT - 10);
    expect(bounds).toEqual({
      x: 0,
      y: QUICK_BROWSE_CHROME_HEIGHT,
      width: 480,
      height: 0,
    });
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });
});

describe("splitPaneBounds", () => {
  it("tiles two equal panes plus the divider across the page region at ratio 0.5", () => {
    const bounds = splitPaneBounds(1280, 800, DEFAULT_CHROME_STATE, 0.5);
    expect(bounds.left.x).toBe(240);
    expect(bounds.left.y).toBe(8);
    expect(bounds.left.height).toBe(784);
    expect(bounds.divider.height).toBe(784);
    expect(bounds.right.height).toBe(784);
    expect(bounds.left.width + DIVIDER_WIDTH + bounds.right.width).toBe(1032);
    expect(bounds.divider.x).toBe(bounds.left.x + bounds.left.width);
    expect(bounds.right.x).toBe(bounds.divider.x + DIVIDER_WIDTH);
  });

  it("clamps an out-of-range ratio to the max fraction", () => {
    expect(splitPaneBounds(1280, 800, DEFAULT_CHROME_STATE, 0.9).left.width).toBe(819);
  });

  it("returns all-zero rects when the page region cannot seat the divider", () => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    expect(splitPaneBounds(256, 800, DEFAULT_CHROME_STATE, 0.5)).toEqual({
      left: zero,
      divider: zero,
      right: zero,
    });
  });

  it("gives every rect the full page-region height", () => {
    const bounds = splitPaneBounds(1280, 640, DEFAULT_CHROME_STATE, 0.5);
    const r = contentRect(1280, 640, DEFAULT_CHROME_STATE);
    expect(bounds.left.height).toBe(r.height);
    expect(bounds.divider.height).toBe(r.height);
    expect(bounds.right.height).toBe(r.height);
  });

  it("starts the left pane at the card inset when the sidebar is collapsed", () => {
    expect(splitPaneBounds(1280, 800, COLLAPSED, 0.5).left.x).toBe(8);
  });
});

describe("settingsBounds", () => {
  it("covers the whole content area", () => {
    expect(settingsBounds(1280, 800)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });
});

describe("settingsSheetRect", () => {
  it("centers the full-size sheet in a large viewport", () => {
    expect(settingsSheetRect(1280, 800)).toEqual({ x: 260, y: 150, width: 760, height: 500 });
  });

  it("keeps the 24 px margin at the minimum window size", () => {
    expect(settingsSheetRect(640, 400)).toEqual({ x: 24, y: 24, width: 592, height: 352 });
  });

  it("clamps only the dimension that does not fit", () => {
    expect(settingsSheetRect(900, 520)).toEqual({ x: 70, y: 24, width: 760, height: 472 });
  });

  it("is all-zero when a dimension collapses", () => {
    expect(settingsSheetRect(48, 800)).toEqual(ZERO);
  });
});
