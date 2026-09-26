import { describe, expect, test } from "vitest";
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  resolveWindowBounds,
  centerInWorkArea,
  fitAndCenterInWorkArea,
  type Rect,
  type WindowState,
} from "./window-state.js";

/** A saved window state, defaulting to an on-screen 1280x800 at (100, 100). */
function state(overrides: Partial<WindowState> = {}): WindowState {
  return {
    x: 100,
    y: 100,
    width: 1280,
    height: 800,
    maximized: false,
    ...overrides,
  };
}

/** The primary display's work area, a realistic 1920x1080 at the origin. */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
/** A second display to the right, larger, to exercise "largest" semantics. */
const SECONDARY: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("resolveWindowBounds", () => {
  test("null saved returns the default size, unmaximized, with no position", () => {
    const result = resolveWindowBounds(null, [PRIMARY]);
    expect(result).toEqual({
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height,
      maximized: false,
    });
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
  });

  test("empty workAreas with a non-null saved returns defaults, no position", () => {
    const result = resolveWindowBounds(state(), []);
    expect(result).toEqual({
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height,
      maximized: false,
    });
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
  });

  test("a tiny saved size clamps up to the minimum window size", () => {
    const result = resolveWindowBounds(
      state({ x: null, y: null, width: 100, height: 50 }),
      [PRIMARY],
    );
    expect(result.width).toBe(MIN_WINDOW_SIZE.width);
    expect(result.height).toBe(MIN_WINDOW_SIZE.height);
  });

  test("a huge saved size clamps down to the largest work area", () => {
    const result = resolveWindowBounds(
      state({ x: null, y: null, width: 99999, height: 99999 }),
      [PRIMARY, SECONDARY],
    );
    // The largest work area (SECONDARY) caps both dimensions.
    expect(result.width).toBe(SECONDARY.width);
    expect(result.height).toBe(SECONDARY.height);
  });

  test("a saved rect fully off every display drops the position", () => {
    const result = resolveWindowBounds(
      state({ x: -5000, y: -5000 }),
      [PRIMARY, SECONDARY],
    );
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
    // Size still clamps and passes through even without a kept position.
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
  });

  test("a rect overlapping a work area by exactly 100x100 keeps the position", () => {
    // A 300x300 window whose bottom-right 100x100 corner sits on PRIMARY: its
    // top-left is at (-200, -200), so overlap is [0..100) on both axes = 100px.
    const result = resolveWindowBounds(
      state({ x: -200, y: -200, width: 300, height: 300 }),
      [PRIMARY],
    );
    expect(result.x).toBe(-200);
    expect(result.y).toBe(-200);
  });

  test("a rect overlapping by only 99px on one axis drops the position", () => {
    // 100px overlap on y, but only 99px on x (top-left at (-201, -200)).
    const result = resolveWindowBounds(
      state({ x: -201, y: -200, width: 300, height: 300 }),
      [PRIMARY],
    );
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
  });

  test("the same work area must satisfy both axes, not two different ones", () => {
    // displayA covers a wide-x band, displayB a tall-y band, arranged so the
    // window clears MIN_VISIBLE_PX on x only against A and on y only against B —
    // no single work area clears both, so the position is dropped.
    const displayA: Rect = { x: 0, y: 0, width: 1000, height: 120 };
    const displayB: Rect = { x: 0, y: 500, width: 120, height: 1000 };
    // Window at (200, 450), 300x300:
    //  vs A: x overlap [200..500)=300 (>=100 OK), y overlap [450..120)=<0 (fail)
    //  vs B: x overlap [200..120)=<0 (fail), y overlap [500..750)=250 (>=100 OK)
    const result = resolveWindowBounds(
      state({ x: 200, y: 450, width: 300, height: 300 }),
      [displayA, displayB],
    );
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
  });

  test("a rect on the secondary display keeps its position (at least one)", () => {
    // Well inside SECONDARY, off PRIMARY entirely.
    const result = resolveWindowBounds(
      state({ x: 2100, y: 200, width: 800, height: 600 }),
      [PRIMARY, SECONDARY],
    );
    expect(result.x).toBe(2100);
    expect(result.y).toBe(200);
  });

  test("maximized true round-trips into the output", () => {
    const result = resolveWindowBounds(state({ maximized: true }), [PRIMARY]);
    expect(result.maximized).toBe(true);
  });

  test("maximized false round-trips into the output", () => {
    const result = resolveWindowBounds(state({ maximized: false }), [PRIMARY]);
    expect(result.maximized).toBe(false);
  });

  test("a null x with a non-null y still drops the position", () => {
    const result = resolveWindowBounds(state({ x: null, y: 100 }), [PRIMARY]);
    expect("x" in result).toBe(false);
    expect("y" in result).toBe(false);
  });

  test("mixed landscape + portrait displays of equal area clamp to a single work area, not a mix of both", () => {
    // PRIMARY (1920x1080) and a portrait display (1080x1920) have equal area;
    // mixing max-width with max-height would wrongly allow 1920x1920. Ties
    // break to the first work area in array order.
    const portrait: Rect = { x: 1920, y: 0, width: 1080, height: 1920 };
    const result = resolveWindowBounds(
      state({ x: null, y: null, width: 99999, height: 99999 }),
      [PRIMARY, portrait],
    );
    expect(result.width).toBe(PRIMARY.width);
    expect(result.height).toBe(PRIMARY.height);
  });

  test("a strictly larger portrait work area is chosen over a smaller landscape one", () => {
    const portrait: Rect = { x: 1920, y: 0, width: 1200, height: 1920 };
    const result = resolveWindowBounds(
      state({ x: null, y: null, width: 99999, height: 99999 }),
      [PRIMARY, portrait],
    );
    expect(result.width).toBe(portrait.width);
    expect(result.height).toBe(portrait.height);
  });
});

describe("centerInWorkArea", () => {
  test("centers exactly within an origin-anchored area with even remainders", () => {
    const area: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(centerInWorkArea(1280, 800, area)).toEqual({ x: 320, y: 140 });
  });

  test("rounds an odd remainder", () => {
    // (1921 - 1280) / 2 = 320.5 -> rounds to 321; (801 - 800) / 2 = 0.5 -> 1
    // (Math.round half-up).
    const area: Rect = { x: 0, y: 0, width: 1921, height: 801 };
    expect(centerInWorkArea(1280, 800, area)).toEqual({ x: 321, y: 1 });
  });

  test("offsets by a non-origin work area", () => {
    const area: Rect = { x: 1920, y: 0, width: 1080, height: 1920 };
    expect(centerInWorkArea(800, 600, area)).toEqual({
      x: 1920 + Math.round((1080 - 800) / 2),
      y: Math.round((1920 - 600) / 2),
    });
  });

  test("floors at the area origin when the window is larger than the area", () => {
    const area: Rect = { x: 0, y: 25, width: 1200, height: 677 };
    expect(centerInWorkArea(1280, 800, area)).toEqual({ x: 0, y: 25 });
  });
});

describe("fitAndCenterInWorkArea", () => {
  test("shrinks an oversized window to the area, then centers it", () => {
    const area: Rect = { x: 0, y: 25, width: 1200, height: 677 };
    expect(fitAndCenterInWorkArea(2560, 1440, area)).toEqual({
      x: 0,
      y: 25,
      width: 1200,
      height: 677,
    });
  });

  test("keeps a window that fits and centers it", () => {
    const area: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };
    expect(fitAndCenterInWorkArea(1280, 800, area)).toEqual({
      x: 1920 + 640,
      y: 320,
      width: 1280,
      height: 800,
    });
  });
});
