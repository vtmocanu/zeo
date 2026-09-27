import { describe, expect, test } from "vitest";
import { nextFocusIndex } from "./dialog.js";

describe("nextFocusIndex", () => {
  test("wraps forwards and backwards between two buttons", () => {
    expect(nextFocusIndex(1, 2, false)).toBe(0);
    expect(nextFocusIndex(0, 2, true)).toBe(1);
    expect(nextFocusIndex(0, 2, false)).toBe(1);
    expect(nextFocusIndex(1, 2, true)).toBe(0);
  });

  test("enters at the first control forwards and the last backwards", () => {
    expect(nextFocusIndex(-1, 2, false)).toBe(0);
    expect(nextFocusIndex(-1, 2, true)).toBe(1);
    expect(nextFocusIndex(5, 3, false)).toBe(0);
  });

  test("has nothing to focus with no controls", () => {
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });
});
