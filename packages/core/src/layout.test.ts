import { describe, expect, it } from "vitest";
import {
  commandBarPanelRect,
  settingsBounds,
  findBarBounds,
  quickBrowsePageBounds,
  splitPaneBounds,
  DIVIDER_WIDTH,
  FIND_BAR_HEIGHT,
  FIND_BAR_INSET,
  QUICK_BROWSE_CHROME_HEIGHT,
} from "./layout.js";
import { contentRect, DEFAULT_CHROME_STATE, type ChromeState } from "./chrome.js";

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

describe("findBarBounds", () => {
  it("right-aligns a full-width bar within the page region at the top inset", () => {
    expect(findBarBounds(1280, 800, DEFAULT_CHROME_STATE)).toEqual({
      x: 900,
      y: 20,
      width: 360,
      height: 44,
    });
  });

  it("insets the bar by FIND_BAR_INSET on the right edge of the page region", () => {
    const r = contentRect(1280, 800, DEFAULT_CHROME_STATE);
    const bounds = findBarBounds(1280, 800, DEFAULT_CHROME_STATE);
    expect(bounds.x + bounds.width).toBe(r.x + r.width - FIND_BAR_INSET);
  });

  it("clamps the width in a narrow page region, inset both sides", () => {
    // contentRect(500, 800, default) → x 240, width max(0, 500-240-8)=252.
    // bar width = min(360, 252-24) = 228; x = 240+252-228-12 = 252.
    const bounds = findBarBounds(500, 800, DEFAULT_CHROME_STATE);
    expect(bounds.width).toBe(228);
    expect(bounds.x).toBe(252);
    expect(bounds.x + bounds.width).toBe(480);
    expect(bounds.y).toBe(20);
    expect(bounds.height).toBe(FIND_BAR_HEIGHT);
  });

  it("collapses to an all-zero rect when the page region is too narrow", () => {
    expect(findBarBounds(260, 800, DEFAULT_CHROME_STATE)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("starts the bar at the card inset when the sidebar is collapsed", () => {
    // contentRect(1280, 800, COLLAPSED) → x 8, width 1264.
    // bar width = min(360, 1264-24) = 360; x = 8+1264-360-12 = 900.
    expect(findBarBounds(1280, 800, COLLAPSED)).toEqual({
      x: 900,
      y: 20,
      width: 360,
      height: 44,
    });
  });

  it("yields no negative dimensions when the content is too small", () => {
    const bounds = findBarBounds(100, 800, DEFAULT_CHROME_STATE);
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(bounds.width).toBeGreaterThanOrEqual(0);
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });
});

describe("quickBrowsePageBounds", () => {
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
  it("equals contentRect for the default chrome state", () => {
    expect(settingsBounds(1280, 800, DEFAULT_CHROME_STATE)).toEqual(
      contentRect(1280, 800, DEFAULT_CHROME_STATE),
    );
  });

  it("equals contentRect when the sidebar is collapsed", () => {
    expect(settingsBounds(1280, 800, COLLAPSED)).toEqual(contentRect(1280, 800, COLLAPSED));
  });

  it("equals contentRect when the sidebar is collapsed but revealed", () => {
    const revealed: ChromeState = { sidebarWidth: 300, sidebarCollapsed: true, sidebarRevealed: true };
    expect(settingsBounds(1280, 800, revealed)).toEqual(contentRect(1280, 800, revealed));
  });

  it("tracks a resized content area", () => {
    expect(settingsBounds(1000, 600, DEFAULT_CHROME_STATE)).toEqual(
      contentRect(1000, 600, DEFAULT_CHROME_STATE),
    );
  });
});
