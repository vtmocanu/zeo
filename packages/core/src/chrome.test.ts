import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  contentRect,
  restoreChrome,
  toggleSidebar,
  withSidebarRevealed,
  DEFAULT_CHROME_STATE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type ChromeState,
} from "./chrome.js";

describe("clampSidebarWidth", () => {
  it("clamps below the minimum", () => {
    expect(clampSidebarWidth(199)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("clamps above the maximum", () => {
    expect(clampSidebarWidth(361)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("rounds a fractional width before clamping", () => {
    expect(clampSidebarWidth(250.4)).toBe(250);
  });

  it("falls back to the default width for non-finite input", () => {
    expect(clampSidebarWidth(NaN)).toBe(240);
    expect(clampSidebarWidth(Infinity)).toBe(240);
  });
});

describe("contentRect", () => {
  it("insets the card from the sidebar's right edge in the default state", () => {
    expect(contentRect(1280, 800, DEFAULT_CHROME_STATE)).toEqual({
      x: 240,
      y: 8,
      width: 1032,
      height: 784,
    });
  });

  it("insets the card from the window edge when collapsed", () => {
    const chrome: ChromeState = { sidebarWidth: 240, sidebarCollapsed: true, sidebarRevealed: false };
    expect(contentRect(1280, 800, chrome)).toEqual({
      x: 8,
      y: 8,
      width: 1264,
      height: 784,
    });
  });

  it("pushes the card to the sidebar width when collapsed but revealed", () => {
    const chrome: ChromeState = { sidebarWidth: 300, sidebarCollapsed: true, sidebarRevealed: true };
    expect(contentRect(1280, 800, chrome)).toEqual({
      x: 300,
      y: 8,
      width: 972,
      height: 784,
    });
  });

  it("floors width and height at 0 for a too-small window", () => {
    const bounds = contentRect(100, 10, DEFAULT_CHROME_STATE);
    expect(bounds.width).toBe(0);
    expect(bounds.height).toBe(0);
  });
});

describe("withSidebarRevealed", () => {
  it("returns the same reference when the sidebar is not collapsed", () => {
    expect(withSidebarRevealed(DEFAULT_CHROME_STATE, true)).toBe(DEFAULT_CHROME_STATE);
  });

  it("returns the same reference when the flag already matches", () => {
    const chrome: ChromeState = { sidebarWidth: 240, sidebarCollapsed: true, sidebarRevealed: true };
    expect(withSidebarRevealed(chrome, true)).toBe(chrome);
  });
});

describe("toggleSidebar", () => {
  it("restores sidebarCollapsed after two toggles, with sidebarRevealed false", () => {
    const once = toggleSidebar(DEFAULT_CHROME_STATE);
    expect(once.sidebarCollapsed).toBe(true);
    expect(once.sidebarRevealed).toBe(false);
    const twice = toggleSidebar(once);
    expect(twice.sidebarCollapsed).toBe(DEFAULT_CHROME_STATE.sidebarCollapsed);
    expect(twice.sidebarRevealed).toBe(false);
  });
});

describe("restoreChrome", () => {
  it("clamps a saved width and clears sidebarRevealed", () => {
    expect(restoreChrome({ sidebarWidth: 999, sidebarCollapsed: true })).toEqual({
      sidebarWidth: 360,
      sidebarCollapsed: true,
      sidebarRevealed: false,
    });
  });

  it("returns the default state for null", () => {
    expect(restoreChrome(null)).toEqual(DEFAULT_CHROME_STATE);
  });
});
