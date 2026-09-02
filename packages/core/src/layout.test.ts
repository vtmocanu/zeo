import { describe, expect, it } from "vitest";
import { commandBarBounds, COMMAND_BAR_HEIGHT, SIDEBAR_WIDTH } from "./layout.js";

describe("commandBarBounds", () => {
  it("centers a clamped bar over the page region", () => {
    // contentWidth 1280 → pageWidth 1040, width clamped to 640,
    // x = 240 + round((1040 - 640) / 2) = 440.
    expect(commandBarBounds(1280, 800)).toEqual({
      x: 440,
      y: Math.round(800 * 0.12),
      width: 640,
      height: COMMAND_BAR_HEIGHT,
    });
  });

  it("clamps the width to 640 on a very wide window", () => {
    expect(commandBarBounds(4000, 1000).width).toBe(640);
  });

  it("tracks a narrow page region (pageWidth 100 → width 52)", () => {
    // contentWidth 340 → pageWidth 100, width = min(640, 100 - 48) = 52.
    const bounds = commandBarBounds(340, 900);
    expect(bounds.width).toBe(52);
    expect(bounds.x).toBe(SIDEBAR_WIDTH + Math.round((100 - 52) / 2));
    expect(bounds.height).toBe(COMMAND_BAR_HEIGHT);
  });

  it("returns an all-zero rect when the page region is non-positive", () => {
    // contentWidth 200 → pageWidth -40 → width floored to 0.
    expect(commandBarBounds(200, 800)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("yields no negative dimensions when contentWidth equals the sidebar width", () => {
    const bounds = commandBarBounds(SIDEBAR_WIDTH, 800);
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(bounds.width).toBeGreaterThanOrEqual(0);
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });
});
