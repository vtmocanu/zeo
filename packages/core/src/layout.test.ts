import { describe, expect, it } from "vitest";
import {
  commandBarBounds,
  settingsBounds,
  findBarBounds,
  COMMAND_BAR_HEIGHT,
  SUGGESTION_ROW_HEIGHT,
  SIDEBAR_WIDTH,
  FIND_BAR_WIDTH,
  FIND_BAR_HEIGHT,
  FIND_BAR_INSET,
  FIND_BAR_TOP,
} from "./layout.js";

describe("commandBarBounds", () => {
  it("centers a clamped bar over the page region", () => {
    // contentWidth 1280 → pageWidth 1040, width clamped to 640,
    // x = 240 + round((1040 - 640) / 2) = 440.
    expect(commandBarBounds(1280, 800, 0)).toEqual({
      x: 440,
      y: Math.round(800 * 0.12),
      width: 640,
      height: COMMAND_BAR_HEIGHT,
    });
  });

  it("clamps the width to 640 on a very wide window", () => {
    expect(commandBarBounds(4000, 1000, 0).width).toBe(640);
  });

  it("tracks a narrow page region (pageWidth 100 → width 52)", () => {
    // contentWidth 340 → pageWidth 100, width = min(640, 100 - 48) = 52.
    const bounds = commandBarBounds(340, 900, 0);
    expect(bounds.width).toBe(52);
    expect(bounds.x).toBe(SIDEBAR_WIDTH + Math.round((100 - 52) / 2));
    expect(bounds.height).toBe(COMMAND_BAR_HEIGHT);
  });

  it("returns an all-zero rect when the page region is non-positive", () => {
    // contentWidth 200 → pageWidth -40 → width floored to 0.
    expect(commandBarBounds(200, 800, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("yields no negative dimensions when contentWidth equals the sidebar width", () => {
    const bounds = commandBarBounds(SIDEBAR_WIDTH, 800, 0);
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(bounds.width).toBeGreaterThanOrEqual(0);
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });

  it("grows the height by one row height per suggestion row", () => {
    const base = commandBarBounds(1280, 2000, 0).height;
    expect(base).toBe(COMMAND_BAR_HEIGHT);
    expect(commandBarBounds(1280, 2000, 1).height).toBe(
      COMMAND_BAR_HEIGHT + SUGGESTION_ROW_HEIGHT,
    );
    expect(commandBarBounds(1280, 2000, 5).height).toBe(
      COMMAND_BAR_HEIGHT + 5 * SUGGESTION_ROW_HEIGHT,
    );
  });

  it("clamps the height so the bottom edge never passes a short window", () => {
    // y = round(300 * 0.12) = 36; room = 300 - 36 = 264. A big row count would
    // overflow, so height is clamped to the remaining room.
    const bounds = commandBarBounds(1280, 300, 20);
    const y = Math.round(300 * 0.12);
    expect(bounds.height).toBe(300 - y);
    expect(y + bounds.height).toBe(300);
  });

  it("returns an all-zero rect when the window cannot seat the input row", () => {
    // y = round(60 * 0.12) = 7; room = 60 - 7 = 53 < COMMAND_BAR_HEIGHT (56).
    expect(commandBarBounds(1280, 60, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("findBarBounds", () => {
  it("right-aligns a full-width bar within the page region at the top inset", () => {
    // contentWidth 1280 → pageWidth 1040, width = min(360, 1040 - 24) = 360,
    // x = 240 + 1040 - 360 - 12 = 908.
    expect(findBarBounds(1280)).toEqual({
      x: 908,
      y: FIND_BAR_TOP,
      width: FIND_BAR_WIDTH,
      height: FIND_BAR_HEIGHT,
    });
  });

  it("insets the bar by FIND_BAR_INSET on the right edge of the page region", () => {
    const bounds = findBarBounds(1280);
    expect(bounds.x + bounds.width).toBe(1280 - FIND_BAR_INSET);
    expect(bounds.x).toBeGreaterThanOrEqual(SIDEBAR_WIDTH + FIND_BAR_INSET);
  });

  it("clamps the width to pageWidth - 24 in a narrow page region, inset both sides", () => {
    // contentWidth 500 → pageWidth 260, width = min(360, 260 - 24) = 236,
    // x = 240 + 260 - 236 - 12 = 252 = SIDEBAR_WIDTH + FIND_BAR_INSET.
    const bounds = findBarBounds(500);
    expect(bounds.width).toBe(260 - 2 * FIND_BAR_INSET);
    expect(bounds.x).toBe(SIDEBAR_WIDTH + FIND_BAR_INSET);
    // Inset by exactly FIND_BAR_INSET on both the left and right edges.
    expect(bounds.x - SIDEBAR_WIDTH).toBe(FIND_BAR_INSET);
    expect(bounds.x + bounds.width).toBe(500 - FIND_BAR_INSET);
    expect(bounds.y).toBe(FIND_BAR_TOP);
    expect(bounds.height).toBe(FIND_BAR_HEIGHT);
  });

  it("collapses to an all-zero rect when the page region is too narrow", () => {
    // contentWidth 260 → pageWidth 20, 20 - 24 = -4 → width floored to 0.
    expect(findBarBounds(260)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("collapses to an all-zero rect at the boundary pageWidth - 24 === 0", () => {
    // contentWidth 264 → pageWidth 24, 24 - 24 = 0 → width 0.
    expect(findBarBounds(SIDEBAR_WIDTH + 2 * FIND_BAR_INSET)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("yields no negative dimensions when contentWidth equals the sidebar width", () => {
    const bounds = findBarBounds(SIDEBAR_WIDTH);
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(bounds.width).toBeGreaterThanOrEqual(0);
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });
});

describe("settingsBounds", () => {
  it("covers the page region to the right of the sidebar", () => {
    expect(settingsBounds(1280, 800)).toEqual({
      x: SIDEBAR_WIDTH,
      y: 0,
      width: 1280 - SIDEBAR_WIDTH,
      height: 800,
    });
  });

  it("tracks a resized content area", () => {
    expect(settingsBounds(1000, 600)).toEqual({
      x: SIDEBAR_WIDTH,
      y: 0,
      width: 1000 - SIDEBAR_WIDTH,
      height: 600,
    });
  });
});
