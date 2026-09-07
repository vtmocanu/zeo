import { describe, expect, test } from "vitest";
import {
  ZOOM_FACTORS,
  DEFAULT_ZOOM_FACTOR,
  zoomIn,
  zoomOut,
  formatZoomPercent,
  setHostZoom,
  clearHostZoom,
  type ZoomState,
} from "./zoom.js";

describe("zoomIn", () => {
  test("steps up one rung from an on-ladder value", () => {
    expect(zoomIn(1.0)).toBe(1.1);
    expect(zoomIn(0.25)).toBe(0.33);
  });

  test("clamps at the top rung", () => {
    expect(zoomIn(5.0)).toBe(5.0);
    expect(zoomIn(6.0)).toBe(5.0);
  });

  test("snaps up to the nearest rung above an off-ladder interior value", () => {
    expect(zoomIn(0.6)).toBe(0.67);
  });

  test("snaps up from below the bottom rung", () => {
    expect(zoomIn(0.1)).toBe(0.25);
  });
});

describe("zoomOut", () => {
  test("steps down one rung from an on-ladder value", () => {
    expect(zoomOut(1.0)).toBe(0.9);
    expect(zoomOut(5.0)).toBe(4.0);
  });

  test("clamps at the bottom rung", () => {
    expect(zoomOut(0.25)).toBe(0.25);
    expect(zoomOut(0.1)).toBe(0.25);
  });

  test("snaps down to the nearest rung below an off-ladder interior value", () => {
    expect(zoomOut(0.6)).toBe(0.5);
  });

  test("snaps down from above the top rung", () => {
    expect(zoomOut(6.0)).toBe(5.0);
  });
});

describe("formatZoomPercent", () => {
  test("renders a representative set including a non-terminating decimal", () => {
    expect(formatZoomPercent(0.33)).toBe("33%");
    expect(formatZoomPercent(0.9)).toBe("90%");
    expect(formatZoomPercent(1.0)).toBe("100%");
    expect(formatZoomPercent(1.5)).toBe("150%");
  });
});

describe("setHostZoom", () => {
  test("adds a new host entry", () => {
    const s0: ZoomState = { byHost: {} };
    const s1 = setHostZoom(s0, "a.com", 1.5);
    expect(s1.byHost).toEqual({ "a.com": 1.5 });
  });

  test("overwrites an existing host entry", () => {
    const s0: ZoomState = { byHost: { "a.com": 1.5 } };
    const s1 = setHostZoom(s0, "a.com", 2.0);
    expect(s1.byHost).toEqual({ "a.com": 2.0 });
  });

  test("with the default factor removes an existing entry", () => {
    const s0: ZoomState = { byHost: { "a.com": 1.5, "b.com": 2.0 } };
    const s1 = setHostZoom(s0, "a.com", DEFAULT_ZOOM_FACTOR);
    expect(s1.byHost).toEqual({ "b.com": 2.0 });
    expect("a.com" in s1.byHost).toBe(false);
  });

  test("with the default factor is a no-op on an absent host", () => {
    const s0: ZoomState = { byHost: { "b.com": 2.0 } };
    const s1 = setHostZoom(s0, "a.com", DEFAULT_ZOOM_FACTOR);
    expect(s1.byHost).toEqual({ "b.com": 2.0 });
  });

  test("does not mutate the input and returns a new reference", () => {
    const s0: ZoomState = { byHost: { "a.com": 1.5 } };
    const s1 = setHostZoom(s0, "b.com", 2.0);
    expect(s1).not.toBe(s0);
    expect(s1.byHost).not.toBe(s0.byHost);
    expect(s0.byHost).toEqual({ "a.com": 1.5 });
  });
});

describe("clearHostZoom", () => {
  test("removes an existing host entry", () => {
    const s0: ZoomState = { byHost: { "a.com": 1.5, "b.com": 2.0 } };
    const s1 = clearHostZoom(s0, "a.com");
    expect(s1.byHost).toEqual({ "b.com": 2.0 });
    expect("a.com" in s1.byHost).toBe(false);
  });

  test("is a no-op on an absent host, returning a new equal object", () => {
    const s0: ZoomState = { byHost: { "b.com": 2.0 } };
    const s1 = clearHostZoom(s0, "a.com");
    expect(s1).not.toBe(s0);
    expect(s1.byHost).toEqual({ "b.com": 2.0 });
  });

  test("does not mutate the input and returns a new reference", () => {
    const s0: ZoomState = { byHost: { "a.com": 1.5 } };
    const s1 = clearHostZoom(s0, "a.com");
    expect(s1).not.toBe(s0);
    expect(s1.byHost).not.toBe(s0.byHost);
    expect(s0.byHost).toEqual({ "a.com": 1.5 });
  });
});

describe("ZOOM_FACTORS", () => {
  test("is the Chromium ladder, strictly ascending", () => {
    expect(ZOOM_FACTORS).toEqual([
      0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0,
      2.5, 3.0, 4.0, 5.0,
    ]);
    for (let i = 1; i < ZOOM_FACTORS.length; i++) {
      expect(ZOOM_FACTORS[i]).toBeGreaterThan(ZOOM_FACTORS[i - 1]);
    }
  });
});
